import type { Env, Mem0ImportJob, ReclassifyMem0AgentJob } from '../env';
import { embedText } from '../llm';
import { findActiveExactMemory, prepareMemoryWrite } from '../memory/deduplication';
import { contentHash, memoryVectorMetadata, type MemoryOwnerScope } from '../memory/identity';
import { sha256Hex } from '../memory/idempotency';
import { deleteVector, upsertVectors } from '../vectorize';
import {
  RawMemoryMigrationExport,
  RawMemoryMigrationItem,
  type RawMemoryMigrationExport as RawMemoryMigrationExportType,
  type DashboardEntityScope,
} from './types';

export { RawMemoryMigrationExport } from './types';

export type ProcessMem0ImportResult = 'processed' | 'noop' | 'inflight';

export class TransientMem0ImportError extends Error {
  readonly retryable = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransientMem0ImportError';
  }
}

export class TerminalMem0ImportConflictError extends Error {
  constructor(detail: string) {
    super(`${TERMINAL_IMPORT_CONFLICT_PREFIX} ${detail}`);
    this.name = 'TerminalMem0ImportConflictError';
  }
}

interface ImportRequestRow {
  request_id: string;
  entity_type: 'user' | 'agent';
  entity_id: string;
  item_json: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  attempt_count: number;
  lease_token: number;
  cleanup_vector_id: string | null;
  cleanup_vector_generation: number;
  error_message: string | null;
}

interface ImportVectorCleanupIntent {
  vectorId: string;
  generation: number;
}

interface ImportMemoryRow {
  id: string;
  user_id: string | null;
  agent_id: string | null;
  content: string;
  content_hash: string | null;
  created_at: number;
  deleted_at: number | null;
}

interface ReclassificationMemoryRow {
  id: string;
  userId: string | null;
  agentId: string | null;
  runId: string | null;
  actorId: string | null;
  content: string;
  metadataJson: string;
  hash: string;
  contentHash: string | null;
  createdAt: number;
  deletedAt: number | null;
}

const TERMINAL_IMPORT_CONFLICT_PREFIX = 'Terminal Mem0 import conflict:';
const IMPORT_PROCESSING_LEASE_SECONDS = 5 * 60;
const IMPORT_DISPATCH_LEASE_SECONDS = 5 * 60;
const IMPORT_DISPATCH_BATCH_SIZE = 100;
const IMPORT_LEDGER_COLUMNS = 'request_id, entity_type, entity_id, item_json, status, attempt_count, lease_token, cleanup_vector_id, cleanup_vector_generation, error_message';
const RECLASSIFICATION_MAX_ATTEMPTS = 4;
const ACTIVE_MEMORY_GUARD = `
  EXISTS (
    SELECT 1 FROM memories AS guarded
    WHERE guarded.id = ?
      AND guarded.user_id IS ?
      AND guarded.agent_id IS ?
      AND guarded.content = ?
      AND guarded.hash = ?
      AND guarded.content_hash IS ?
      AND guarded.created_at = ?
      AND guarded.deleted_at IS NULL
  )
`;
const DELETED_MEMORY_GUARD = `
  EXISTS (
    SELECT 1 FROM memories AS guarded
    WHERE guarded.id = ?
      AND guarded.user_id IS ?
      AND guarded.agent_id IS ?
      AND guarded.content = ?
      AND guarded.hash = ?
      AND guarded.content_hash IS ?
      AND guarded.created_at = ?
      AND guarded.deleted_at IS NOT NULL
  )
`;

export function isMem0ImportJob(value: unknown): value is Mem0ImportJob {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Partial<Mem0ImportJob>;
  return job.type === 'import-mem0-memory'
    && typeof job.requestId === 'string'
    && job.requestId.trim().length > 0;
}

export function isReclassifyMem0AgentJob(value: unknown): value is ReclassifyMem0AgentJob {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Partial<ReclassifyMem0AgentJob>;
  return job.type === 'reclassify-mem0-agent'
    && typeof job.id === 'string' && job.id.length > 0
    && typeof job.sourceUserId === 'string' && job.sourceUserId.trim().length > 0
    && typeof job.agentId === 'string' && job.agentId.trim().length > 0
    && typeof job.content === 'string'
    && typeof job.metadataJson === 'string';
}

export async function enqueueMem0Import(
  env: Env,
  scope: DashboardEntityScope,
  exportPayload: RawMemoryMigrationExportType,
): Promise<number> {
  const selectedItems = selectUniqueImportItems(exportPayload.memories);
  const selectedExport = { memories: selectedItems };
  const exportId = await sha256Hex(JSON.stringify({ entity_type: scope.entityType, entity_id: scope.entityId, export: selectedExport }));
  const jobs = await Promise.all(selectedItems.map(async (item, index) => {
    const requestId = await sha256Hex(`${scope.entityType}:${scope.entityId}:${exportId}:${index}`);
    return { requestId, item: RawMemoryMigrationItem.parse(item) };
  }));

  for (const chunk of chunks(jobs, 100)) {
    await env.DB.batch(chunk.map(({ requestId, item }) => env.DB.prepare(`
      INSERT INTO mem0_import_requests (
        request_id, entity_type, entity_id, item_json, status,
        attempt_count, lease_token, publish_token, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', 0, 0, 0, unixepoch(), unixepoch())
      ON CONFLICT(request_id) DO NOTHING
    `).bind(requestId, scope.entityType, scope.entityId, JSON.stringify(item))));
  }

  let dispatched: number;
  do {
    dispatched = await dispatchPendingMem0Imports(env);
  } while (dispatched === IMPORT_DISPATCH_BATCH_SIZE);

  return selectedItems.length;
}

export async function dispatchPendingMem0Imports(
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<number> {
  const staleBefore = now - IMPORT_DISPATCH_LEASE_SECONDS;
  const claimed = await env.DB.prepare(`
    UPDATE mem0_import_requests
    SET publish_token = publish_token + 1, publish_attempted_at = ?
    WHERE request_id IN (
      SELECT request_id
      FROM mem0_import_requests
      WHERE status = 'queued' AND published_at IS NULL
        AND (publish_attempted_at IS NULL OR publish_attempted_at < ?)
      ORDER BY created_at, request_id
      LIMIT ${IMPORT_DISPATCH_BATCH_SIZE}
    )
    RETURNING request_id, publish_token
  `).bind(now, staleBefore).all<{ request_id: string; publish_token: number }>();
  if (claimed.results.length === 0) return 0;

  await env.MEMORY_JOBS.sendBatch(claimed.results.map(({ request_id: requestId }) => ({
    body: { type: 'import-mem0-memory' as const, requestId },
  })));

  await env.DB.batch(claimed.results.map(({ request_id: requestId, publish_token: publishToken }) => env.DB.prepare(`
    UPDATE mem0_import_requests
    SET published_at = ?
    WHERE request_id = ? AND status = 'queued' AND published_at IS NULL AND publish_token = ?
  `).bind(now, requestId, publishToken)));
  return claimed.results.length;
}

export async function processMem0ImportJob(env: Env, job: Mem0ImportJob): Promise<ProcessMem0ImportResult> {
  await ensureLegacyImportRequest(env, job);
  const claim = await claimImportRequest(env, job.requestId);
  if (claim === undefined) return importRequestDisposition(env, job.requestId);

  const item = parsePersistedImportItem(claim.item_json);
  if (item === undefined) {
    const error = new Error('Invalid persisted Mem0 import item');
    await failImportRequest(env, claim.request_id, claim.lease_token, error);
    throw error;
  }
  const now = Math.floor(Date.now() / 1000);
  const sourceCreatedAt = item.created_at ?? null;
  const sourceUpdatedAt = item.updated_at ?? null;
  const createdAt = sourceUnixTimestamp(sourceCreatedAt) ?? sourceUnixTimestamp(sourceUpdatedAt) ?? now;
  const updatedAt = sourceUnixTimestamp(sourceUpdatedAt) ?? createdAt;
  const metadata = {
    source: 'mem0-import',
    source_created_at: sourceCreatedAt,
    source_updated_at: sourceUpdatedAt,
  };
  const metadataJson = JSON.stringify(metadata);
  const scope = claim.entity_type === 'user'
    ? { userId: claim.entity_id, agentId: null }
    : { userId: null, agentId: claim.entity_id };
  const expectedContentHash = await contentHash(item.memory);

  try {
    const existingDeterministicRow = await findImportMemoryById(env, claim.request_id);
    if (existingDeterministicRow !== null) {
      return await resolveDeterministicImportRow(
        env,
        claim,
        existingDeterministicRow,
        scope,
        item,
        expectedContentHash,
        metadataJson,
        now,
      );
    }

    const cleanedPendingVectorId = await cleanupPendingImportVector(env, claim);
    const prepared = await prepareImportMemoryWrite(env, scope, item.memory);
    if (prepared.duplicate !== undefined) {
      const concurrentDeterministicRow = await findImportMemoryById(env, claim.request_id);
      if (concurrentDeterministicRow !== null) {
        return await resolveDeterministicImportRow(
          env,
          claim,
          concurrentDeterministicRow,
          scope,
          item,
          expectedContentHash,
          metadataJson,
          now,
        );
      }
      if (prepared.duplicate.id === claim.request_id) {
        throw new TransientMem0ImportError('Mem0 import deterministic row disappeared during preparation');
      }
      if (claim.attempt_count > 1 && cleanedPendingVectorId !== claim.request_id) {
        await cleanupUnmarkedImportVector(env, claim, claim.request_id);
      }
      return await completeDuplicateImportLease(env, claim, now);
    }

    const row = {
      userId: scope.userId,
      agentId: scope.agentId,
      runId: null,
      actorId: null,
      metadataJson,
    };
    const embedding = prepared.embedding ?? await embedText(env, item.memory);
    const preUpsertDeterministicRow = await findImportMemoryById(env, claim.request_id);
    if (preUpsertDeterministicRow !== null) {
      return await resolveDeterministicImportRow(
        env,
        claim,
        preUpsertDeterministicRow,
        scope,
        item,
        expectedContentHash,
        metadataJson,
        now,
      );
    }
    const vectorIntent = await armImportVectorCleanup(env, claim, claim.request_id);
    await upsertVectors(env.VECTORIZE, [{ id: claim.request_id, values: embedding, metadata: await memoryVectorMetadata(row) }]);
    if (!await hasActiveImportVectorIntent(env, claim, vectorIntent)) {
      await reconcileLostImportVector(env, claim, vectorIntent);
      return 'inflight';
    }

    const inserted = await env.DB.prepare(`
      INSERT INTO memories (
        id, user_id, agent_id, run_id, actor_id, content, metadata_json,
        hash, content_hash, created_at, updated_at, deleted_at
      )
      SELECT ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL
      FROM mem0_import_requests
      WHERE request_id = ? AND status = 'processing' AND lease_token = ?
      ON CONFLICT DO NOTHING
    `).bind(
      claim.request_id,
      scope.userId,
      scope.agentId,
      item.memory,
      metadataJson,
      claim.request_id,
      prepared.contentHash,
      createdAt,
      updatedAt,
      claim.request_id,
      claim.lease_token,
    ).run();
    if (Number(inserted.meta.changes ?? 0) === 1) {
      await clearImportCleanupForCanonical(env, claim);
      return await completeDeterministicImportLease(env, claim, item, metadataJson, createdAt, now);
    }
    if (!await hasActiveImportVectorIntent(env, claim, vectorIntent)) {
      await reconcileLostImportVector(env, claim, vectorIntent);
      return 'inflight';
    }

    const own = await findImportMemoryById(env, claim.request_id);
    if (own !== null) {
      return await resolveDeterministicImportRow(
        env,
        claim,
        own,
        scope,
        item,
        expectedContentHash,
        metadataJson,
        now,
      );
    }

    const winner = await findActiveExactMemory(
      env,
      scope,
      item.memory,
      prepared.contentHash,
      claim.request_id,
    );
    if (winner === undefined) {
      throw new TransientMem0ImportError('Mem0 import insert conflict has no active exact winner');
    }

    await cleanupImportVector(env, claim, vectorIntent);
    return await completeDuplicateImportLease(env, claim, now);
  } catch (error) {
    await failImportRequest(env, claim.request_id, claim.lease_token, error);
    throw error;
  }
}

async function cleanupPendingImportVector(env: Env, claim: ImportRequestRow): Promise<string | undefined> {
  if (claim.cleanup_vector_id === null) return undefined;
  await cleanupImportVector(env, claim, {
    vectorId: claim.cleanup_vector_id,
    generation: claim.cleanup_vector_generation,
  });
  return claim.cleanup_vector_id;
}

async function cleanupUnmarkedImportVector(
  env: Env,
  claim: ImportRequestRow,
  vectorId: string,
): Promise<void> {
  const intent = await armImportVectorCleanup(env, claim, vectorId);
  await cleanupImportVector(env, claim, intent);
}

async function cleanupCurrentImportVector(env: Env, claim: ImportRequestRow): Promise<void> {
  const intent = await findActiveImportCleanupIntent(env, claim)
    ?? await armImportVectorCleanup(env, claim, claim.request_id);
  await cleanupImportVector(env, claim, intent);
}

async function armImportVectorCleanup(
  env: Env,
  claim: ImportRequestRow,
  vectorId: string,
): Promise<ImportVectorCleanupIntent> {
  const armed = await env.DB.prepare(`
    UPDATE mem0_import_requests
    SET cleanup_vector_id = ?, cleanup_vector_generation = cleanup_vector_generation + 1,
        updated_at = unixepoch()
    WHERE request_id = ? AND status = 'processing' AND lease_token = ?
      AND cleanup_vector_id IS NULL
    RETURNING cleanup_vector_generation
  `).bind(vectorId, claim.request_id, claim.lease_token)
    .first<{ cleanup_vector_generation: number }>();
  if (armed === null) {
    throw new TransientMem0ImportError('Mem0 import cleanup became pending before vector mutation');
  }
  return { vectorId, generation: armed.cleanup_vector_generation };
}

async function cleanupImportVector(
  env: Env,
  claim: ImportRequestRow,
  intent: ImportVectorCleanupIntent,
): Promise<void> {
  if (!await hasActiveDeletableImportIntent(env, claim, intent)) {
    const occupied = await findImportMemoryById(env, intent.vectorId);
    if (occupied?.deleted_at === null) {
      await clearImportCleanupForCanonical(env, claim);
      return;
    }
    throw new TransientMem0ImportError(
      'Mem0 import cleanup lease or generation was replaced before vector deletion',
    );
  }

  await deleteVector(env.VECTORIZE, intent.vectorId);
  await clearImportCleanupIntent(env, claim, intent);
}

async function hasActiveDeletableImportIntent(
  env: Env,
  claim: ImportRequestRow,
  intent: ImportVectorCleanupIntent,
): Promise<boolean> {
  const active = await env.DB.prepare(`
    SELECT request_id
    FROM mem0_import_requests
    WHERE request_id = ? AND status = 'processing' AND lease_token = ?
      AND cleanup_vector_id = ? AND cleanup_vector_generation = ?
      AND NOT EXISTS (
        SELECT 1 FROM memories WHERE id = ? AND deleted_at IS NULL
      )
  `).bind(
    claim.request_id,
    claim.lease_token,
    intent.vectorId,
    intent.generation,
    intent.vectorId,
  ).first<{ request_id: string }>();
  return active !== null;
}

async function clearImportCleanupIntent(
  env: Env,
  claim: ImportRequestRow,
  intent: ImportVectorCleanupIntent,
): Promise<boolean> {
  const result = await env.DB.prepare(`
    UPDATE mem0_import_requests
    SET cleanup_vector_id = NULL, updated_at = unixepoch()
    WHERE request_id = ? AND status = 'processing' AND lease_token = ?
      AND cleanup_vector_id = ? AND cleanup_vector_generation = ?
  `).bind(
    claim.request_id,
    claim.lease_token,
    intent.vectorId,
    intent.generation,
  ).run();
  return Number(result.meta.changes ?? 0) === 1;
}

async function clearImportCleanupForCanonical(env: Env, claim: ImportRequestRow): Promise<void> {
  const result = await env.DB.prepare(`
    UPDATE mem0_import_requests
    SET cleanup_vector_id = NULL, updated_at = unixepoch()
    WHERE request_id = ? AND status = 'processing' AND lease_token = ?
      AND EXISTS (SELECT 1 FROM memories WHERE id = ? AND deleted_at IS NULL)
  `).bind(claim.request_id, claim.lease_token, claim.request_id).run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new Error('Mem0 import lease was replaced while preserving its canonical vector');
  }
}

async function findActiveImportCleanupIntent(
  env: Env,
  claim: ImportRequestRow,
): Promise<ImportVectorCleanupIntent | undefined> {
  const pending = await env.DB.prepare(`
    SELECT cleanup_vector_id, cleanup_vector_generation
    FROM mem0_import_requests
    WHERE request_id = ? AND status = 'processing' AND lease_token = ?
      AND cleanup_vector_id IS NOT NULL
  `).bind(claim.request_id, claim.lease_token).first<{
    cleanup_vector_id: string;
    cleanup_vector_generation: number;
  }>();
  return pending === null ? undefined : {
    vectorId: pending.cleanup_vector_id,
    generation: pending.cleanup_vector_generation,
  };
}

async function hasActiveImportVectorIntent(
  env: Env,
  claim: ImportRequestRow,
  intent: ImportVectorCleanupIntent,
): Promise<boolean> {
  const active = await env.DB.prepare(`
    SELECT request_id
    FROM mem0_import_requests
    WHERE request_id = ? AND status = 'processing' AND lease_token = ?
      AND cleanup_vector_id = ? AND cleanup_vector_generation = ?
  `).bind(
    claim.request_id,
    claim.lease_token,
    intent.vectorId,
    intent.generation,
  ).first<{ request_id: string }>();
  return active !== null;
}

async function findImportMemoryById(env: Env, id: string): Promise<ImportMemoryRow | null> {
  return env.DB.prepare(`
    SELECT id, user_id, agent_id, content, content_hash, created_at, deleted_at
    FROM memories
    WHERE id = ?
  `).bind(id).first<ImportMemoryRow>();
}

async function resolveDeterministicImportRow(
  env: Env,
  claim: ImportRequestRow,
  row: ImportMemoryRow,
  scope: MemoryOwnerScope,
  item: RawMemoryMigrationItem,
  expectedContentHash: string,
  metadataJson: string,
  now: number,
): Promise<ProcessMem0ImportResult> {
  if (row.deleted_at !== null) {
    await cleanupCurrentImportVector(env, claim);
    throw new TerminalMem0ImportConflictError('deterministic memory ID is occupied by a soft-deleted row');
  }

  const conflict = deterministicImportRowConflict(row, scope, item.memory, expectedContentHash);
  await clearImportCleanupForCanonical(env, claim);
  if (conflict !== undefined) throw new TerminalMem0ImportConflictError(conflict);

  return completeDeterministicImportLease(
    env,
    claim,
    item,
    metadataJson,
    row.created_at,
    now,
  );
}

function deterministicImportRowConflict(
  row: ImportMemoryRow,
  scope: MemoryOwnerScope,
  content: string,
  expectedContentHash: string,
): string | undefined {
  if (row.user_id !== scope.userId || row.agent_id !== scope.agentId) {
    return 'deterministic memory ID is occupied by a row with different ownership';
  }
  if (row.content !== content) {
    return 'deterministic memory ID is occupied by a row with different content';
  }
  if (row.content_hash !== expectedContentHash) {
    return 'deterministic memory ID is occupied by a row with a different content hash';
  }
  return undefined;
}

async function prepareImportMemoryWrite(
  env: Env,
  scope: MemoryOwnerScope,
  content: string,
) {
  try {
    return await prepareMemoryWrite(env, scope, content);
  } catch (error) {
    throw new TransientMem0ImportError(
      `Mem0 import preparation failed: ${safeImportErrorDetail(env, error)}`,
      { cause: error },
    );
  }
}

async function reconcileLostImportVector(
  env: Env,
  claim: ImportRequestRow,
  intent: ImportVectorCleanupIntent,
): Promise<void> {
  const occupied = await findImportMemoryById(env, claim.request_id);
  if (occupied?.deleted_at === null) return;

  const rearmed = await env.DB.prepare(`
    UPDATE mem0_import_requests
    SET cleanup_vector_id = ?,
        cleanup_vector_generation = cleanup_vector_generation + 1,
        updated_at = unixepoch()
    WHERE request_id = ?
      AND status IN ('processing', 'completed', 'failed')
      AND cleanup_vector_generation >= ?
      AND NOT EXISTS (
        SELECT 1 FROM memories WHERE id = ? AND deleted_at IS NULL
      )
    RETURNING ${IMPORT_LEDGER_COLUMNS}
  `).bind(
    intent.vectorId,
    claim.request_id,
    intent.generation,
    claim.request_id,
  ).first<ImportRequestRow>();

  if (rearmed === null) {
    const canonical = await findImportMemoryById(env, claim.request_id);
    if (canonical?.deleted_at === null) return;
    const current = await findImportRequest(env, claim.request_id);
    if (current?.cleanup_vector_id !== null) return;
    throw new TransientMem0ImportError('Mem0 import could not persist stale vector cleanup intent');
  }
}

function safeImportErrorDetail(env: Env, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let detail = (message.trim() || 'Unknown preparation failure')
    .replace(/(authorization\s*:\s*bearer)\s+[^\s;,]+/gi, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED]');
  const configuredSecrets = [
    env.DEDUP_LLM_API_KEY,
    env.LLM_API_KEY,
    env.EMBEDDING_API_KEY,
    env.GRAPH_LLM_API_KEY,
    env.MEM0_API_KEY,
  ].filter((value): value is string => typeof value === 'string' && value.length >= 4);
  for (const secret of configuredSecrets) detail = detail.split(secret).join('[REDACTED]');
  return detail;
}

async function completeDeterministicImportLease(
  env: Env,
  claim: ImportRequestRow,
  item: RawMemoryMigrationItem,
  metadataJson: string,
  createdAt: number,
  now: number,
): Promise<ProcessMem0ImportResult> {
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO memory_history (
        id, memory_id, operation, content, metadata_json, hash, created_at
      )
      SELECT ?, ?, 'ADD', ?, ?, ?, ?
      FROM mem0_import_requests
      WHERE request_id = ? AND status = 'processing' AND lease_token = ?
        AND cleanup_vector_id IS NULL
        AND EXISTS (SELECT 1 FROM memories WHERE id = ? AND deleted_at IS NULL)
      ON CONFLICT(id) DO NOTHING
    `).bind(
      `${claim.request_id}:import`,
      claim.request_id,
      item.memory,
      metadataJson,
      claim.request_id,
      createdAt,
      claim.request_id,
      claim.lease_token,
      claim.request_id,
    ),
    env.DB.prepare(`
      UPDATE mem0_import_requests
      SET status = 'completed', error_message = NULL, updated_at = ?, completed_at = ?
      WHERE request_id = ? AND status = 'processing' AND lease_token = ?
        AND cleanup_vector_id IS NULL
        AND EXISTS (SELECT 1 FROM memories WHERE id = ? AND deleted_at IS NULL)
    `).bind(now, now, claim.request_id, claim.lease_token, claim.request_id),
  ]);
  return Number(results[1]?.meta.changes ?? 0) === 1 ? 'processed' : 'inflight';
}

async function completeDuplicateImportLease(
  env: Env,
  claim: ImportRequestRow,
  now: number,
): Promise<ProcessMem0ImportResult> {
  for (let reconciliation = 0; reconciliation < 8; reconciliation += 1) {
    const pending = await findActiveImportCleanupIntent(env, claim);
    if (pending !== undefined) {
      await cleanupImportVector(env, claim, pending);
      continue;
    }

    const completed = await completeImportLease(env, claim, now);
    if (completed === 'processed') return completed;
    if (await findActiveImportCleanupIntent(env, claim) === undefined) return 'inflight';
  }

  await env.DB.prepare(`
    UPDATE mem0_import_requests
    SET status = 'failed', error_message = ?, updated_at = unixepoch(), completed_at = NULL
    WHERE request_id = ? AND status = 'processing' AND lease_token = ?
      AND cleanup_vector_id IS NOT NULL
  `).bind(
    'Mem0 import vector cleanup remained pending during duplicate completion',
    claim.request_id,
    claim.lease_token,
  ).run();
  return 'inflight';
}

async function completeImportLease(
  env: Env,
  claim: ImportRequestRow,
  now: number,
): Promise<ProcessMem0ImportResult> {
  const result = await env.DB.prepare(`
    UPDATE mem0_import_requests
    SET status = 'completed', error_message = NULL, updated_at = ?, completed_at = ?
    WHERE request_id = ? AND status = 'processing' AND lease_token = ?
      AND cleanup_vector_id IS NULL
  `).bind(now, now, claim.request_id, claim.lease_token).run();
  return Number(result.meta.changes ?? 0) === 1 ? 'processed' : 'inflight';
}

async function ensureLegacyImportRequest(env: Env, job: Mem0ImportJob): Promise<void> {
  const existing = await findImportRequest(env, job.requestId);
  if (existing !== null) {
    if (job.item !== undefined) verifyLegacyJobMatches(existing, job);
    return;
  }

  if (job.item === undefined) throw new Error('Mem0 import request not found');
  const scope = importScope(job);
  const parsedItem = RawMemoryMigrationItem.safeParse(job.item);
  if (!parsedItem.success) throw parsedItem.error;
  await env.DB.prepare(`
    INSERT INTO mem0_import_requests (
      request_id, entity_type, entity_id, item_json, status,
      attempt_count, lease_token, publish_token, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', 0, 0, 0, unixepoch(), unixepoch())
    ON CONFLICT(request_id) DO NOTHING
  `).bind(job.requestId, scope.entityType, scope.entityId, JSON.stringify(parsedItem.data)).run();

  const persisted = await findImportRequest(env, job.requestId);
  if (persisted === null) throw new Error('Unable to persist Mem0 import request');
  verifyLegacyJobMatches(persisted, { ...job, item: parsedItem.data });
}

async function findImportRequest(env: Env, requestId: string): Promise<ImportRequestRow | null> {
  return env.DB.prepare(`
    SELECT ${IMPORT_LEDGER_COLUMNS}
    FROM mem0_import_requests
    WHERE request_id = ?
  `).bind(requestId).first<ImportRequestRow>();
}

async function claimImportRequest(env: Env, requestId: string): Promise<ImportRequestRow | undefined> {
  const staleBefore = Math.floor(Date.now() / 1000) - IMPORT_PROCESSING_LEASE_SECONDS;
  const claimed = await env.DB.prepare(`
    UPDATE mem0_import_requests
    SET status = 'processing', attempt_count = attempt_count + 1,
        lease_token = lease_token + 1, error_message = NULL, updated_at = unixepoch(), completed_at = NULL
    WHERE request_id = ? AND (
      status = 'queued'
      OR (status = 'failed' AND (
        cleanup_vector_id IS NOT NULL
        OR error_message IS NULL
        OR error_message NOT LIKE ?
      ))
      OR (status = 'completed' AND cleanup_vector_id IS NOT NULL)
      OR (status = 'processing' AND updated_at < ?)
    )
    RETURNING ${IMPORT_LEDGER_COLUMNS}
  `).bind(requestId, `${TERMINAL_IMPORT_CONFLICT_PREFIX}%`, staleBefore).first<ImportRequestRow>();
  return claimed ?? undefined;
}

async function importRequestDisposition(env: Env, requestId: string): Promise<ProcessMem0ImportResult> {
  const current = await findImportRequest(env, requestId);
  if (current?.status === 'completed' && current.cleanup_vector_id === null) return 'noop';
  if (current?.status === 'failed'
    && current.cleanup_vector_id === null
    && current.error_message?.startsWith(TERMINAL_IMPORT_CONFLICT_PREFIX)) return 'noop';
  if (current?.status === 'queued'
    || current?.status === 'processing'
    || current?.status === 'failed'
    || current?.status === 'completed') return 'inflight';
  throw new Error('Mem0 import request not found');
}

async function failImportRequest(env: Env, requestId: string, leaseToken: number, error: unknown): Promise<void> {
  await env.DB.prepare(`
    UPDATE mem0_import_requests
    SET status = 'failed', error_message = ?, updated_at = unixepoch()
    WHERE request_id = ? AND status = 'processing' AND lease_token = ?
  `).bind(error instanceof Error ? error.message : String(error), requestId, leaseToken).run();
}

function verifyLegacyJobMatches(existing: ImportRequestRow, job: Mem0ImportJob): void {
  const scope = importScope(job);
  const parsedItem = RawMemoryMigrationItem.safeParse(job.item);
  if (!parsedItem.success) throw parsedItem.error;
  if (scope.entityType !== existing.entity_type || scope.entityId !== existing.entity_id
    || JSON.stringify(parsedItem.data) !== existing.item_json) {
    throw new Error('Mem0 import job conflicts with its durable request');
  }
}

function parsePersistedImportItem(value: string): RawMemoryMigrationItem | undefined {
  try {
    const parsed = RawMemoryMigrationItem.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function enqueueMem0AgentReclassification(env: Env, sourceUserId: string, agentId: string): Promise<number> {
  const result = await env.DB.prepare(`
    SELECT id, content, metadata_json
    FROM memories
    WHERE user_id = ? AND deleted_at IS NULL
  `).bind(sourceUserId).all<{ id: string; content: string; metadata_json: string }>();

  await Promise.all(result.results.map((row) => env.MEMORY_JOBS.send({
    type: 'reclassify-mem0-agent',
    id: row.id,
    sourceUserId,
    agentId,
    content: row.content,
    metadataJson: row.metadata_json,
  })));
  return result.results.length;
}

export async function processMem0AgentReclassificationJob(env: Env, job: ReclassifyMem0AgentJob): Promise<void> {
  const targetScope = { userId: null, agentId: job.agentId };
  const digest = await contentHash(job.content);
  for (let attempt = 0; attempt < RECLASSIFICATION_MAX_ATTEMPTS; attempt += 1) {
    let source = await findReclassificationMemory(env, job.id);
    if (source === null) return;
    if (source.deletedAt !== null) {
      await deleteVector(env.VECTORIZE, source.id);
      return;
    }

    if (isTargetScopedSource(source, job, digest)) {
      await reindexReclassifiedMemory(env, source);
      await cleanupSoftDeletedTargetVectors(env, source, job, digest);
    } else if (!isExpectedSource(source, job, digest)) {
      await cleanupSoftDeletedTargetVectors(env, source, job, digest);
      return;
    } else if (source.contentHash === null) {
      source = await backfillReclassificationContentHash(env, source, digest);
      if (source === null) continue;
    }

    const collision = await findActiveExactMemory(env, targetScope, job.content, digest, job.id);
    if (collision === undefined) {
      if (isTargetScopedSource(source, job, digest)) return;
      try {
        const moved = await moveReclassifiedMemory(env, source, job, digest);
        if (moved === null) continue;
        await reindexReclassifiedMemory(env, moved);
        return;
      } catch (error) {
        if (isMemoryContentUniqueConflict(error)) continue;
        throw error;
      }
    }

    const target = reclassificationRow(collision);
    const sourceWins = memoryPrecedes(source, target);
    const committed = sourceWins
      ? await mergeTargetIntoSource(env, source, target, job.agentId, digest)
      : await mergeSourceIntoTarget(env, source, target);
    if (!committed) continue;

    if (sourceWins) {
      const currentSource = await findReclassificationMemory(env, source.id);
      if (currentSource !== null && isTargetScopedSource(currentSource, job, digest)) {
        await reindexReclassifiedMemory(env, currentSource);
      }
      await deleteVector(env.VECTORIZE, target.id);
    } else {
      await deleteVector(env.VECTORIZE, source.id);
    }
    return;
  }

  throw new TransientMem0ImportError('Mem0 agent reclassification lost concurrent ownership races');
}

async function findReclassificationMemory(env: Env, id: string): Promise<ReclassificationMemoryRow | null> {
  return env.DB.prepare(`
    SELECT id, user_id AS userId, agent_id AS agentId, run_id AS runId,
      actor_id AS actorId, content, metadata_json AS metadataJson, hash,
      content_hash AS contentHash, created_at AS createdAt, deleted_at AS deletedAt
    FROM memories
    WHERE id = ?
  `).bind(id).first<ReclassificationMemoryRow>();
}

async function backfillReclassificationContentHash(
  env: Env,
  source: ReclassificationMemoryRow,
  digest: string,
): Promise<ReclassificationMemoryRow | null> {
  return env.DB.prepare(`
    UPDATE memories
    SET content_hash = ?
    WHERE id = ?
      AND user_id IS ?
      AND agent_id IS ?
      AND content = ?
      AND hash = ?
      AND content_hash IS NULL
      AND created_at = ?
      AND deleted_at IS NULL
    RETURNING id, user_id AS userId, agent_id AS agentId, run_id AS runId,
      actor_id AS actorId, content, metadata_json AS metadataJson, hash,
      content_hash AS contentHash, created_at AS createdAt, deleted_at AS deletedAt
  `).bind(
    digest,
    source.id,
    source.userId,
    source.agentId,
    source.content,
    source.hash,
    source.createdAt,
  ).first<ReclassificationMemoryRow>();
}

async function moveReclassifiedMemory(
  env: Env,
  source: ReclassificationMemoryRow,
  job: ReclassifyMem0AgentJob,
  digest: string,
): Promise<ReclassificationMemoryRow | null> {
  return env.DB.prepare(`
    UPDATE memories
    SET user_id = NULL, agent_id = ?, content_hash = COALESCE(content_hash, ?)
    WHERE id = ?
      AND user_id IS ?
      AND agent_id IS ?
      AND content = ?
      AND hash = ?
      AND content_hash IS ?
      AND created_at = ?
      AND deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM memories AS target
        WHERE target.id <> ?
          AND target.user_id IS NULL
          AND target.agent_id = ?
          AND target.content = ?
          AND (target.content_hash = ? OR target.content_hash IS NULL)
          AND target.deleted_at IS NULL
      )
    RETURNING id, user_id AS userId, agent_id AS agentId, run_id AS runId,
      actor_id AS actorId, content, metadata_json AS metadataJson, hash,
      content_hash AS contentHash, created_at AS createdAt, deleted_at AS deletedAt
  `).bind(
    job.agentId,
    digest,
    source.id,
    source.userId,
    source.agentId,
    source.content,
    source.hash,
    source.contentHash,
    source.createdAt,
    source.id,
    job.agentId,
    job.content,
    digest,
  ).first<ReclassificationMemoryRow>();
}

async function reindexReclassifiedMemory(env: Env, source: ReclassificationMemoryRow): Promise<void> {
  const embedding = await embedText(env, source.content);
  await upsertVectors(env.VECTORIZE, [{
    id: source.id,
    values: embedding,
    metadata: await memoryVectorMetadata(source),
  }]);
}

async function cleanupSoftDeletedTargetVectors(
  env: Env,
  source: ReclassificationMemoryRow,
  job: ReclassifyMem0AgentJob,
  digest: string,
): Promise<void> {
  const result = await env.DB.prepare(`
    SELECT id
    FROM memories
    WHERE id <> ?
      AND user_id IS NULL
      AND agent_id = ?
      AND content = ?
      AND content_hash = ?
      AND deleted_at IS NOT NULL
      AND (created_at > ? OR (created_at = ? AND id > ?))
    ORDER BY created_at ASC, id ASC
  `).bind(
    source.id,
    job.agentId,
    job.content,
    digest,
    source.createdAt,
    source.createdAt,
    source.id,
  ).all<{ id: string }>();
  for (const { id } of result.results) await deleteVector(env.VECTORIZE, id);
}

async function mergeSourceIntoTarget(
  env: Env,
  source: ReclassificationMemoryRow,
  target: ReclassificationMemoryRow,
): Promise<boolean> {
  const guard = [...activeMemoryBindings(source), ...activeMemoryBindings(target)];
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO memory_entity_links (memory_id, entity_id, created_at)
      SELECT ?, links.entity_id, links.created_at
      FROM memory_entity_links AS links
      WHERE links.memory_id = ?
        AND ${ACTIVE_MEMORY_GUARD}
        AND ${ACTIVE_MEMORY_GUARD}
    `).bind(target.id, source.id, ...guard),
    env.DB.prepare(`
      UPDATE relationships
      SET evidence_memory_id = ?
      WHERE evidence_memory_id = ?
        AND ${ACTIVE_MEMORY_GUARD}
        AND ${ACTIVE_MEMORY_GUARD}
    `).bind(target.id, source.id, ...guard),
    env.DB.prepare(`
      UPDATE memories
      SET deleted_at = unixepoch()
      WHERE id = ?
        AND ${ACTIVE_MEMORY_GUARD}
        AND ${ACTIVE_MEMORY_GUARD}
    `).bind(source.id, ...guard),
  ]);
  return Number(results[2]?.meta.changes ?? 0) === 1;
}

async function mergeTargetIntoSource(
  env: Env,
  source: ReclassificationMemoryRow,
  target: ReclassificationMemoryRow,
  agentId: string,
  digest: string,
): Promise<boolean> {
  const activeGuard = [...activeMemoryBindings(source), ...activeMemoryBindings(target)];
  // The final move is permitted only when this transaction's immediately preceding guard tombstoned the target.
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO memory_entity_links (memory_id, entity_id, created_at)
      SELECT ?, links.entity_id, links.created_at
      FROM memory_entity_links AS links
      WHERE links.memory_id = ?
        AND ${ACTIVE_MEMORY_GUARD}
        AND ${ACTIVE_MEMORY_GUARD}
    `).bind(source.id, target.id, ...activeGuard),
    env.DB.prepare(`
      UPDATE relationships
      SET evidence_memory_id = ?
      WHERE evidence_memory_id = ?
        AND ${ACTIVE_MEMORY_GUARD}
        AND ${ACTIVE_MEMORY_GUARD}
    `).bind(source.id, target.id, ...activeGuard),
    env.DB.prepare(`
      UPDATE memories
      SET deleted_at = unixepoch()
      WHERE id = ?
        AND ${ACTIVE_MEMORY_GUARD}
        AND ${ACTIVE_MEMORY_GUARD}
    `).bind(target.id, ...activeGuard),
    env.DB.prepare(`
      UPDATE memories
      SET user_id = NULL, agent_id = ?, content_hash = COALESCE(content_hash, ?)
      WHERE id = ?
        AND changes() = 1
        AND ${ACTIVE_MEMORY_GUARD}
        AND ${DELETED_MEMORY_GUARD}
      RETURNING id
    `).bind(
      agentId,
      digest,
      source.id,
      ...activeMemoryBindings(source),
      ...activeMemoryBindings(target),
    ),
  ]);
  return Number(results[2]?.meta.changes ?? 0) === 1
    && Number(results[3]?.meta.changes ?? 0) === 1;
}

function activeMemoryBindings(row: ReclassificationMemoryRow): unknown[] {
  return [
    row.id,
    row.userId,
    row.agentId,
    row.content,
    row.hash,
    row.contentHash,
    row.createdAt,
  ];
}

function reclassificationRow(row: {
  id: string;
  userId: string | null;
  agentId: string | null;
  runId: string | null;
  actorId: string | null;
  content: string;
  metadataJson: string;
  hash: string;
  contentHash: string | null;
  createdAt: number;
  deletedAt: number | null;
}): ReclassificationMemoryRow {
  return { ...row };
}

function isExpectedSource(
  source: ReclassificationMemoryRow,
  job: ReclassifyMem0AgentJob,
  digest: string,
): boolean {
  return source.userId === job.sourceUserId
    && source.agentId === null
    && source.content === job.content
    && (source.contentHash === null || source.contentHash === digest);
}

function isTargetScopedSource(
  source: ReclassificationMemoryRow,
  job: ReclassifyMem0AgentJob,
  digest: string,
): boolean {
  return source.userId === null
    && source.agentId === job.agentId
    && source.content === job.content
    && source.contentHash === digest;
}

function memoryPrecedes(left: ReclassificationMemoryRow, right: ReclassificationMemoryRow): boolean {
  return left.createdAt < right.createdAt
    || (left.createdAt === right.createdAt && left.id < right.id);
}

function isMemoryContentUniqueConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { message?: unknown; cause?: unknown };
  const message = [candidate.message, (candidate.cause as { message?: unknown } | undefined)?.message]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return /unique constraint failed/i.test(message)
    && /memories\.(?:user_id|agent_id)|content_hash/i.test(message);
}

function importScope(job: Mem0ImportJob): DashboardEntityScope {
  const explicit = job.entityId !== undefined && job.entityId.trim() !== '' && (job.entityType === 'user' || job.entityType === 'agent')
    ? { entityType: job.entityType, entityId: job.entityId }
    : undefined;
  const legacy = job.userId !== undefined && job.userId.trim() !== ''
    ? { entityType: 'user' as const, entityId: job.userId }
    : undefined;
  if (explicit !== undefined && legacy !== undefined
    && (explicit.entityType !== legacy.entityType || explicit.entityId !== legacy.entityId)) {
    throw new Error('Conflicting Mem0 import entity scopes');
  }
  if (explicit !== undefined) return explicit;
  if (legacy !== undefined) return legacy;
  throw new Error('Invalid Mem0 import entity scope');
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function selectUniqueImportItems(items: RawMemoryMigrationItem[]): RawMemoryMigrationItem[] {
  const selected = new Map<string, { item: RawMemoryMigrationItem; index: number; createdAt?: number }>();
  items.forEach((item, index) => {
    const candidate = { item, index, createdAt: validSourceTimestamp(item.created_at) };
    const current = selected.get(item.memory);
    if (current === undefined || importItemPrecedes(candidate, current)) selected.set(item.memory, candidate);
  });
  return [...selected.values()].map(({ item }) => item);
}

function importItemPrecedes(
  candidate: { index: number; createdAt?: number },
  current: { index: number; createdAt?: number },
): boolean {
  if (candidate.createdAt !== undefined && current.createdAt === undefined) return true;
  if (candidate.createdAt === undefined && current.createdAt !== undefined) return false;
  if (candidate.createdAt !== undefined && current.createdAt !== undefined && candidate.createdAt !== current.createdAt) {
    return candidate.createdAt < current.createdAt;
  }
  return candidate.index < current.index;
}

function validSourceTimestamp(value: string | null | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function sourceUnixTimestamp(value: string | null): number | undefined {
  if (value === null) return undefined;
  return Math.floor(Date.parse(value) / 1000);
}
