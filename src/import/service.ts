import type { Env, Mem0ImportJob, ReclassifyMem0AgentJob } from '../env';
import { embedText } from '../llm';
import { findActiveExactMemory, prepareMemoryWrite } from '../memory/deduplication';
import { memoryVectorMetadata } from '../memory/identity';
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

interface ImportRequestRow {
  request_id: string;
  entity_type: 'user' | 'agent';
  entity_id: string;
  item_json: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  attempt_count: number;
  lease_token: number;
  cleanup_vector_id: string | null;
}

const IMPORT_PROCESSING_LEASE_SECONDS = 5 * 60;
const IMPORT_DISPATCH_LEASE_SECONDS = 5 * 60;
const IMPORT_DISPATCH_BATCH_SIZE = 100;
const IMPORT_LEDGER_COLUMNS = 'request_id, entity_type, entity_id, item_json, status, attempt_count, lease_token, cleanup_vector_id';

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

  try {
    const cleanedPendingVectorId = await cleanupPendingImportVector(env, claim);
    const prepared = await prepareMemoryWrite(env, scope, item.memory);
    if (prepared.duplicate !== undefined) {
      if (prepared.duplicate.id === claim.request_id
        || await findActiveImportMemoryById(env, claim.request_id)) {
        return completeDeterministicImportLease(env, claim, item, metadataJson, createdAt, now);
      }
      if (claim.attempt_count > 1 && cleanedPendingVectorId !== claim.request_id) {
        await cleanupImportVector(env, claim, claim.request_id);
      }
      return completeImportLease(env, claim, now);
    }

    const row = {
      userId: scope.userId,
      agentId: scope.agentId,
      runId: null,
      actorId: null,
      metadataJson,
    };
    const embedding = prepared.embedding ?? await embedText(env, item.memory);
    if (!await hasActiveImportLease(env, claim)) return 'inflight';
    await upsertVectors(env.VECTORIZE, [{ id: claim.request_id, values: embedding, metadata: await memoryVectorMetadata(row) }]);

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
      return completeDeterministicImportLease(env, claim, item, metadataJson, createdAt, now);
    }
    if (!await hasActiveImportLease(env, claim)) return 'inflight';

    const own = await findActiveImportMemoryById(env, claim.request_id);
    if (own) return completeDeterministicImportLease(env, claim, item, metadataJson, createdAt, now);

    const winner = await findActiveExactMemory(
      env,
      scope,
      item.memory,
      prepared.contentHash,
      claim.request_id,
    );
    if (winner === undefined) {
      await setImportCleanupVectorId(env, claim, claim.request_id);
      throw new Error('Mem0 import insert conflict has no active exact winner');
    }

    await cleanupImportVector(env, claim, claim.request_id);
    return completeImportLease(env, claim, now);
  } catch (error) {
    await failImportRequest(env, claim.request_id, claim.lease_token, error);
    throw error;
  }
}

async function cleanupPendingImportVector(env: Env, claim: ImportRequestRow): Promise<string | undefined> {
  if (claim.cleanup_vector_id === null) return undefined;
  await cleanupImportVector(env, claim, claim.cleanup_vector_id);
  return claim.cleanup_vector_id;
}

async function cleanupImportVector(env: Env, claim: ImportRequestRow, vectorId: string): Promise<void> {
  await setImportCleanupVectorId(env, claim, vectorId);
  await deleteVector(env.VECTORIZE, vectorId);
  await setImportCleanupVectorId(env, claim, null);
}

async function setImportCleanupVectorId(
  env: Env,
  claim: ImportRequestRow,
  vectorId: string | null,
): Promise<void> {
  const result = await env.DB.prepare(`
    UPDATE mem0_import_requests
    SET cleanup_vector_id = ?, updated_at = unixepoch()
    WHERE request_id = ? AND status = 'processing' AND lease_token = ?
  `).bind(vectorId, claim.request_id, claim.lease_token).run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new Error('Mem0 import lease was replaced during vector cleanup');
  }
}

async function hasActiveImportLease(env: Env, claim: ImportRequestRow): Promise<boolean> {
  const active = await env.DB.prepare(`
    SELECT request_id
    FROM mem0_import_requests
    WHERE request_id = ? AND status = 'processing' AND lease_token = ?
  `).bind(claim.request_id, claim.lease_token).first<{ request_id: string }>();
  return active !== null;
}

async function findActiveImportMemoryById(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT id FROM memories WHERE id = ? AND deleted_at IS NULL
  `).bind(id).first<{ id: string }>();
  return row !== null;
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
        AND EXISTS (SELECT 1 FROM memories WHERE id = ? AND deleted_at IS NULL)
    `).bind(now, now, claim.request_id, claim.lease_token, claim.request_id),
  ]);
  return Number(results[1]?.meta.changes ?? 0) === 1 ? 'processed' : 'inflight';
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
      status IN ('queued', 'failed') OR (status = 'processing' AND updated_at < ?)
    )
    RETURNING ${IMPORT_LEDGER_COLUMNS}
  `).bind(requestId, staleBefore).first<ImportRequestRow>();
  return claimed ?? undefined;
}

async function importRequestDisposition(env: Env, requestId: string): Promise<ProcessMem0ImportResult> {
  const current = await findImportRequest(env, requestId);
  if (current?.status === 'completed') return 'noop';
  if (current?.status === 'queued' || current?.status === 'processing' || current?.status === 'failed') return 'inflight';
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
  const metadata = scalarMetadata(job.metadataJson);
  const embedding = await embedText(env, job.content);
  await env.DB.prepare(`
    UPDATE memories
    SET user_id = NULL, agent_id = ?
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL
  `).bind(job.agentId, job.id, job.sourceUserId).run();
  await upsertVectors(env.VECTORIZE, [{
    id: job.id,
    values: embedding,
    metadata: { ...metadata, agent_id: job.agentId },
  }]);
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

function scalarMetadata(value: string): Record<string, VectorizeVectorMetadataValue> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, item]) => (
      typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
    ))) as Record<string, VectorizeVectorMetadataValue>;
  } catch {
    return {};
  }
}

function sourceUnixTimestamp(value: string | null): number | undefined {
  if (value === null) return undefined;
  return Math.floor(Date.parse(value) / 1000);
}
