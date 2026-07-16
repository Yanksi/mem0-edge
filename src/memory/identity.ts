import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { memories } from '../db/schema';
import { sha256Hex } from './idempotency';

const RESERVED_VECTOR_METADATA_KEYS = new Set([
  'user_id',
  'agent_id',
  'run_id',
  'actor_id',
  'scope_key',
  'content_hash',
  'memory_vector_schema',
  'vector_state_hash',
]);

export const MEMORY_VECTOR_SCHEMA_VERSION = '1';

export interface MemoryOwnerScope {
  userId: string | null;
  agentId: string | null;
}

export interface MemoryVectorSource extends MemoryOwnerScope {
  runId: string | null;
  actorId: string | null;
  contentHash: string;
  metadataJson: string;
}

export function contentHash(content: string): Promise<string> {
  return sha256Hex(content);
}

export function scopeKey(scope: MemoryOwnerScope): Promise<string> {
  return sha256Hex(JSON.stringify([scope.userId, scope.agentId]));
}

export function vectorStateHash(row: MemoryVectorSource): Promise<string> {
  return sha256Hex(JSON.stringify([
    row.userId,
    row.agentId,
    row.runId,
    row.actorId,
    row.metadataJson,
    row.contentHash,
  ]));
}

export function ownerPredicate(scope: MemoryOwnerScope): SQL {
  return and(
    scope.userId === null ? isNull(memories.userId) : eq(memories.userId, scope.userId),
    scope.agentId === null ? isNull(memories.agentId) : eq(memories.agentId, scope.agentId),
  )!;
}

export async function memoryVectorMetadata(
  row: MemoryVectorSource,
): Promise<Record<string, VectorizeVectorMetadataValue>> {
  return {
    ...scalarMetadata(row.metadataJson),
    ...(row.userId === null ? {} : { user_id: row.userId }),
    ...(row.agentId === null ? {} : { agent_id: row.agentId }),
    ...(row.runId === null ? {} : { run_id: row.runId }),
    ...(row.actorId === null ? {} : { actor_id: row.actorId }),
    scope_key: await scopeKey(row),
    content_hash: row.contentHash,
    memory_vector_schema: MEMORY_VECTOR_SCHEMA_VERSION,
    vector_state_hash: await vectorStateHash(row),
  };
}

function scalarMetadata(value: string): Record<string, VectorizeVectorMetadataValue> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return {};

    return Object.fromEntries(Object.entries(parsed).filter(([key, item]) => (
      !RESERVED_VECTOR_METADATA_KEYS.has(key)
      && (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
    ))) as Record<string, VectorizeVectorMetadataValue>;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
