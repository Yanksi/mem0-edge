import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createDb } from '../db/client';
import { entities, memories, memoryEntityLinks, memoryHistory, memoryRequests, relationships } from '../db/schema';
import type { Env, MemoryJob } from '../env';
import { embedText, extractMemories, extractMemoryGraph } from '../llm';
import type { ExtractedEntity, ExtractedMemory, ExtractedRelationship } from '../llm';
import { deleteVector, searchEntityVectors, searchVectors, upsertEntityVectors, upsertVectors } from '../vectorize';
import { findActiveExactMemory, prepareMemoryWrite } from './deduplication';
import { buildIdempotencyKey, sha256Hex } from './idempotency';
import { contentHash, memoryVectorMetadata } from './identity';
import { AddMemoryRequestSchema, MemoryResponseSchema } from './types';
import type {
  AddMemoryRequest,
  MemoryResponse,
  SearchMemoryRequest,
  UpdateMemoryRequest,
} from './types';
import {
  DurableMemoryMutationError,
  executeContentUpdate,
  MemoryMutationConflictError,
} from './update-mutations';

export { DurableMemoryMutationError, MemoryMutationConflictError } from './update-mutations';

type MemoryRow = typeof memories.$inferSelect;
type MemoryRequestRow = typeof memoryRequests.$inferSelect;
export type AddMemoryResult = MemoryResponse[] | { request_id: string; status: 'queued' };
export type ProcessMemoryJobResult = 'processed' | 'noop' | 'inflight';
type LedgerClaim = { leaseToken: number; candidatesJson: string | null; cleanupVectorIdsJson: string | null };
type LeaseClaim = LedgerClaim;
type MemoryCandidate = { content: string; extracted?: ExtractedMemory };

const PROCESSING_LEASE_MS = 5 * 60 * 1000;
const ENTITY_MATCH_BOOST = 0.1;

export class TransientMemoryJobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransientMemoryJobError';
  }
}

export class MemoryContentConflictError extends Error {
  constructor() {
    super('An active memory with this content already exists');
    this.name = 'MemoryContentConflictError';
  }
}

export async function processMemoryJob(env: Env, job: MemoryJob): Promise<ProcessMemoryJobResult> {
  if (job.type !== 'extract-and-store' || !job.requestId.trim()) {
    throw new Error('Invalid memory job');
  }
  const parsed = AddMemoryRequestSchema.safeParse(job.body);
  if (!parsed.success) throw parsed.error;
  if (parsed.data.request_id !== undefined && parsed.data.request_id !== job.requestId) {
    throw new Error('Memory job request ID does not match its body');
  }

  const db = createDb(env.DB);
  let claim: LedgerClaim | undefined;

  try {
    const claimed = await claimMemoryRequest(db, parsed.data.user_id, job.requestId, ['queued', 'failed']);
    const reclaimed = claimed === undefined
      ? await claimMemoryRequest(db, parsed.data.user_id, job.requestId, ['processing'], processingLeaseCutoff())
      : undefined;

    claim = claimed ?? reclaimed;
    if (claim === undefined) {
      const current = await db.select().from(memoryRequests).where(and(
        eq(memoryRequests.userId, parsed.data.user_id),
        eq(memoryRequests.idempotencyKey, job.requestId),
      )).get();
      return current?.status === 'processing' || current?.status === 'queued' || current?.status === 'failed'
        ? 'inflight'
        : 'noop';
    }

    const responses = await createMemoriesForLease(db, env, parsed.data, job.requestId, claim);
    if (responses === undefined) return 'inflight';
    await completeRequest(db, parsed.data.user_id, job.requestId, claim.leaseToken, responses);
    return 'processed';
  } catch (error) {
    if (claim !== undefined) {
      try {
        await markRequestFailed(db, parsed.data.user_id, job.requestId, error, claim.leaseToken);
      } catch (markError) {
        if (isTransientInfrastructureError(markError)) {
          throw new TransientMemoryJobError(errorMessage(markError), { cause: markError });
        }
        throw markError;
      }
    }
    if (isTransientInfrastructureError(error)) {
      throw new TransientMemoryJobError(errorMessage(error), { cause: error });
    }
    throw error;
  }
}

async function claimMemoryRequest(
  db: ReturnType<typeof createDb>,
  userId: string,
  requestId: string,
  statuses: Array<'queued' | 'failed' | 'processing'>,
  staleBefore?: string,
) : Promise<LedgerClaim | undefined> {
  const rows = await db.update(memoryRequests).set({
      status: 'processing',
      resultJson: null,
      errorMessage: null,
      updatedAt: isoNow(),
      completedAt: null,
      leaseToken: sql`${memoryRequests.leaseToken} + 1`,
    }).where(and(
      eq(memoryRequests.userId, userId),
      eq(memoryRequests.idempotencyKey, requestId),
      inArray(memoryRequests.status, statuses),
      ...(staleBefore === undefined ? [] : [lt(memoryRequests.updatedAt, staleBefore)]),
    )).returning({
      leaseToken: memoryRequests.leaseToken,
      candidatesJson: memoryRequests.candidatesJson,
      cleanupVectorIdsJson: memoryRequests.cleanupVectorIdsJson,
    }).all();
  return rows[0];
}

function processingLeaseCutoff(): string {
  return new Date(Date.now() - PROCESSING_LEASE_MS).toISOString();
}

export async function addMemory(env: Env, request: AddMemoryRequest): Promise<AddMemoryResult> {
  const db = createDb(env.DB);
  const hash = await buildIdempotencyKey({
    requestId: request.request_id,
    userId: request.user_id,
    agentId: request.agent_id,
    runId: request.run_id,
    actorId: request.actor_id,
    messages: request.messages,
  });
  const status = request.async ? 'queued' : 'processing';
  const timestamp = isoNow();
  const claim = await db.insert(memoryRequests).values({
    userId: request.user_id,
    idempotencyKey: hash,
    agentId: request.agent_id ?? null,
    runId: request.run_id ?? null,
    status,
    resultJson: null,
    errorMessage: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    leaseToken: request.async ? 0 : 1,
    candidatesJson: null,
    cleanupVectorIdsJson: null,
  }).onConflictDoNothing().returning({ idempotencyKey: memoryRequests.idempotencyKey }).all();

  if (claim.length === 0) {
    const existing = await db.select().from(memoryRequests).where(and(
      eq(memoryRequests.userId, request.user_id),
      eq(memoryRequests.idempotencyKey, hash),
    )).get();
    const existingResult = await resolveExistingRequest(db, existing, request, hash);
    if (isLeaseClaim(existingResult)) {
      return processClaimedMemoryRequest(
        db,
        env,
        request,
        hash,
        existingResult.leaseToken,
        existingResult.candidatesJson,
        existingResult.cleanupVectorIdsJson,
      );
    }
    if (existingResult !== undefined) return existingResult;

    // Older deployments may have memory rows that predate the request ledger.
    const legacy = await findLegacyMemoryResponses(db, request.user_id, hash);
    if (legacy.length > 0) return legacy;
    throw new Error('Unable to resolve existing memory request');
  }

  return processClaimedMemoryRequest(db, env, request, hash, request.async ? 0 : 1, null, null);
}

async function processClaimedMemoryRequest(
  db: ReturnType<typeof createDb>,
  env: Env,
  request: AddMemoryRequest,
  hash: string,
  leaseToken: number,
  candidatesJson: string | null = null,
  cleanupVectorIdsJson: string | null = null,
): Promise<AddMemoryResult> {
  if (request.async) {
    const job: MemoryJob = { type: 'extract-and-store', requestId: hash, body: request };
    try {
      await env.MEMORY_JOBS.send(job);
    } catch (error) {
      await markQueuedRequestFailed(db, request.user_id, hash, error, leaseToken);
      throw error;
    }
    return { request_id: hash, status: 'queued' };
  }

  try {
    const responses = await createMemoriesForLease(db, env, request, hash, { leaseToken, candidatesJson, cleanupVectorIdsJson });
    if (responses === undefined) throw new Error('Memory request lease was replaced');
    await completeRequest(db, request.user_id, hash, leaseToken, responses);
    return responses;
  } catch (error) {
    await markRequestFailed(db, request.user_id, hash, error, leaseToken);
    throw error;
  }
}

async function resolveExistingRequest(
  db: ReturnType<typeof createDb>,
  existing: MemoryRequestRow | undefined,
  request: AddMemoryRequest,
  hash: string,
): Promise<AddMemoryResult | LeaseClaim | undefined> {
  if (existing === undefined) return undefined;
  if (existing.status === 'completed') {
    const cached = parseCachedResults(existing.resultJson);
    if (cached !== undefined) return cached;
    throw new Error('Completed memory request has invalid cached results');
  }
  if (existing.status === 'queued') {
    return { request_id: hash, status: 'queued' };
  }
  if (existing.status === 'processing') {
    if (!request.async && existing.updatedAt < processingLeaseCutoff()) {
      const reclaimed = await claimMemoryRequest(db, request.user_id, hash, ['processing'], processingLeaseCutoff());
      if (reclaimed !== undefined) return reclaimed;
    }
    return { request_id: hash, status: 'queued' };
  }
  if (existing.status !== 'failed') {
    throw new Error('Memory request has an unknown status');
  }

  const retryAt = isoNow();
  const retry = await db.update(memoryRequests).set({
    status: request.async ? 'queued' : 'processing',
    resultJson: null,
    errorMessage: null,
    updatedAt: retryAt,
    completedAt: null,
    leaseToken: sql`${memoryRequests.leaseToken} + 1`,
  }).where(and(
    eq(memoryRequests.userId, request.user_id),
    eq(memoryRequests.idempotencyKey, hash),
    eq(memoryRequests.status, 'failed'),
  )).returning({
    leaseToken: memoryRequests.leaseToken,
    candidatesJson: memoryRequests.candidatesJson,
    cleanupVectorIdsJson: memoryRequests.cleanupVectorIdsJson,
  }).all();

  if (retry.length > 0) return retry[0];

  const current = await db.select().from(memoryRequests).where(and(
    eq(memoryRequests.userId, request.user_id),
    eq(memoryRequests.idempotencyKey, hash),
  )).get();
  if (current?.status === 'completed') {
    const cached = parseCachedResults(current.resultJson);
    if (cached !== undefined) return cached;
  }
  if (current?.status === 'queued' || current?.status === 'processing') {
    return { request_id: hash, status: 'queued' };
  }
  throw new Error('Unable to retry failed memory request');
}

function isLeaseClaim(value: AddMemoryResult | LeaseClaim | undefined): value is LeaseClaim {
  return typeof value === 'object' && value !== null && 'leaseToken' in value;
}

async function markQueuedRequestFailed(
  db: ReturnType<typeof createDb>,
  userId: string,
  hash: string,
  error: unknown,
  leaseToken: number,
): Promise<void> {
  await db.update(memoryRequests).set({
    status: 'failed',
    errorMessage: errorMessage(error),
    updatedAt: isoNow(),
  }).where(and(
    eq(memoryRequests.userId, userId),
    eq(memoryRequests.idempotencyKey, hash),
    eq(memoryRequests.status, 'queued'),
    eq(memoryRequests.leaseToken, leaseToken),
  )).run();
}

async function createMemoriesForLease(
  db: ReturnType<typeof createDb>,
  env: Env,
  request: AddMemoryRequest,
  hash: string,
  claim: LedgerClaim,
): Promise<MemoryResponse[] | undefined> {
  await cleanupPendingRequestVectors(db, env, request.user_id, hash, claim);
  const candidates = await candidatesForLease(db, env, request, hash, claim);
  if (candidates === undefined) return undefined;
  const now = unixNow();
  const responses: MemoryResponse[] = [];
  const scope = { userId: request.user_id, agentId: request.agent_id ?? null };

  for (const [candidateIndex, candidate] of candidates.entries()) {
    const { content } = candidate;
    const id = await deterministicMemoryId(request.user_id, hash, candidateIndex);

    if (claim.candidatesJson !== null) {
      const own = await findActiveMemoryById(db, id);
      if (own !== undefined) {
        await repairCreatedMemory(db, env, own, candidate);
        responses.push(toResponse(own));
        continue;
      }
    }

    const prepared = await prepareMemoryWrite(env, scope, content);
    if (prepared.duplicate !== undefined) {
      if (prepared.duplicate.id === id) {
        await repairCreatedMemory(db, env, prepared.duplicate, candidate);
      } else if (claim.candidatesJson !== null) {
        await cleanupCandidateVector(db, env, request.user_id, hash, claim.leaseToken, id);
      }
      responses.push(toResponse(prepared.duplicate));
      continue;
    }

    const metadataJson = JSON.stringify(request.metadata);
    const row = {
      id,
      userId: request.user_id,
      agentId: request.agent_id ?? null,
      runId: request.run_id ?? null,
      actorId: request.actor_id ?? null,
      content,
      metadataJson,
      hash,
      contentHash: prepared.contentHash,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const vector = prepared.embedding ?? await embedText(env, content);
    await upsertVectors(env.VECTORIZE, [{ id, values: vector, metadata: await memoryVectorMetadata(row) }]);
    const inserted = await db.insert(memories).values(row).onConflictDoNothing().returning().get();
    if (inserted !== undefined) {
      await repairCreatedMemory(db, env, inserted, candidate);
      responses.push(toResponse(inserted));
      continue;
    }

    const own = await findActiveMemoryById(db, id);
    if (own !== undefined) {
      await repairCreatedMemory(db, env, own, candidate);
      responses.push(toResponse(own));
      continue;
    }

    const winner = await findActiveExactMemory(env, scope, content, prepared.contentHash, id);
    if (winner === undefined) {
      await setRequestCleanupVectorIds(db, request.user_id, hash, claim.leaseToken, [id]);
      throw new TransientMemoryJobError('Memory insert conflict has no active exact winner');
    }

    await cleanupCandidateVector(db, env, request.user_id, hash, claim.leaseToken, id);
    responses.push(toResponse(winner));
  }

  return responses;
}

async function cleanupCandidateVector(
  db: ReturnType<typeof createDb>,
  env: Env,
  userId: string,
  hash: string,
  leaseToken: number,
  id: string,
): Promise<void> {
  await setRequestCleanupVectorIds(db, userId, hash, leaseToken, [id]);
  await deleteVector(env.VECTORIZE, id);
  await setRequestCleanupVectorIds(db, userId, hash, leaseToken, null);
}

async function cleanupPendingRequestVectors(
  db: ReturnType<typeof createDb>,
  env: Env,
  userId: string,
  hash: string,
  claim: LedgerClaim,
): Promise<void> {
  if (claim.cleanupVectorIdsJson === null) return;
  const ids = parseCleanupVectorIds(claim.cleanupVectorIdsJson);
  for (const id of ids) await deleteVector(env.VECTORIZE, id);
  await setRequestCleanupVectorIds(db, userId, hash, claim.leaseToken, null);
}

function parseCleanupVectorIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string' && id.length > 0)) {
      throw new Error('Invalid persisted memory vector cleanup marker');
    }
    return [...new Set(parsed)];
  } catch (error) {
    throw error instanceof Error && error.message === 'Invalid persisted memory vector cleanup marker'
      ? error
      : new Error('Invalid persisted memory vector cleanup marker');
  }
}

async function setRequestCleanupVectorIds(
  db: ReturnType<typeof createDb>,
  userId: string,
  hash: string,
  leaseToken: number,
  ids: string[] | null,
): Promise<void> {
  const rows = await db.update(memoryRequests).set({
    cleanupVectorIdsJson: ids === null ? null : JSON.stringify(ids),
    updatedAt: isoNow(),
  }).where(and(
    eq(memoryRequests.userId, userId),
    eq(memoryRequests.idempotencyKey, hash),
    eq(memoryRequests.status, 'processing'),
    eq(memoryRequests.leaseToken, leaseToken),
  )).returning({ leaseToken: memoryRequests.leaseToken }).all();
  if (rows.length === 0) throw new TransientMemoryJobError('Memory request lease was replaced during vector cleanup');
}

async function findActiveMemoryById(
  db: ReturnType<typeof createDb>,
  id: string,
): Promise<MemoryRow | undefined> {
  return db.select().from(memories).where(and(
    eq(memories.id, id),
    isNull(memories.deletedAt),
  )).get();
}

async function repairCreatedMemory(
  db: ReturnType<typeof createDb>,
  env: Env,
  row: MemoryRow,
  candidate: MemoryCandidate,
): Promise<void> {
  await appendHistory(db, row, 'created', await deterministicCreatedHistoryId(row.id));
  if (candidate.extracted !== undefined) await persistExtractedGraph(db, env, row, candidate.extracted);
}

async function findLegacyMemoryResponses(
  db: ReturnType<typeof createDb>,
  userId: string,
  hash: string,
): Promise<MemoryResponse[]> {
  const rows = await db.select().from(memories).where(and(
    eq(memories.userId, userId),
    eq(memories.hash, hash),
    isNull(memories.deletedAt),
  )).all();
  return rows.map(toResponse);
}

async function markRequestFailed(
  db: ReturnType<typeof createDb>,
  userId: string,
  hash: string,
  error: unknown,
  leaseToken?: number,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.update(memoryRequests).set({
    status: 'failed',
    errorMessage: message,
    updatedAt: isoNow(),
  }).where(and(
    eq(memoryRequests.userId, userId),
    eq(memoryRequests.idempotencyKey, hash),
    eq(memoryRequests.status, 'processing'),
    ...(leaseToken === undefined ? [] : [eq(memoryRequests.leaseToken, leaseToken)]),
  )).run();
}

async function completeRequest(db: ReturnType<typeof createDb>, userId: string, hash: string, leaseToken: number, responses: MemoryResponse[]): Promise<void> {
  const completedAt = isoNow();
  await db.update(memoryRequests).set({ status: 'completed', resultJson: JSON.stringify(responses), errorMessage: null, updatedAt: completedAt, completedAt }).where(and(
    eq(memoryRequests.userId, userId), eq(memoryRequests.idempotencyKey, hash), eq(memoryRequests.status, 'processing'), eq(memoryRequests.leaseToken, leaseToken),
  )).run();
}

async function candidatesForLease(db: ReturnType<typeof createDb>, env: Env, request: AddMemoryRequest, hash: string, claim: LedgerClaim): Promise<MemoryCandidate[] | undefined> {
  if (claim.candidatesJson !== null) return parseCandidates(claim.candidatesJson).map((extracted) => ({ content: extracted.memory, extracted }));
  const extracted = request.infer
    ? await extractMemories(env, request)
    : [{ memory: request.messages.map(({ content }) => content).join('\n'), entities: [], relationships: [] }];
  const trimmed = extracted
    .map((item) => {
      const content = item.memory.trim();
      return { content, extracted: { ...item, memory: content } };
    })
    .filter(({ content }) => Boolean(content));
  const seen = new Set<string>();
  const candidates = trimmed.filter(({ content }) => {
    if (seen.has(content)) return false;
    seen.add(content);
    return true;
  });
  const rows = await db.update(memoryRequests).set({ candidatesJson: JSON.stringify(candidates.map(({ extracted }) => extracted)), updatedAt: isoNow() }).where(and(
    eq(memoryRequests.userId, request.user_id), eq(memoryRequests.idempotencyKey, hash), eq(memoryRequests.status, 'processing'), eq(memoryRequests.leaseToken, claim.leaseToken),
  )).returning({ leaseToken: memoryRequests.leaseToken }).all();
  return rows.length === 0 ? undefined : candidates;
}

async function persistExtractedGraph(db: ReturnType<typeof createDb>, env: Env, memory: MemoryRow, extracted: ExtractedMemory): Promise<void> {
  if (memory.userId === null) return;
  const byName = new Map<string, { id: string; name: string; type: string }>();
  for (const entity of extracted.entities ?? []) {
    const resolved = await persistEntity(db, memory.userId, entity.name, entity.type, entity.summary);
    byName.set(normalizeEntityName(entity.name), resolved);
    await db.insert(memoryEntityLinks).values({ memoryId: memory.id, entityId: resolved.id, createdAt: unixNow() }).onConflictDoNothing().run();
    await persistEntityVector(env, memory.userId, resolved);
  }
  for (const relationship of extracted.relationships ?? []) {
    const sourceKey = normalizeEntityName(relationship.source);
    const targetKey = normalizeEntityName(relationship.target);
    let source = byName.get(sourceKey);
    if (source === undefined) {
      source = await persistEntity(db, memory.userId, relationship.source);
      byName.set(sourceKey, source);
      await db.insert(memoryEntityLinks).values({ memoryId: memory.id, entityId: source.id, createdAt: unixNow() }).onConflictDoNothing().run();
      await persistEntityVector(env, memory.userId, source);
    }
    let target = byName.get(targetKey);
    if (target === undefined) {
      target = await persistEntity(db, memory.userId, relationship.target);
      byName.set(targetKey, target);
      await db.insert(memoryEntityLinks).values({ memoryId: memory.id, entityId: target.id, createdAt: unixNow() }).onConflictDoNothing().run();
      await persistEntityVector(env, memory.userId, target);
    }
    const relationType = relationship.relation_type.trim();
    if (!relationType) continue;
    const id = await sha256Hex(`relationship:${memory.userId}:${memory.id}:${source.id}:${target.id}:${relationType}`);
    const now = unixNow();
    await db.insert(relationships).values({
      id, userId: memory.userId, sourceEntityId: source.id, targetEntityId: target.id,
      relationType, confidence: relationship.confidence ?? 0.5, evidenceMemoryId: memory.id,
      metadataJson: '{}', createdAt: now, updatedAt: now,
    }).onConflictDoNothing().run();
  }
}

async function persistEntityVector(
  env: Env,
  userId: string,
  entity: { id: string; name: string; type: string },
): Promise<void> {
  const name = normalizeEntityName(entity.name);
  const values = await embedText(env, name);
  await upsertEntityVectors(env.ENTITY_VECTORIZE, [{
    id: entity.id,
    values,
    metadata: { user_id: userId, entity: name, entity_type: entity.type },
  }]);
}

async function persistEntity(db: ReturnType<typeof createDb>, userId: string, name: string, type = 'entity', summary?: string): Promise<{ id: string; name: string; type: string }> {
  const normalizedName = normalizeEntityName(name);
  const normalizedType = type.trim().toLowerCase() || 'entity';
  const id = await sha256Hex(`entity:${userId}:${normalizedName}:${normalizedType}`);
  const now = unixNow();
  await db.insert(entities).values({
    id, userId, name: name.trim(), type: normalizedType,
    metadataJson: summary === undefined ? '{}' : JSON.stringify({ summary }), createdAt: now, updatedAt: now,
  }).onConflictDoNothing().run();
  return { id, name: name.trim(), type: normalizedType };
}

function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseCandidates(value: string): ExtractedMemory[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every(isStoredExtractedMemory)) throw new Error('Invalid persisted memory candidates');
    return parsed;
  } catch (error) {
    throw error instanceof Error && error.message === 'Invalid persisted memory candidates' ? error : new Error('Invalid persisted memory candidates');
  }
}

function isStoredExtractedMemory(value: unknown): value is ExtractedMemory {
  if (typeof value !== 'object' || value === null) return false;
  const memory = value as Partial<ExtractedMemory>;
  return typeof memory.memory === 'string'
    && Array.isArray(memory.entities)
    && Array.isArray(memory.relationships)
    && memory.entities.every(isStoredEntity)
    && memory.relationships.every(isStoredRelationship);
}

function isStoredEntity(value: unknown): value is ExtractedEntity {
  if (typeof value !== 'object' || value === null) return false;
  const entity = value as Partial<ExtractedEntity>;
  return typeof entity.name === 'string' && (entity.type === undefined || typeof entity.type === 'string') && (entity.summary === undefined || typeof entity.summary === 'string');
}

function isStoredRelationship(value: unknown): value is ExtractedRelationship {
  if (typeof value !== 'object' || value === null) return false;
  const relationship = value as Partial<ExtractedRelationship>;
  return typeof relationship.source === 'string' && typeof relationship.target === 'string' && typeof relationship.relation_type === 'string' && (relationship.confidence === undefined || typeof relationship.confidence === 'number');
}

function isTransientInfrastructureError(error: unknown): boolean {
  if (error instanceof TransientMemoryJobError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { retryable?: unknown; status?: unknown; message?: unknown };
  if (candidate.retryable === true) return true;
  if (typeof candidate.status === 'number') {
    if ([400, 401, 403, 404, 422].includes(candidate.status)) return false;
    if ([408, 409, 425, 429].includes(candidate.status) || candidate.status >= 500) return true;
  }
  return typeof candidate.message === 'string'
    && /\b(d1|database|llm|openai|embed(?:ding)?|vector|network|timeout|temporar(?:y|ily)|unavailable)\b/i.test(candidate.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCachedResults(value: string | null): MemoryResponse[] | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const results = parsed.map((item) => MemoryResponseSchema.safeParse(item));
    return results.every((result) => result.success)
      ? results.map((result) => result.data)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function searchMemories(env: Env, request: SearchMemoryRequest): Promise<MemoryResponse[]> {
  const vector = await embedText(env, request.query);
  if (request.user_id === undefined) {
    return searchSemanticMemories(env, request, vector);
  }

  const [matches, entityMatches] = await Promise.all([
    searchVectors(env.VECTORIZE, vector, request, { candidatePool: 50 }),
    searchEntityVectors(env.ENTITY_VECTORIZE, vector, request.user_id),
  ]);
  if (matches.length === 0) return [];

  const db = createDb(env.DB);
  const [rows, links] = await Promise.all([
    db.select().from(memories).where(and(
    inArray(memories.id, matches.map(({ id }) => id)),
    eq(memories.userId, request.user_id),
    isNull(memories.deletedAt),
    )).all(),
    linkedMemoryIds(db, entityMatches.map(({ id }) => id)),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const entityScores = new Map(entityMatches.map(({ id, score }) => [id, normalizeEntityScore(score)]));
  const linkedScores = new Map<string, number>();
  for (const link of links) {
    const score = entityScores.get(link.entityId);
    if (score !== undefined) linkedScores.set(link.memoryId, Math.max(linkedScores.get(link.memoryId) ?? 0, score));
  }

  return matches.flatMap(({ id, score }) => {
    const row = byId.get(id);
    return row === undefined ? [] : [{ ...toResponse(row), score: score + ENTITY_MATCH_BOOST * (linkedScores.get(id) ?? 0) }];
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, request.limit);
}

async function searchSemanticMemories(env: Env, request: SearchMemoryRequest, vector: number[]): Promise<MemoryResponse[]> {
  const matches = await searchVectors(env.VECTORIZE, vector, request);
  if (matches.length === 0) return [];

  const rows = await createDb(env.DB).select().from(memories).where(and(
    inArray(memories.id, matches.map(({ id }) => id)),
    eq(memories.agentId, request.agent_id!),
    isNull(memories.deletedAt),
  )).all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  return matches.flatMap(({ id, score }) => {
    const row = byId.get(id);
    return row === undefined ? [] : [{ ...toResponse(row), score }];
  });
}

async function linkedMemoryIds(
  db: ReturnType<typeof createDb>,
  entityIds: string[],
): Promise<Array<{ memoryId: string; entityId: string }>> {
  if (entityIds.length === 0) return [];
  return db.select({ memoryId: memoryEntityLinks.memoryId, entityId: memoryEntityLinks.entityId })
    .from(memoryEntityLinks)
    .where(inArray(memoryEntityLinks.entityId, entityIds))
    .all();
}

function normalizeEntityScore(score: number): number {
  return Math.min(Math.max(score, 0), 1);
}

export async function getMemory(env: Env, id: string, userId: string): Promise<MemoryResponse | null> {
  const row = await findActiveMemory(env, id, userId);
  return row === undefined ? null : toResponse(row);
}

export async function getMemoryById(env: Env, id: string): Promise<MemoryResponse | null> {
  const row = await createDb(env.DB).select().from(memories).where(and(
    eq(memories.id, id),
    isNull(memories.deletedAt),
  )).get();
  return row === undefined ? null : toResponse(row);
}

export async function getMemoryOwnerById(env: Env, id: string): Promise<string | null | undefined> {
  const row = await createDb(env.DB).select({ userId: memories.userId }).from(memories).where(
    eq(memories.id, id),
  ).get();
  return row?.userId;
}

export async function listMemories(env: Env, userId: string, limit: number): Promise<MemoryResponse[]> {
  const rows = await createDb(env.DB).select().from(memories).where(and(
    eq(memories.userId, userId),
    isNull(memories.deletedAt),
  )).orderBy(desc(memories.createdAt)).limit(Math.min(Math.max(limit, 1), 100)).all();
  return rows.map(toResponse);
}

export async function updateMemory(env: Env, id: string, userId: string, request: UpdateMemoryRequest): Promise<MemoryResponse | null> {
  const db = createDb(env.DB);
  const current = await findActiveMemory(env, id, userId, db);
  if (current === undefined) return null;

  const content = request.memory === undefined ? current.content : request.memory;
  let nextContentHash = current.contentHash ?? await contentHash(current.content);
  if (content !== current.content) {
    nextContentHash = await contentHash(content);
    const duplicate = await findActiveExactMemory(
      env,
      { userId: current.userId, agentId: current.agentId },
      content,
      nextContentHash,
      id,
    );
    if (duplicate !== undefined) throw new MemoryContentConflictError();
  }
  const metadata = { ...parseMetadata(current.metadataJson), ...(request.metadata ?? {}) };
  const now = unixNow();
  const next = {
    ...current,
    content,
    contentHash: nextContentHash,
    metadataJson: JSON.stringify(metadata),
    updatedAt: now,
  };
  if (request.memory !== undefined) {
    try {
      return toResponse(await executeContentUpdate(env, current, {
        content, contentHash: next.contentHash, metadataJson: next.metadataJson, updatedAt: now,
      }));
    } catch (error) {
      if (isMemoryContentUniqueConstraintError(error)) throw new MemoryContentConflictError();
      throw error;
    }
  }

  const targetVersion = current.mutationVersion + 1;
  const historyId = await sha256Hex(`memory-history:${id}:updated:${targetVersion}`);
  await env.DB.batch([
    env.DB.prepare(`UPDATE memories SET metadata_json = ?, updated_at = ?, mutation_version = ?, last_mutation_id = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND mutation_version = ?`)
      .bind(next.metadataJson, now, targetVersion, historyId, id, userId, current.mutationVersion),
    env.DB.prepare(`INSERT INTO memory_history (id, memory_id, operation, content, metadata_json, hash, created_at) SELECT ?, id, 'updated', content, metadata_json, hash, unixepoch() FROM memories WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND mutation_version = ? AND last_mutation_id = ? ON CONFLICT(id) DO NOTHING`)
      .bind(historyId, id, userId, targetVersion, historyId),
  ]);
  const fence = await env.DB.prepare('SELECT last_mutation_id FROM memories WHERE id = ?').bind(id).first<{ last_mutation_id: string | null }>();
  const stored = await findActiveMemory(env, id, userId, db);
  if (fence?.last_mutation_id !== historyId || stored === undefined || stored.mutationVersion !== targetVersion || stored.metadataJson !== next.metadataJson) {
    throw new MemoryMutationConflictError();
  }
  return toResponse(stored);
}

function isMemoryContentUniqueConstraintError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === 'string'
      && /unique constraint failed/i.test(candidate.message)
      && /memories/i.test(candidate.message)
      && /content_hash/i.test(candidate.message)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export async function deleteMemory(env: Env, id: string, userId: string): Promise<boolean> {
  const db = createDb(env.DB);
  const current = await findOwnedMemory(id, userId, db);
  if (current === undefined) return false;

  if (current.deletedAt === null) {
    const deletedAt = unixNow();
    const deleted = await db.update(memories).set({
      deletedAt,
      mutationVersion: current.mutationVersion + 1,
    }).where(and(
      eq(memories.id, id), eq(memories.userId, userId), isNull(memories.deletedAt),
      eq(memories.mutationVersion, current.mutationVersion),
    )).returning({ id: memories.id }).all();
    if (deleted.length === 0) {
      const raced = await findOwnedMemory(id, userId, db);
      if (raced?.deletedAt === null) throw new MemoryMutationConflictError('Memory changed while delete was committing');
    }
  }
  await removeMemoryGraph(db, id);
  await appendHistory(db, current, 'deleted', await deterministicDeletedHistoryId(id));
  await deleteVector(env.VECTORIZE, id);
  return true;
}

async function removeMemoryGraph(db: ReturnType<typeof createDb>, memoryId: string): Promise<void> {
  await db.delete(relationships).where(eq(relationships.evidenceMemoryId, memoryId)).run();
  await db.delete(memoryEntityLinks).where(eq(memoryEntityLinks.memoryId, memoryId)).run();
}

async function findOwnedMemory(
  id: string,
  userId: string,
  db: ReturnType<typeof createDb>,
): Promise<MemoryRow | undefined> {
  return db.select().from(memories).where(and(
    eq(memories.id, id), eq(memories.userId, userId),
  )).get();
}

async function findActiveMemory(
  env: Env,
  id: string,
  userId: string,
  db = createDb(env.DB),
): Promise<MemoryRow | undefined> {
  return db.select().from(memories).where(and(
    eq(memories.id, id),
    eq(memories.userId, userId),
    isNull(memories.deletedAt),
  )).get();
}

async function appendHistory(
  db: ReturnType<typeof createDb>,
  row: MemoryRow,
  operation: string,
  id = nanoid(),
): Promise<void> {
  await db.insert(memoryHistory).values({
    id,
    memoryId: row.id,
    operation,
    content: row.content,
    metadataJson: row.metadataJson,
    hash: row.hash,
    createdAt: unixNow(),
  }).onConflictDoNothing().run();
}

function deterministicMemoryId(userId: string, hash: string, candidateIndex: number): Promise<string> {
  return sha256Hex(`memory:${userId}:${hash}:${candidateIndex}`);
}

function deterministicCreatedHistoryId(memoryId: string): Promise<string> {
  return sha256Hex(`memory-history:${memoryId}:created`);
}

function deterministicDeletedHistoryId(memoryId: string): Promise<string> {
  return sha256Hex(`memory-history:${memoryId}:deleted`);
}

function toResponse(row: MemoryRow): MemoryResponse {
  return {
    id: row.id,
    memory: row.content,
    ...(row.userId === null ? {} : { user_id: row.userId }),
    ...(row.agentId === null ? {} : { agent_id: row.agentId }),
    ...(row.runId === null ? {} : { run_id: row.runId }),
    ...(row.actorId === null ? {} : { actor_id: row.actorId }),
    metadata: parseMetadata(row.metadataJson),
    created_at: new Date(row.createdAt * 1000).toISOString(),
    updated_at: new Date(row.updatedAt * 1000).toISOString(),
  };
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function isoNow(): string {
  return new Date().toISOString();
}
