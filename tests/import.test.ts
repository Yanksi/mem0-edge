import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { memoryHistory, memories } from '../src/db/schema';

const dependencies = vi.hoisted(() => ({
  createDb: vi.fn(),
  embedText: vi.fn(),
  upsertVectors: vi.fn(),
}));

vi.mock('../src/db/client', () => ({ createDb: dependencies.createDb }));
vi.mock('../src/llm', () => ({ embedText: dependencies.embedText }));
vi.mock('../src/vectorize', () => ({ upsertVectors: dependencies.upsertVectors }));

import { handleMemoryQueue } from '../src/queue';
import {
  enqueueMem0Import,
  processMem0ImportJob,
  RawMemoryMigrationExport,
} from '../src/import/service';

const env = {
  MEMORY_JOBS: { send: vi.fn() },
  VECTORIZE: {} as VectorizeIndex,
} as unknown as Env;

const exportedMemory = {
  memory: '  User prefers espresso.  ',
  created_at: '2024-01-02T03:04:05.000Z',
  updated_at: null,
};

function importDb() {
  const run = vi.fn().mockResolvedValue(undefined);
  const insertedValues: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  return {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) => {
        insertedValues.push({ table, values });
        return {
        onConflictDoNothing: vi.fn().mockReturnValue({ run }),
        };
      }),
    })),
    run,
    insertedValues,
  };
}

describe('Mem0 migration imports', () => {
  beforeEach(() => vi.clearAllMocks());

  it('validates non-empty text and valid optional source timestamps', () => {
    expect(RawMemoryMigrationExport.safeParse({ memories: [exportedMemory] }).success).toBe(true);
    expect(RawMemoryMigrationExport.safeParse({ memories: [{ memory: 'Only memory is required.' }] }).success).toBe(true);
    expect(RawMemoryMigrationExport.safeParse({ memories: [{ ...exportedMemory, memory: '   ' }] }).success).toBe(false);
    expect(RawMemoryMigrationExport.safeParse({ memories: [{ ...exportedMemory, created_at: 'not-a-date' }] }).success).toBe(false);
    expect(RawMemoryMigrationExport.safeParse({ memories: [{ ...exportedMemory, updated_at: 42 }] }).success).toBe(false);
  });

  it('enqueues one stable durable job per exported item', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const exportPayload = { memories: [exportedMemory, { ...exportedMemory, memory: 'User works in Zurich.' }] };

    await expect(enqueueMem0Import({ ...env, MEMORY_JOBS: { send } } as unknown as Env, 'user-123', exportPayload))
      .resolves.toBe(2);
    const firstPass = send.mock.calls.map(([job]) => job);

    send.mockClear();
    await enqueueMem0Import({ ...env, MEMORY_JOBS: { send } } as unknown as Env, 'user-123', exportPayload);

    expect(send).toHaveBeenCalledTimes(2);
    expect(firstPass).toEqual(send.mock.calls.map(([job]) => job));
    expect(firstPass).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'import-mem0-memory', userId: 'user-123', item: exportedMemory }),
    ]));
  });

  it('directly embeds and stores the exact imported text with source timestamps', async () => {
    const db = importDb();
    dependencies.createDb.mockReturnValue(db);
    dependencies.embedText.mockResolvedValue([0.1, 0.2]);
    dependencies.upsertVectors.mockResolvedValue(undefined);
    const job = {
      type: 'import-mem0-memory' as const,
      requestId: 'stable-memory-id',
      userId: 'user-123',
      item: exportedMemory,
    };

    await processMem0ImportJob(env, job);
    await processMem0ImportJob(env, job);

    expect(dependencies.embedText).toHaveBeenCalledWith(env, exportedMemory.memory);
    expect(dependencies.upsertVectors).toHaveBeenCalledWith(env.VECTORIZE, [expect.objectContaining({
      id: 'stable-memory-id',
      metadata: expect.objectContaining({
        user_id: 'user-123',
        source: 'mem0-import',
        source_created_at: exportedMemory.created_at,
      }),
    })]);
    expect(db.insert).toHaveBeenCalledTimes(4);
    expect(db.run).toHaveBeenCalledTimes(4);
    expect(db.insertedValues).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: memories, values: expect.objectContaining({ id: 'stable-memory-id' }) }),
      expect.objectContaining({ table: memoryHistory, values: expect.objectContaining({
        id: 'stable-memory-id:import',
        memoryId: 'stable-memory-id',
        operation: 'ADD',
        content: exportedMemory.memory,
      }) }),
    ]));
  });

  it('routes an import queue job through direct import processing and acknowledges it', async () => {
    const db = importDb();
    dependencies.createDb.mockReturnValue(db);
    dependencies.embedText.mockResolvedValue([0.1]);
    dependencies.upsertVectors.mockResolvedValue(undefined);
    const message = {
      body: { type: 'import-mem0-memory', requestId: 'queue-id', userId: 'user-123', item: exportedMemory },
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handleMemoryQueue({ messages: [message] } as unknown as MessageBatch<Env['MEMORY_JOBS'] extends Queue<infer Job> ? Job : never>, env);

    expect(dependencies.embedText).toHaveBeenCalledWith(env, exportedMemory.memory);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });
});
