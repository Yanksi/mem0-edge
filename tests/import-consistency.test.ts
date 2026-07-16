/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as workerEnv, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import type { MemoryJob } from '../src/env';

const dependencies = vi.hoisted(() => ({
  embedText: vi.fn(),
  upsertVectors: vi.fn(),
  deleteVector: vi.fn(),
}));

vi.mock('../src/llm', () => ({ embedText: dependencies.embedText }));
vi.mock('../src/vectorize', () => ({
  upsertVectors: dependencies.upsertVectors,
  deleteVector: dependencies.deleteVector,
}));

import { dispatchPendingMem0Imports, processMem0ImportJob } from '../src/import/service';
import { contentHash } from '../src/memory/identity';
import { handleMemoryQueue } from '../src/queue';

const env = workerEnv as unknown as Env;
const item = {
  memory: 'A durable imported memory.',
  created_at: '2024-01-02T03:04:05.000Z',
  updated_at: '2024-02-03T04:05:06.000Z',
};

afterEach(async () => reset());

beforeEach(async () => {
  vi.clearAllMocks();
  dependencies.embedText.mockResolvedValue([0.1, 0.2]);
  dependencies.upsertVectors.mockResolvedValue({ mutationId: 'mutation-1' });
  dependencies.deleteVector.mockResolvedValue(undefined);
  await env.DB.prepare(`
    CREATE TABLE mem0_import_requests (
      request_id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      item_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_token INTEGER NOT NULL DEFAULT 0,
      publish_token INTEGER NOT NULL DEFAULT 0,
      publish_attempted_at INTEGER,
      published_at INTEGER,
      error_message TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER,
      cleanup_vector_id TEXT,
      cleanup_vector_generation INTEGER NOT NULL DEFAULT 0
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, user_id TEXT, agent_id TEXT, run_id TEXT, actor_id TEXT,
      content TEXT NOT NULL, metadata_json TEXT NOT NULL, hash TEXT NOT NULL,
      content_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
    )
  `).run();
  await env.DB.prepare(`
    CREATE UNIQUE INDEX memories_active_user_content_hash_unique_idx
    ON memories (user_id, content_hash)
    WHERE deleted_at IS NULL AND user_id IS NOT NULL AND agent_id IS NULL
  `).run();
  await env.DB.prepare(`
    CREATE UNIQUE INDEX memories_active_agent_content_hash_unique_idx
    ON memories (agent_id, content_hash)
    WHERE deleted_at IS NULL AND user_id IS NULL AND agent_id IS NOT NULL
  `).run();
  await env.DB.prepare(`
    CREATE TABLE memory_history (
      id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, operation TEXT NOT NULL,
      content TEXT NOT NULL, metadata_json TEXT NOT NULL, hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE service_settings (
      id INTEGER PRIMARY KEY NOT NULL,
      semantic_dedup_enabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `).run();
  await env.DB.prepare('INSERT INTO service_settings (id, semantic_dedup_enabled) VALUES (1, 0)').run();
});

async function seedRequest(status: 'queued' | 'failed' | 'processing', updatedAt: number, attemptCount = 0, leaseToken = 0) {
  await env.DB.prepare(`
    INSERT INTO mem0_import_requests (
      request_id, entity_type, entity_id, item_json, status,
      attempt_count, lease_token, created_at, updated_at
    ) VALUES ('request-1', 'user', 'user-1', ?, ?, ?, ?, ?, ?)
  `).bind(JSON.stringify(item), status, attemptCount, leaseToken, updatedAt, updatedAt).run();
}

async function ledger() {
  return env.DB.prepare(`
    SELECT status, attempt_count, lease_token FROM mem0_import_requests WHERE request_id = 'request-1'
  `).first<{ status: string; attempt_count: number; lease_token: number }>();
}

async function cleanupMarker() {
  return env.DB.prepare(`
    SELECT cleanup_vector_id FROM mem0_import_requests WHERE request_id = 'request-1'
  `).first<{ cleanup_vector_id: string | null }>();
}

async function cleanupState() {
  return env.DB.prepare(`
    SELECT cleanup_vector_id, cleanup_vector_generation
    FROM mem0_import_requests WHERE request_id = 'request-1'
  `).first<{
    cleanup_vector_id: string | null;
    cleanup_vector_generation: number;
  }>();
}

async function ledgerFailure() {
  return env.DB.prepare(`
    SELECT status, attempt_count, lease_token, error_message, cleanup_vector_id
    FROM mem0_import_requests WHERE request_id = 'request-1'
  `).first<{
    status: string;
    attempt_count: number;
    lease_token: number;
    error_message: string | null;
    cleanup_vector_id: string | null;
  }>();
}

async function publicationCounts() {
  const [memory, history] = await env.DB.batch<{ count: number }>([
    env.DB.prepare('SELECT COUNT(*) AS count FROM memories'),
    env.DB.prepare('SELECT COUNT(*) AS count FROM memory_history'),
  ]);
  return [memory.results[0].count, history.results[0].count];
}

async function seedCanonicalMemory(
  id: string,
  digest: string | null = null,
  deletedAt: number | null = null,
) {
  await env.DB.prepare(`
    INSERT INTO memories (
      id, user_id, agent_id, run_id, actor_id, content, metadata_json,
      hash, content_hash, created_at, updated_at, deleted_at
    ) VALUES (?, 'user-1', NULL, NULL, NULL, ?, '{}', ?, ?, 1, 1, ?)
  `).bind(id, item.memory, id, digest, deletedAt).run();
}

function queueMessage(body: MemoryJob, attempts = 1): Message<MemoryJob> {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<MemoryJob>;
}

function queueBatch(...messages: Message<MemoryJob>[]): MessageBatch<MemoryJob> {
  return {
    queue: 'mem0-edge-memory-jobs',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<MemoryJob>;
}

describe('durable Mem0 import processing', () => {
  it.each(['queued', 'failed'] as const)('claims and atomically publishes a %s request', async (status) => {
    await seedRequest(status, Math.floor(Date.now() / 1000));

    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).resolves.toBe('processed');

    await expect(ledger()).resolves.toEqual({ status: 'completed', attempt_count: 1, lease_token: 1 });
    await expect(publicationCounts()).resolves.toEqual([1, 1]);
    await expect(env.DB.prepare(`
      SELECT content_hash FROM memories WHERE id = 'request-1'
    `).first()).resolves.toEqual({ content_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(dependencies.upsertVectors).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({
      id: 'request-1',
      metadata: expect.objectContaining({
        user_id: 'user-1',
        scope_key: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    })]);
  });

  it('leaves a fresh processing lease inflight without side effects', async () => {
    await seedRequest('processing', Math.floor(Date.now() / 1000), 2, 4);

    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).resolves.toBe('inflight');

    await expect(ledger()).resolves.toEqual({ status: 'processing', attempt_count: 2, lease_token: 4 });
    await expect(publicationCounts()).resolves.toEqual([0, 0]);
  });

  it('reclaims a stale processing lease', async () => {
    await seedRequest('processing', Math.floor(Date.now() / 1000) - 301, 2, 4);

    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).resolves.toBe('processed');

    await expect(ledger()).resolves.toEqual({ status: 'completed', attempt_count: 3, lease_token: 5 });
    await expect(publicationCounts()).resolves.toEqual([1, 1]);
  });

  it('completes an exact storage duplicate without embedding, vector mutation, or history', async () => {
    await seedRequest('queued', Math.floor(Date.now() / 1000));
    await seedCanonicalMemory('canonical-memory');

    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).resolves.toBe('processed');

    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
    await expect(publicationCounts()).resolves.toEqual([1, 0]);
    await expect(ledger()).resolves.toEqual({ status: 'completed', attempt_count: 1, lease_token: 1 });
  });

  it('idempotently finishes history and completion when its deterministic row already exists', async () => {
    await seedRequest('failed', Math.floor(Date.now() / 1000), 1, 1);
    await seedCanonicalMemory('request-1', await contentHash(item.memory));

    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).resolves.toBe('processed');

    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
    await expect(publicationCounts()).resolves.toEqual([1, 1]);
    await expect(ledger()).resolves.toEqual({ status: 'completed', attempt_count: 2, lease_token: 2 });
  });

  it('preserves its deterministic row when preparation selects an older exact canonical', async () => {
    await seedRequest('failed', Math.floor(Date.now() / 1000), 1, 1);
    await seedCanonicalMemory('canonical-memory');
    await seedCanonicalMemory('request-1', await contentHash(item.memory));

    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).resolves.toBe('processed');

    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
    await expect(env.DB.prepare(`
      SELECT COUNT(*) AS count FROM memory_history WHERE memory_id = 'request-1'
    `).first()).resolves.toEqual({ count: 1 });
    await expect(ledger()).resolves.toEqual({ status: 'completed', attempt_count: 2, lease_token: 2 });
  });

  it('terminally fails without vector or history mutation when its active ID has edited content', async () => {
    await seedRequest('failed', Math.floor(Date.now() / 1000), 1, 1);
    const editedContent = 'This deterministic row was edited after the partial import.';
    await seedCanonicalMemory('request-1', await contentHash(editedContent));
    await env.DB.prepare(`
      UPDATE memories SET content = ? WHERE id = 'request-1'
    `).bind(editedContent).run();
    await env.DB.prepare(`
      UPDATE mem0_import_requests SET cleanup_vector_id = 'request-1' WHERE request_id = 'request-1'
    `).run();

    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).rejects.toThrow(/terminal mem0 import conflict.*content/i);

    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
    await expect(publicationCounts()).resolves.toEqual([1, 0]);
    await expect(env.DB.prepare(`
      SELECT content FROM memories WHERE id = 'request-1'
    `).first()).resolves.toEqual({ content: editedContent });
    await expect(ledgerFailure()).resolves.toEqual(expect.objectContaining({
      status: 'failed',
      attempt_count: 2,
      lease_token: 2,
      error_message: expect.stringMatching(/terminal mem0 import conflict.*content/i),
      cleanup_vector_id: null,
    }));
  });

  it('terminally fails without vector or history mutation when its active ID changed scope', async () => {
    await seedRequest('failed', Math.floor(Date.now() / 1000), 1, 1);
    await seedCanonicalMemory('request-1', await contentHash(item.memory));
    await env.DB.prepare(`
      UPDATE memories SET user_id = NULL, agent_id = 'other-agent' WHERE id = 'request-1'
    `).run();

    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).rejects.toThrow(/terminal mem0 import conflict.*ownership/i);

    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
    await expect(publicationCounts()).resolves.toEqual([1, 0]);
    await expect(env.DB.prepare(`
      SELECT user_id, agent_id FROM memories WHERE id = 'request-1'
    `).first()).resolves.toEqual({ user_id: null, agent_id: 'other-agent' });
  });

  it('revalidates its deterministic ID after preparation before mutating Vectorize', async () => {
    await seedRequest('queued', Math.floor(Date.now() / 1000));
    const editedContent = 'A concurrent writer occupied the deterministic import ID.';
    dependencies.embedText.mockImplementationOnce(async () => {
      await seedCanonicalMemory('request-1', await contentHash(editedContent));
      await env.DB.prepare(`
        UPDATE memories SET content = ? WHERE id = 'request-1'
      `).bind(editedContent).run();
      return [0.1, 0.2];
    });

    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).rejects.toThrow(/terminal mem0 import conflict.*content/i);

    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
    await expect(publicationCounts()).resolves.toEqual([1, 0]);
    await expect(ledgerFailure()).resolves.toEqual(expect.objectContaining({
      status: 'failed',
      cleanup_vector_id: null,
    }));
  });

  it('cleans a soft-deleted deterministic candidate once and acknowledges repeated deliveries terminally', async () => {
    await seedRequest('queued', Math.floor(Date.now() / 1000));
    await seedCanonicalMemory('request-1', await contentHash(item.memory), 2);
    const firstDelivery = queueMessage({ type: 'import-mem0-memory', requestId: 'request-1' });

    await handleMemoryQueue(queueBatch(firstDelivery), env);

    expect(firstDelivery.ack).toHaveBeenCalledOnce();
    expect(firstDelivery.retry).not.toHaveBeenCalled();
    expect(dependencies.deleteVector).toHaveBeenCalledOnce();
    expect(dependencies.deleteVector).toHaveBeenCalledWith(expect.anything(), 'request-1');
    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    await expect(ledgerFailure()).resolves.toEqual(expect.objectContaining({
      status: 'failed',
      attempt_count: 1,
      lease_token: 1,
      error_message: expect.stringMatching(/terminal mem0 import conflict.*soft-deleted/i),
      cleanup_vector_id: null,
    }));

    const repeatedDelivery = queueMessage({ type: 'import-mem0-memory', requestId: 'request-1' }, 2);
    await handleMemoryQueue(queueBatch(repeatedDelivery), env);

    expect(repeatedDelivery.ack).toHaveBeenCalledOnce();
    expect(repeatedDelivery.retry).not.toHaveBeenCalled();
    expect(dependencies.deleteVector).toHaveBeenCalledOnce();
    await expect(ledger()).resolves.toEqual({ status: 'failed', attempt_count: 1, lease_token: 1 });
    await expect(publicationCounts()).resolves.toEqual([1, 0]);
  });

  it('uses the persisted deterministic row timestamp when repairing history after time advances', async () => {
    await seedRequest('failed', Math.floor(Date.now() / 1000), 1, 1);
    await env.DB.prepare(`
      UPDATE mem0_import_requests SET item_json = ? WHERE request_id = 'request-1'
    `).bind(JSON.stringify({ memory: item.memory })).run();
    await seedCanonicalMemory('request-1', await contentHash(item.memory));
    await env.DB.prepare(`
      UPDATE memories SET created_at = 123 WHERE id = 'request-1'
    `).run();

    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).resolves.toBe('processed');

    await expect(env.DB.prepare(`
      SELECT created_at FROM memory_history WHERE memory_id = 'request-1'
    `).first()).resolves.toEqual({ created_at: 123 });
  });

  it('cleans an unmarked retry vector before completing against another canonical row', async () => {
    await seedRequest('failed', Math.floor(Date.now() / 1000), 1, 1);
    await seedCanonicalMemory('canonical-memory');

    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).resolves.toBe('processed');

    expect(dependencies.deleteVector).toHaveBeenCalledOnce();
    expect(dependencies.deleteVector).toHaveBeenCalledWith(expect.anything(), 'request-1');
    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    await expect(cleanupMarker()).resolves.toEqual({ cleanup_vector_id: null });
    await expect(publicationCounts()).resolves.toEqual([1, 0]);
  });

  it('keeps a unique-race loser failed until orphan cleanup succeeds on retry', async () => {
    await seedRequest('queued', Math.floor(Date.now() / 1000));
    const digest = await contentHash(item.memory);
    dependencies.upsertVectors.mockImplementationOnce(async () => {
      await seedCanonicalMemory('concurrent-canonical', digest);
      return { mutationId: 'mutation-1' };
    });
    dependencies.deleteVector
      .mockRejectedValueOnce(new Error('Vector cleanup unavailable'))
      .mockResolvedValueOnce(undefined);

    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).rejects.toThrow('Vector cleanup unavailable');

    await expect(ledger()).resolves.toEqual({ status: 'failed', attempt_count: 1, lease_token: 1 });
    await expect(cleanupMarker()).resolves.toEqual({ cleanup_vector_id: 'request-1' });
    await expect(publicationCounts()).resolves.toEqual([1, 0]);

    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).resolves.toBe('processed');

    expect(dependencies.deleteVector).toHaveBeenCalledTimes(2);
    expect(dependencies.upsertVectors).toHaveBeenCalledOnce();
    expect(dependencies.embedText).toHaveBeenCalledOnce();
    await expect(cleanupMarker()).resolves.toEqual({ cleanup_vector_id: null });
    await expect(ledger()).resolves.toEqual({ status: 'completed', attempt_count: 2, lease_token: 2 });
    await expect(publicationCounts()).resolves.toEqual([1, 0]);
  });

  it('retries a queue delivery when an insert conflict has no active exact winner', async () => {
    await seedRequest('queued', Math.floor(Date.now() / 1000));
    const digest = await contentHash(item.memory);
    dependencies.upsertVectors.mockImplementationOnce(async () => {
      await seedCanonicalMemory('hash-conflict', digest);
      await env.DB.prepare(`
        UPDATE memories SET content = 'Different content with the same synthetic digest'
        WHERE id = 'hash-conflict'
      `).run();
      return { mutationId: 'mutation-1' };
    });
    const delivery = queueMessage({ type: 'import-mem0-memory', requestId: 'request-1' });

    await handleMemoryQueue(queueBatch(delivery), env);

    expect(delivery.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(delivery.ack).not.toHaveBeenCalled();
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
    await expect(ledger()).resolves.toEqual({ status: 'failed', attempt_count: 1, lease_token: 1 });
    await expect(cleanupMarker()).resolves.toEqual({ cleanup_vector_id: 'request-1' });
    await expect(env.DB.prepare('SELECT COUNT(*) AS count FROM memory_history').first())
      .resolves.toEqual({ count: 0 });
  });

  it('reconciles a delayed stale upsert after a replacement completes against another canonical', async () => {
    await seedRequest('queued', Math.floor(Date.now() / 1000));
    let releaseOldUpsert!: () => void;
    const oldUpsertReleased = new Promise<void>((resolve) => {
      releaseOldUpsert = resolve;
    });
    const events: string[] = [];
    dependencies.upsertVectors.mockImplementationOnce(async () => {
      events.push('old-upsert-started');
      await oldUpsertReleased;
      events.push('old-upsert-finished');
      return { mutationId: 'old-mutation' };
    });
    dependencies.deleteVector.mockImplementation(async () => {
      events.push('candidate-deleted');
    });

    const oldWorker = processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    });
    await vi.waitFor(() => expect(events).toContain('old-upsert-started'));

    await seedCanonicalMemory('replacement-canonical', await contentHash(item.memory));
    await env.DB.prepare(`
      UPDATE mem0_import_requests SET updated_at = 0 WHERE request_id = 'request-1'
    `).run();
    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).resolves.toBe('processed');
    events.push('replacement-completed');

    releaseOldUpsert();
    await expect(oldWorker).resolves.toBe('inflight');

    expect(events).toEqual([
      'old-upsert-started',
      'candidate-deleted',
      'replacement-completed',
      'old-upsert-finished',
      'candidate-deleted',
    ]);
    expect(dependencies.deleteVector).toHaveBeenCalledTimes(2);
    await expect(ledger()).resolves.toEqual({ status: 'completed', attempt_count: 2, lease_token: 2 });
    await expect(cleanupMarker()).resolves.toEqual({ cleanup_vector_id: null });
    await expect(publicationCounts()).resolves.toEqual([1, 0]);
  });

  it('re-arms cleanup when a stale upsert lands during replacement pending cleanup', async () => {
    await seedRequest('queued', Math.floor(Date.now() / 1000));
    const vectors = new Set<string>();
    const events: string[] = [];
    let releaseOldUpsert!: () => void;
    const oldUpsertReleased = new Promise<void>((resolve) => {
      releaseOldUpsert = resolve;
    });
    let oldWorker!: Promise<unknown>;
    let deleteCount = 0;
    dependencies.upsertVectors.mockImplementationOnce(async (_index, pending) => {
      events.push('old-upsert-started');
      await oldUpsertReleased;
      vectors.add(pending[0].id);
      events.push('old-upsert-finished');
      return { mutationId: 'old-mutation' };
    });
    dependencies.deleteVector.mockImplementation(async (_index, vectorId) => {
      deleteCount += 1;
      vectors.delete(vectorId);
      events.push(`replacement-delete-${deleteCount}`);
      if (deleteCount === 1) {
        releaseOldUpsert();
        await oldWorker;
        events.push('old-reconciled');
      }
    });

    oldWorker = processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    });
    await vi.waitFor(() => expect(events).toContain('old-upsert-started'));

    await seedCanonicalMemory('replacement-canonical', await contentHash(item.memory));
    await env.DB.prepare(`
      UPDATE mem0_import_requests SET updated_at = 0 WHERE request_id = 'request-1'
    `).run();
    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).resolves.toBe('processed');

    expect(events).toEqual([
      'old-upsert-started',
      'replacement-delete-1',
      'old-upsert-finished',
      'old-reconciled',
      'replacement-delete-2',
    ]);
    expect(vectors).toEqual(new Set());
    await expect(cleanupState()).resolves.toEqual({
      cleanup_vector_id: null,
      cleanup_vector_generation: 2,
    });
    await expect(ledger()).resolves.toEqual({ status: 'completed', attempt_count: 2, lease_token: 2 });
  });

  it('persists re-armed cleanup across failure and consumes it on retry', async () => {
    await seedRequest('queued', Math.floor(Date.now() / 1000));
    const vectors = new Set<string>();
    let releaseOldUpsert!: () => void;
    const oldUpsertReleased = new Promise<void>((resolve) => {
      releaseOldUpsert = resolve;
    });
    let oldWorker!: Promise<unknown>;
    let deleteCount = 0;
    dependencies.upsertVectors.mockImplementationOnce(async (_index, pending) => {
      await oldUpsertReleased;
      vectors.add(pending[0].id);
      return { mutationId: 'old-mutation' };
    });
    dependencies.deleteVector.mockImplementation(async (_index, vectorId) => {
      deleteCount += 1;
      if (deleteCount === 1) {
        vectors.delete(vectorId);
        releaseOldUpsert();
        await oldWorker;
        return;
      }
      if (deleteCount === 2) {
        await expect(cleanupState()).resolves.toEqual({
          cleanup_vector_id: 'request-1',
          cleanup_vector_generation: 2,
        });
        throw new Error('Vector cleanup crashed after stale intent was re-armed');
      }
      vectors.delete(vectorId);
    });

    oldWorker = processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    });
    await vi.waitFor(() => expect(dependencies.upsertVectors).toHaveBeenCalledOnce());

    await seedCanonicalMemory('replacement-canonical', await contentHash(item.memory));
    await env.DB.prepare(`
      UPDATE mem0_import_requests SET updated_at = 0 WHERE request_id = 'request-1'
    `).run();
    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).rejects.toThrow('Vector cleanup crashed after stale intent was re-armed');

    expect(vectors).toEqual(new Set(['request-1']));
    await expect(cleanupState()).resolves.toEqual({
      cleanup_vector_id: 'request-1',
      cleanup_vector_generation: 2,
    });
    await expect(ledger()).resolves.toEqual({ status: 'failed', attempt_count: 2, lease_token: 2 });

    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).resolves.toBe('processed');

    expect(vectors).toEqual(new Set());
    expect(dependencies.deleteVector).toHaveBeenCalledTimes(3);
    await expect(cleanupState()).resolves.toEqual({
      cleanup_vector_id: null,
      cleanup_vector_generation: 2,
    });
    await expect(ledger()).resolves.toEqual({ status: 'completed', attempt_count: 3, lease_token: 3 });
  });

  it('reclaims a completed ledger row when a crash leaves re-armed cleanup pending', async () => {
    await seedRequest('queued', Math.floor(Date.now() / 1000));
    await seedCanonicalMemory('replacement-canonical', await contentHash(item.memory));
    await env.DB.prepare(`
      UPDATE mem0_import_requests
      SET status = 'completed', cleanup_vector_id = 'request-1',
          cleanup_vector_generation = 2, completed_at = unixepoch()
      WHERE request_id = 'request-1'
    `).run();

    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).resolves.toBe('processed');

    expect(dependencies.deleteVector).toHaveBeenCalledOnce();
    expect(dependencies.deleteVector).toHaveBeenCalledWith(expect.anything(), 'request-1');
    await expect(cleanupState()).resolves.toEqual({
      cleanup_vector_id: null,
      cleanup_vector_generation: 2,
    });
    await expect(ledger()).resolves.toEqual({ status: 'completed', attempt_count: 1, lease_token: 1 });
    await expect(publicationCounts()).resolves.toEqual([1, 0]);
  });

  it('preserves a late stale upsert when the replacement built the deterministic row', async () => {
    await seedRequest('queued', Math.floor(Date.now() / 1000));
    const vectors = new Set<string>();
    let releaseOldUpsert!: () => void;
    const oldUpsertReleased = new Promise<void>((resolve) => {
      releaseOldUpsert = resolve;
    });
    dependencies.upsertVectors
      .mockImplementationOnce(async (_index, pending) => {
        await oldUpsertReleased;
        vectors.add(pending[0].id);
        return { mutationId: 'old-mutation' };
      })
      .mockImplementationOnce(async (_index, pending) => {
        vectors.add(pending[0].id);
        return { mutationId: 'replacement-mutation' };
      });
    dependencies.deleteVector.mockImplementation(async (_index, vectorId) => {
      vectors.delete(vectorId);
    });

    const oldWorker = processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    });
    await vi.waitFor(() => expect(dependencies.upsertVectors).toHaveBeenCalledOnce());

    await env.DB.prepare(`
      UPDATE mem0_import_requests SET updated_at = 0 WHERE request_id = 'request-1'
    `).run();
    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).resolves.toBe('processed');

    releaseOldUpsert();
    await expect(oldWorker).resolves.toBe('inflight');

    expect(vectors).toEqual(new Set(['request-1']));
    expect(dependencies.deleteVector).toHaveBeenCalledOnce();
    await expect(cleanupState()).resolves.toEqual({
      cleanup_vector_id: null,
      cleanup_vector_generation: 2,
    });
    await expect(ledger()).resolves.toEqual({ status: 'completed', attempt_count: 2, lease_token: 2 });
    await expect(publicationCounts()).resolves.toEqual([1, 1]);
  });

  it('cannot publish D1 rows after its lease is replaced during Vectorize mutation', async () => {
    await seedRequest('queued', Math.floor(Date.now() / 1000));
    dependencies.upsertVectors.mockImplementation(async () => {
      await env.DB.prepare(`
        UPDATE mem0_import_requests SET lease_token = lease_token + 1 WHERE request_id = 'request-1'
      `).run();
      return { mutationId: 'mutation-1' };
    });

    await expect(processMem0ImportJob(env, {
      type: 'import-mem0-memory', requestId: 'request-1',
    })).resolves.toBe('inflight');

    await expect(publicationCounts()).resolves.toEqual([0, 0]);
    await expect(ledger()).resolves.toEqual({ status: 'processing', attempt_count: 1, lease_token: 2 });
  });

  it('recovers a Queue send that succeeded before the published marker was committed', async () => {
    const firstDispatchAt = Math.floor(Date.now() / 1000);
    await seedRequest('queued', firstDispatchAt);
    const delivered: MemoryJob[] = [];
    const memoryJobs = {
      sendBatch: vi.fn(async (entries: MessageSendRequest<MemoryJob>[]) => {
        delivered.push(...entries.map(({ body }) => body));
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      }),
    };
    const dbWithFailedPublishMarker = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: vi.fn().mockRejectedValue(new Error('D1 publication marker unavailable')),
    } as unknown as D1Database;

    await expect(dispatchPendingMem0Imports({
      ...env,
      DB: dbWithFailedPublishMarker,
      MEMORY_JOBS: memoryJobs,
    } as unknown as Env, firstDispatchAt)).rejects.toThrow('publication marker unavailable');

    await expect(env.DB.prepare(`
      SELECT publish_token, publish_attempted_at, published_at
      FROM mem0_import_requests WHERE request_id = 'request-1'
    `).first()).resolves.toEqual({
      publish_token: 1,
      publish_attempted_at: firstDispatchAt,
      published_at: null,
    });

    await expect(dispatchPendingMem0Imports({
      ...env,
      MEMORY_JOBS: memoryJobs,
    } as unknown as Env, firstDispatchAt + 301)).resolves.toBe(1);
    expect(delivered).toHaveLength(2);

    await expect(processMem0ImportJob(env, delivered[0] as Extract<MemoryJob, { type: 'import-mem0-memory' }>))
      .resolves.toBe('processed');
    await expect(processMem0ImportJob(env, delivered[1] as Extract<MemoryJob, { type: 'import-mem0-memory' }>))
      .resolves.toBe('noop');

    await expect(ledger()).resolves.toEqual({ status: 'completed', attempt_count: 1, lease_token: 1 });
    await expect(publicationCounts()).resolves.toEqual([1, 1]);
  });

  it('retries a real 40041 failure through the Queue handler and publishes exactly once', async () => {
    await seedRequest('queued', Math.floor(Date.now() / 1000));
    const body = { type: 'import-mem0-memory' as const, requestId: 'request-1' };
    const firstDelivery = queueMessage(body);
    dependencies.upsertVectors.mockRejectedValueOnce(Object.assign(
      new Error('VECTOR_UPSERT_ERROR (code = 40041): Too Many Requests'),
      { status: 400, code: 40041 },
    ));

    await handleMemoryQueue(queueBatch(firstDelivery), env);

    expect(firstDelivery.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(firstDelivery.ack).not.toHaveBeenCalled();
    await expect(ledger()).resolves.toEqual({ status: 'failed', attempt_count: 1, lease_token: 1 });
    await expect(publicationCounts()).resolves.toEqual([0, 0]);

    const secondDelivery = queueMessage(body, 2);
    dependencies.upsertVectors.mockResolvedValueOnce({ mutationId: 'mutation-2' });
    await handleMemoryQueue(queueBatch(secondDelivery), env);

    expect(secondDelivery.ack).toHaveBeenCalledOnce();
    expect(secondDelivery.retry).not.toHaveBeenCalled();
    await expect(ledger()).resolves.toEqual({ status: 'completed', attempt_count: 2, lease_token: 2 });
    await expect(publicationCounts()).resolves.toEqual([1, 1]);
  });
});
