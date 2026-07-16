/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as workerEnv, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  embedText: vi.fn(),
  upsertVectors: vi.fn(),
  getSemanticDedupEnabled: vi.fn(),
  setSemanticDedupEnabled: vi.fn(),
}));

vi.mock('../src/llm', () => ({ embedText: dependencies.embedText }));
vi.mock('../src/vectorize', () => ({ upsertVectors: dependencies.upsertVectors }));
vi.mock('../src/settings/service', () => ({
  getSemanticDedupEnabled: dependencies.getSemanticDedupEnabled,
  setSemanticDedupEnabled: dependencies.setSemanticDedupEnabled,
}));

import {
  getDashboardSettings,
  reindexDashboardMemory,
  setDashboardSettings,
} from '../src/dashboard/service';
import type { Env } from '../src/env';
import { scopeKey } from '../src/memory/identity';

const env = workerEnv as unknown as Env;

afterEach(async () => {
  await reset();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await env.DB.prepare('CREATE TABLE memories (id TEXT PRIMARY KEY NOT NULL, user_id TEXT, agent_id TEXT, run_id TEXT, actor_id TEXT, content TEXT NOT NULL, metadata_json TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)').run();
  await env.DB.prepare('CREATE TABLE memory_history (id TEXT PRIMARY KEY NOT NULL, memory_id TEXT NOT NULL, operation TEXT NOT NULL, content TEXT NOT NULL, metadata_json TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL)').run();
});

async function seedMemory({
  id,
  content,
  userId = null,
  agentId = null,
  runId = null,
  actorId = null,
  metadata = {},
  createdAt,
  deletedAt = null,
}: {
  id: string;
  content: string;
  userId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: number;
  deletedAt?: number | null;
}): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO memories (id, user_id, agent_id, run_id, actor_id, content, metadata_json, hash, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, userId, agentId, runId, actorId, content, JSON.stringify(metadata), id, createdAt, createdAt, deletedAt).run();
}

describe('dashboard memory reindexing', () => {
  it('uses shared vector metadata including the exact paired owner scope key', async () => {
    const testEnv = { DB: env.DB, VECTORIZE: {} as VectorizeIndex } as Env;
    await seedMemory({
      id: 'paired-memory',
      userId: 'user-1',
      agentId: 'agent-1',
      runId: 'run-1',
      actorId: 'actor-1',
      content: 'Remember the paired scope.',
      metadata: {
        label: 'important',
        score: 0.75,
        ignoredNull: null,
        ignoredObject: { nested: true },
        user_id: 'spoofed-user',
        scope_key: 'spoofed-scope',
      },
      createdAt: 1,
    });
    dependencies.embedText.mockResolvedValue([0.25, 0.75]);

    await expect(reindexDashboardMemory(testEnv, 'user', 'user-1', 'paired-memory')).resolves.toBe(true);

    expect(dependencies.embedText.mock.calls[0][1]).toBe('Remember the paired scope.');
    expect(dependencies.upsertVectors.mock.calls[0][0]).toBe(testEnv.VECTORIZE);
    expect(dependencies.upsertVectors.mock.calls[0][1]).toEqual([{
      id: 'paired-memory',
      values: [0.25, 0.75],
      metadata: {
        label: 'important',
        score: 0.75,
        user_id: 'user-1',
        agent_id: 'agent-1',
        run_id: 'run-1',
        actor_id: 'actor-1',
        scope_key: await scopeKey({ userId: 'user-1', agentId: 'agent-1' }),
      },
    }]);
  });
});

describe('dashboard settings', () => {
  it('returns only the semantic deduplication setting from the shared settings service', async () => {
    dependencies.getSemanticDedupEnabled.mockResolvedValue(true);

    await expect(getDashboardSettings(env)).resolves.toEqual({ semantic_dedup_enabled: true });
    expect(dependencies.getSemanticDedupEnabled).toHaveBeenCalledWith(env);
  });

  it('persists and returns the semantic deduplication setting through the shared settings service', async () => {
    dependencies.setSemanticDedupEnabled.mockResolvedValue(undefined);

    await expect(setDashboardSettings(env, false)).resolves.toEqual({ semantic_dedup_enabled: false });
    expect(dependencies.setSemanticDedupEnabled).toHaveBeenCalledWith(env, false);
  });
});
