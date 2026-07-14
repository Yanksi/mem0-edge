import { createDb } from '../db/client';
import { memories, memoryHistory } from '../db/schema';
import type { Env, Mem0ImportJob } from '../env';
import { embedText } from '../llm';
import { sha256Hex } from '../memory/idempotency';
import { upsertVectors } from '../vectorize';
import {
  RawMemoryMigrationExport,
  RawMemoryMigrationItem,
  type RawMemoryMigrationExport as RawMemoryMigrationExportType,
} from './types';

export { RawMemoryMigrationExport } from './types';

export function isMem0ImportJob(value: unknown): value is Mem0ImportJob {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Partial<Mem0ImportJob>;
  return job.type === 'import-mem0-memory'
    && typeof job.requestId === 'string'
    && job.requestId.length > 0
    && typeof job.userId === 'string'
    && job.userId.trim().length > 0
    && RawMemoryMigrationItem.safeParse(job.item).success;
}

export async function enqueueMem0Import(
  env: Env,
  userId: string,
  exportPayload: RawMemoryMigrationExportType,
): Promise<number> {
  const exportId = await sha256Hex(JSON.stringify({ user_id: userId, export: exportPayload }));

  await Promise.all(exportPayload.memories.map(async (item, index) => {
    const requestId = await sha256Hex(`${userId}:${exportId}:${index}`);
    await env.MEMORY_JOBS.send({
      type: 'import-mem0-memory',
      requestId,
      userId,
      item,
    });
  }));

  return exportPayload.memories.length;
}

export async function processMem0ImportJob(env: Env, job: Mem0ImportJob): Promise<void> {
  const db = createDb(env.DB);
  const now = Math.floor(Date.now() / 1000);
  const sourceCreatedAt = job.item.created_at ?? null;
  const sourceUpdatedAt = job.item.updated_at ?? null;
  const createdAt = sourceUnixTimestamp(sourceCreatedAt) ?? sourceUnixTimestamp(sourceUpdatedAt) ?? now;
  const updatedAt = sourceUnixTimestamp(sourceUpdatedAt) ?? createdAt;
  const metadata = {
    source: 'mem0-import',
    source_created_at: sourceCreatedAt,
    source_updated_at: sourceUpdatedAt,
  };
  const vectorMetadata = {
    user_id: job.userId,
    source: metadata.source,
    ...(metadata.source_created_at === null ? {} : { source_created_at: metadata.source_created_at }),
    ...(metadata.source_updated_at === null ? {} : { source_updated_at: metadata.source_updated_at }),
  };
  const embedding = await embedText(env, job.item.memory);

  await db.insert(memories).values({
    id: job.requestId,
    userId: job.userId,
    agentId: null,
    runId: null,
    actorId: null,
    content: job.item.memory,
    metadataJson: JSON.stringify(metadata),
    hash: job.requestId,
    createdAt,
    updatedAt,
    deletedAt: null,
  }).onConflictDoNothing().run();

  await db.insert(memoryHistory).values({
    id: `${job.requestId}:import`,
    memoryId: job.requestId,
    operation: 'ADD',
    content: job.item.memory,
    metadataJson: JSON.stringify(metadata),
    hash: job.requestId,
    createdAt,
  }).onConflictDoNothing().run();

  await upsertVectors(env.VECTORIZE, [{
    id: job.requestId,
    values: embedding,
    metadata: vectorMetadata,
  }]);
}

function sourceUnixTimestamp(value: string | null): number | undefined {
  if (value === null) return undefined;
  return Math.floor(Date.parse(value) / 1000);
}
