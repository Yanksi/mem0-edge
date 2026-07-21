import type { Env } from '../env';
import { embedText, extractMemoryGraph, type ExtractedGraph } from '../llm';
import { deleteVector, upsertEntityVectors, upsertVectors } from '../vectorize';
import { sha256Hex } from './idempotency';
import { memoryVectorMetadata } from './identity';

export interface UpdateMutationMemoryRow {
  id: string;
  userId: string | null;
  agentId: string | null;
  runId: string | null;
  actorId: string | null;
  content: string;
  metadataJson: string;
  hash: string;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  mutationVersion: number;
  lastMutationId: string | null;
}

interface MutationRow {
  mutation_id: string;
  memory_id: string;
  user_id: string;
  base_version: number;
  target_version: number;
  target_content: string;
  target_content_hash: string;
  target_metadata_json: string;
  graph_json: string | null;
  status: MutationStatus;
  lease_token: number;
}

type MutationStatus = 'queued' | 'preparing' | 'prepared' | 'd1_committed' | 'vectors_committed' | 'completed' | 'superseded' | 'failed_conflict';

interface VectorIntentRow {
  index_kind: 'memory' | 'entity';
  vector_id: string;
  values_json: string;
  metadata_json: string;
  status: 'pending' | 'applied';
}

export class MemoryMutationConflictError extends Error {
  constructor(message = 'Memory changed while the update was being prepared') {
    super(message);
    this.name = 'MemoryMutationConflictError';
  }
}

export class DurableMemoryMutationError extends Error {
  readonly retryable = true;

  constructor(readonly mutationId: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DurableMemoryMutationError';
  }
}

export async function executeContentUpdate(
  env: Env,
  current: UpdateMutationMemoryRow,
  target: { content: string; contentHash: string; metadataJson: string; updatedAt: number },
): Promise<UpdateMutationMemoryRow> {
  if (current.userId === null) throw new MemoryMutationConflictError('Memory is not user-scoped');
  const existing = await activeMutation(env, current.id);
  if (existing !== null) {
    if (existing.target_content !== target.content
      || existing.target_content_hash !== target.contentHash
      || existing.target_metadata_json !== target.metadataJson) {
      throw new MemoryMutationConflictError('Another content update is already in progress');
    }
    try {
      await processMemoryUpdateMutation(env, existing.mutation_id);
    } catch (error) {
      if (error instanceof MemoryMutationConflictError || error instanceof DurableMemoryMutationError) throw error;
      throw new DurableMemoryMutationError(existing.mutation_id, 'Memory update is queued for recovery', { cause: error });
    }
    return completedMutationResult(env, existing.mutation_id);
  }
  const mutationId = await sha256Hex(JSON.stringify({
    kind: 'memory-update-v1', memoryId: current.id, userId: current.userId,
    baseVersion: current.mutationVersion, contentHash: target.contentHash,
    content: target.content, metadataJson: target.metadataJson,
  }));

  try {
    await createOrReuseMutation(env, mutationId, current, target);
    await processMemoryUpdateMutation(env, mutationId);
  } catch (error) {
    if (error instanceof MemoryMutationConflictError) throw error;
    if (error instanceof DurableMemoryMutationError) throw error;
    throw new DurableMemoryMutationError(mutationId, 'Memory update is queued for recovery', { cause: error });
  }

  return completedMutationResult(env, mutationId);
}

async function completedMutationResult(env: Env, mutationId: string): Promise<UpdateMutationMemoryRow> {
  const mutation = await requiredMutation(env, mutationId);
  if (mutation.status === 'failed_conflict' || mutation.status === 'superseded') {
    throw new MemoryMutationConflictError('Memory update was superseded');
  }
  if (mutation.status !== 'completed') {
    throw new DurableMemoryMutationError(mutationId, 'Memory update is still being recovered');
  }
  const memory = await readMemory(env, mutation.memory_id);
  if (memory === null || memory.deletedAt !== null
    || memory.mutationVersion !== mutation.target_version
    || memory.content !== mutation.target_content
    || memory.contentHash !== mutation.target_content_hash
    || memory.metadataJson !== mutation.target_metadata_json) {
    throw new MemoryMutationConflictError('Completed mutation no longer matches the active memory');
  }
  return memory;
}

async function createOrReuseMutation(
  env: Env,
  mutationId: string,
  current: UpdateMutationMemoryRow,
  target: { content: string; contentHash: string; metadataJson: string },
): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT INTO memory_update_mutations (
        mutation_id, memory_id, user_id, base_version, target_version,
        target_content, target_content_hash, target_metadata_json, status,
        attempt_count, lease_token, publish_token, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, 0, unixepoch(), unixepoch())
      ON CONFLICT(mutation_id) DO NOTHING
    `).bind(
      mutationId, current.id, current.userId, current.mutationVersion,
      current.mutationVersion + 1, target.content, target.contentHash, target.metadataJson,
    ).run();
  } catch (error) {
    const active = await activeMutation(env, current.id);
    if (active !== null && active.mutation_id !== mutationId) {
      throw new MemoryMutationConflictError('Another content update is already in progress');
    }
    throw error;
  }
  const active = await activeMutation(env, current.id);
  if (active !== null && active.mutation_id !== mutationId) {
    throw new MemoryMutationConflictError('Another content update is already in progress');
  }
}

export async function processMemoryUpdateMutation(env: Env, mutationId: string): Promise<'processed' | 'noop'> {
  const lease = await claimMutation(env, mutationId);
  if (lease === null) return 'noop';
  let mutation = await requiredMutation(env, mutationId);
  try {
    if (mutation.status === 'queued' || mutation.status === 'preparing') {
      await prepareMutation(env, mutation);
      mutation = await requiredMutation(env, mutationId);
    }
    if (mutation.status === 'prepared') {
      await commitD1Mutation(env, mutation);
      mutation = await requiredMutation(env, mutationId);
    }
    if (mutation.status === 'd1_committed') {
      await applyVectorIntents(env, mutation);
      mutation = await requiredMutation(env, mutationId);
    }
    if (mutation.status === 'vectors_committed') await completeOrCleanMutation(env, mutation);
    return 'processed';
  } finally {
    await env.DB.prepare('UPDATE memory_update_mutations SET lease_expires_at = NULL WHERE mutation_id = ? AND lease_token = ?')
      .bind(mutationId, lease).run();
  }
}

export function isUpdateMemoryJob(value: unknown): value is { type: 'update-memory'; mutationId: string } {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as { type?: unknown; mutationId?: unknown };
  return job.type === 'update-memory' && typeof job.mutationId === 'string' && job.mutationId.length > 0;
}

export async function dispatchPendingMemoryUpdates(env: Env, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const claimed = await env.DB.prepare(`
    UPDATE memory_update_mutations
    SET publish_token = publish_token + 1, publish_attempted_at = ?
    WHERE mutation_id IN (
      SELECT mutation_id FROM memory_update_mutations
      WHERE status NOT IN ('completed', 'superseded', 'failed_conflict')
        AND (published_at IS NULL OR publish_attempted_at < ?)
      ORDER BY created_at, mutation_id LIMIT 100
    ) RETURNING mutation_id, publish_token
  `).bind(now, now - 5 * 60).all<{ mutation_id: string; publish_token: number }>();
  if (claimed.results.length === 0) return 0;
  await env.MEMORY_JOBS.sendBatch(claimed.results.map(({ mutation_id }) => ({
    body: { type: 'update-memory' as const, mutationId: mutation_id },
  })));
  await env.DB.batch(claimed.results.map(({ mutation_id, publish_token }) => env.DB.prepare(
    'UPDATE memory_update_mutations SET published_at = ? WHERE mutation_id = ? AND publish_token = ?',
  ).bind(now, mutation_id, publish_token)));
  return claimed.results.length;
}

async function claimMutation(env: Env, mutationId: string): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(`
    UPDATE memory_update_mutations
    SET lease_token = lease_token + 1, lease_expires_at = ?, updated_at = ?
    WHERE mutation_id = ? AND status NOT IN ('completed', 'superseded', 'failed_conflict')
      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    RETURNING lease_token
  `).bind(now + 5 * 60, now, mutationId, now).first<{ lease_token: number }>();
  return row?.lease_token ?? null;
}

async function prepareMutation(env: Env, mutation: MutationRow): Promise<void> {
  const base = await readMemory(env, mutation.memory_id);
  if (base === null || base.deletedAt !== null || base.userId !== mutation.user_id || base.mutationVersion !== mutation.base_version) {
    await failConflict(env, mutation.mutation_id, 'Base memory version is no longer active');
    throw new MemoryMutationConflictError();
  }
  await env.DB.prepare(`UPDATE memory_update_mutations SET status = 'preparing', attempt_count = attempt_count + 1, updated_at = unixepoch() WHERE mutation_id = ? AND status IN ('queued', 'preparing')`).bind(mutation.mutation_id).run();

  const graph = await extractMemoryGraph(env, mutation.target_content);
  const memoryValues = await embedText(env, mutation.target_content);
  const next = { ...base, content: mutation.target_content, contentHash: mutation.target_content_hash, metadataJson: mutation.target_metadata_json, mutationVersion: mutation.target_version };
  const intents: Array<{
    kind: 'memory' | 'entity'; id: string; values: number[];
    metadata: Record<string, VectorizeVectorMetadataValue>;
  }> = [{
    kind: 'memory' as const, id: base.id, values: memoryValues,
    metadata: await memoryVectorMetadata(next),
  }];
  for (const entity of await normalizedEntities(mutation.user_id, graph)) {
    intents.push({
      kind: 'entity' as const,
      id: entity.id,
      values: await embedText(env, entity.normalizedName),
      metadata: { user_id: mutation.user_id, entity: entity.normalizedName, entity_type: entity.type },
    });
  }

  const statements = intents.map(async (intent) => {
    const valuesJson = JSON.stringify(intent.values);
    const metadataJson = JSON.stringify(intent.metadata);
    const targetHash = await sha256Hex(`${valuesJson}:${metadataJson}`);
    return env.DB.prepare(`
      INSERT INTO memory_update_vector_intents
        (mutation_id, index_kind, vector_id, values_json, metadata_json, target_hash, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', unixepoch())
      ON CONFLICT(mutation_id, index_kind, vector_id) DO NOTHING
    `).bind(mutation.mutation_id, intent.kind, intent.id, valuesJson, metadataJson, targetHash);
  });
  await env.DB.batch([
    ...await Promise.all(statements),
    env.DB.prepare(`UPDATE memory_update_mutations SET graph_json = ?, status = 'prepared', error_message = NULL, updated_at = unixepoch() WHERE mutation_id = ? AND status = 'preparing'`)
      .bind(JSON.stringify(graph), mutation.mutation_id),
  ]);
}

async function commitD1Mutation(env: Env, mutation: MutationRow): Promise<void> {
  const graph = parseGraph(mutation.graph_json);
  const entities = await normalizedEntities(mutation.user_id, graph);
  const byName = new Map(entities.map((entity) => [entity.normalizedName, entity]));
  const guard = `EXISTS (SELECT 1 FROM memories WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND mutation_version = ? AND last_mutation_id = ?)`;
  const guardBindings = [mutation.memory_id, mutation.user_id, mutation.target_version, mutation.mutation_id] as const;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE memories SET content = ?, content_hash = ?, metadata_json = ?, updated_at = unixepoch(), mutation_version = ?, last_mutation_id = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND mutation_version = ?`)
      .bind(mutation.target_content, mutation.target_content_hash, mutation.target_metadata_json, mutation.target_version, mutation.mutation_id, mutation.memory_id, mutation.user_id, mutation.base_version),
  ];
  for (const entity of entities) {
    statements.push(env.DB.prepare(`INSERT INTO entities (id, user_id, name, type, metadata_json, created_at, updated_at) SELECT ?, ?, ?, ?, ?, unixepoch(), unixepoch() WHERE ${guard} ON CONFLICT(id) DO NOTHING`)
      .bind(entity.id, mutation.user_id, entity.name, entity.type, entity.metadataJson, ...guardBindings));
  }
  statements.push(
    env.DB.prepare(`DELETE FROM relationships WHERE evidence_memory_id = ? AND ${guard}`).bind(mutation.memory_id, ...guardBindings),
    env.DB.prepare(`DELETE FROM memory_entity_links WHERE memory_id = ? AND ${guard}`).bind(mutation.memory_id, ...guardBindings),
  );
  for (const entity of entities) {
    statements.push(env.DB.prepare(`INSERT INTO memory_entity_links (memory_id, entity_id, created_at) SELECT ?, ?, unixepoch() WHERE ${guard} ON CONFLICT(memory_id, entity_id) DO NOTHING`)
      .bind(mutation.memory_id, entity.id, ...guardBindings));
  }
  for (const relationship of graph.relationships) {
    const relationType = relationship.relation_type.trim();
    const source = byName.get(normalizeName(relationship.source));
    const target = byName.get(normalizeName(relationship.target));
    if (!relationType || source === undefined || target === undefined) continue;
    const id = await sha256Hex(`relationship:${mutation.user_id}:${mutation.memory_id}:${source.id}:${target.id}:${relationType}`);
    statements.push(env.DB.prepare(`INSERT INTO relationships (id, user_id, source_entity_id, target_entity_id, relation_type, confidence, evidence_memory_id, metadata_json, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, '{}', unixepoch(), unixepoch() WHERE ${guard} ON CONFLICT(id) DO NOTHING`)
      .bind(id, mutation.user_id, source.id, target.id, relationType, relationship.confidence ?? 0.5, mutation.memory_id, ...guardBindings));
  }
  const historyId = await sha256Hex(`memory-history:${mutation.memory_id}:updated:${mutation.mutation_id}`);
  statements.push(
    env.DB.prepare(`INSERT INTO memory_history (id, memory_id, operation, content, metadata_json, hash, created_at) SELECT ?, id, 'updated', content, metadata_json, hash, unixepoch() FROM memories WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND mutation_version = ? AND last_mutation_id = ? ON CONFLICT(id) DO NOTHING`)
      .bind(historyId, ...guardBindings),
    env.DB.prepare(`UPDATE memory_update_mutations SET status = 'd1_committed', updated_at = unixepoch() WHERE mutation_id = ? AND status = 'prepared' AND ${guard}`)
      .bind(mutation.mutation_id, ...guardBindings),
  );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (isActiveContentUniqueConstraintError(error)) {
      await failConflict(env, mutation.mutation_id, 'Target content conflicts with another active memory');
    }
    throw error;
  }
  const updated = await requiredMutation(env, mutation.mutation_id);
  if (updated.status !== 'd1_committed') {
    await failConflict(env, mutation.mutation_id, 'Memory version changed before D1 commit');
    throw new MemoryMutationConflictError();
  }
}

async function applyVectorIntents(env: Env, mutation: MutationRow): Promise<void> {
  const rows = await env.DB.prepare(`SELECT index_kind, vector_id, values_json, metadata_json, status FROM memory_update_vector_intents WHERE mutation_id = ? ORDER BY index_kind, vector_id`)
    .bind(mutation.mutation_id).all<VectorIntentRow>();
  for (const intent of rows.results) {
    if (intent.status === 'applied') continue;
    const vector = { id: intent.vector_id, values: parseNumbers(intent.values_json), metadata: parseMetadata(intent.metadata_json) };
    if (intent.index_kind === 'memory') await upsertVectors(env.VECTORIZE, [vector]);
    else {
      const userId = vector.metadata.user_id;
      if (typeof userId !== 'string') throw new Error('Persisted entity vector is missing its owner');
      await upsertEntityVectors(env.ENTITY_VECTORIZE, [{
        id: vector.id, values: vector.values, metadata: { ...vector.metadata, user_id: userId },
      }]);
    }
    await env.DB.prepare(`UPDATE memory_update_vector_intents SET status = 'applied', updated_at = unixepoch() WHERE mutation_id = ? AND index_kind = ? AND vector_id = ?`)
      .bind(mutation.mutation_id, intent.index_kind, intent.vector_id).run();
  }
  await env.DB.prepare(`UPDATE memory_update_mutations SET status = 'vectors_committed', updated_at = unixepoch() WHERE mutation_id = ? AND status = 'd1_committed' AND NOT EXISTS (SELECT 1 FROM memory_update_vector_intents WHERE mutation_id = ? AND status != 'applied')`)
    .bind(mutation.mutation_id, mutation.mutation_id).run();
}

async function completeOrCleanMutation(env: Env, mutation: MutationRow): Promise<void> {
  const memory = await readMemory(env, mutation.memory_id);
  if (memory !== null && memory.deletedAt === null && memory.mutationVersion === mutation.target_version) {
    await env.DB.prepare(`UPDATE memory_update_mutations SET status = 'completed', completed_at = unixepoch(), updated_at = unixepoch() WHERE mutation_id = ? AND status = 'vectors_committed'`).bind(mutation.mutation_id).run();
    return;
  }
  await deleteVector(env.VECTORIZE, mutation.memory_id);
  await env.DB.prepare(`UPDATE memory_update_mutations SET status = 'superseded', completed_at = unixepoch(), updated_at = unixepoch() WHERE mutation_id = ? AND status = 'vectors_committed'`).bind(mutation.mutation_id).run();
}

async function normalizedEntities(userId: string, graph: ExtractedGraph): Promise<Array<{ id: string; name: string; normalizedName: string; type: string; metadataJson: string }>> {
  const unique = new Map<string, { name: string; type: string; metadataJson: string }>();
  const explicitNames = new Set<string>();
  for (const item of graph.entities) {
    const normalizedName = normalizeName(item.name);
    if (!normalizedName) continue;
    explicitNames.add(normalizedName);
    const type = typeof item.type === 'string' ? item.type.trim().toLowerCase() || 'entity' : 'entity';
    const summary = typeof item.summary === 'string' ? item.summary : undefined;
    const key = `${normalizedName}:${type}`;
    if (!unique.has(key)) unique.set(key, { name: item.name.trim(), type, metadataJson: summary === undefined ? '{}' : JSON.stringify({ summary }) });
  }
  for (const item of graph.relationships.flatMap((r) => [{ name: r.source }, { name: r.target }])) {
    const normalizedName = normalizeName(item.name);
    if (!normalizedName || explicitNames.has(normalizedName)) continue;
    const key = `${normalizedName}:entity`;
    if (!unique.has(key)) unique.set(key, { name: item.name.trim(), type: 'entity', metadataJson: '{}' });
  }
  return Promise.all(Array.from(unique.entries()).map(async ([key, value]) => {
    const normalizedName = key.slice(0, key.lastIndexOf(':'));
    return { ...value, normalizedName, id: await sha256Hex(`entity:${userId}:${normalizedName}:${value.type}`) };
  }));
}

function normalizeName(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, ' '); }

function parseGraph(value: string | null): ExtractedGraph {
  if (value === null) throw new Error('Prepared update is missing its graph');
  const parsed = JSON.parse(value) as ExtractedGraph;
  if (!Array.isArray(parsed.entities) || !Array.isArray(parsed.relationships)) throw new Error('Prepared update graph is invalid');
  return parsed;
}

function parseNumbers(value: string): number[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'number')) throw new Error('Persisted update vector is invalid');
  return parsed;
}

function parseMetadata(value: string): Record<string, VectorizeVectorMetadataValue> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Persisted update vector metadata is invalid');
  return parsed as Record<string, VectorizeVectorMetadataValue>;
}

async function activeMutation(env: Env, memoryId: string): Promise<MutationRow | null> {
  return env.DB.prepare(`SELECT * FROM memory_update_mutations WHERE memory_id = ? AND status NOT IN ('completed', 'superseded', 'failed_conflict')`).bind(memoryId).first<MutationRow>();
}

async function readMutation(env: Env, mutationId: string): Promise<MutationRow | null> {
  return env.DB.prepare('SELECT * FROM memory_update_mutations WHERE mutation_id = ?').bind(mutationId).first<MutationRow>();
}

async function requiredMutation(env: Env, mutationId: string): Promise<MutationRow> {
  const row = await readMutation(env, mutationId);
  if (row === null) throw new Error('Memory update mutation disappeared');
  return row;
}

async function readMemory(env: Env, id: string): Promise<UpdateMutationMemoryRow | null> {
  const row = await env.DB.prepare(`SELECT id, user_id AS userId, agent_id AS agentId, run_id AS runId, actor_id AS actorId, content, metadata_json AS metadataJson, hash, content_hash AS contentHash, created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt, mutation_version AS mutationVersion, last_mutation_id AS lastMutationId FROM memories WHERE id = ?`).bind(id).first<UpdateMutationMemoryRow>();
  return row;
}

async function failConflict(env: Env, mutationId: string, message: string): Promise<void> {
  await env.DB.prepare(`UPDATE memory_update_mutations SET status = 'failed_conflict', error_message = ?, completed_at = unixepoch(), updated_at = unixepoch() WHERE mutation_id = ? AND status NOT IN ('completed', 'superseded', 'failed_conflict')`).bind(message, mutationId).run();
}

function isTerminal(status: MutationStatus): boolean { return status === 'completed' || status === 'superseded' || status === 'failed_conflict'; }

function isActiveContentUniqueConstraintError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === 'string'
      && /unique constraint failed/i.test(candidate.message)
      && /memories/i.test(candidate.message)
      && /content_hash/i.test(candidate.message)) return true;
    current = candidate.cause;
  }
  return false;
}
