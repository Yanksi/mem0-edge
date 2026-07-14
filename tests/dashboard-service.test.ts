/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as workerEnv, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getDashboardDeduplicationSummary,
  listDashboardDuplicateMemoryIds,
  softDeleteDashboardMemories,
} from '../src/dashboard/service';
import type { Env } from '../src/env';

const env = workerEnv as unknown as Env;

afterEach(async () => {
  await reset();
});

beforeEach(async () => {
  await env.DB.prepare('CREATE TABLE memories (id TEXT PRIMARY KEY NOT NULL, user_id TEXT, agent_id TEXT, content TEXT NOT NULL, metadata_json TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)').run();
  await env.DB.prepare('CREATE TABLE memory_history (id TEXT PRIMARY KEY NOT NULL, memory_id TEXT NOT NULL, operation TEXT NOT NULL, content TEXT NOT NULL, metadata_json TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL)').run();
});

async function seedMemory({
  id,
  content,
  userId = null,
  agentId = null,
  createdAt,
  deletedAt = null,
}: {
  id: string;
  content: string;
  userId?: string | null;
  agentId?: string | null;
  createdAt: number;
  deletedAt?: number | null;
}): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO memories (id, user_id, agent_id, content, metadata_json, hash, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?)
  `).bind(id, userId, agentId, content, id, createdAt, createdAt, deletedAt).run();
}

describe('dashboard exact-text deduplication', () => {
  it('summarizes active user-only exact-text groups with case-insensitive preview ordering', async () => {
    await seedMemory({ id: 'alpha-1', userId: 'user-1', content: 'Alpha', createdAt: 1 });
    await seedMemory({ id: 'alpha-2', userId: 'user-1', content: 'Alpha', createdAt: 2 });
    await seedMemory({ id: 'zebra-1', userId: 'user-1', content: 'zebra', createdAt: 1 });
    await seedMemory({ id: 'zebra-2', userId: 'user-1', content: 'zebra', createdAt: 2 });
    await seedMemory({ id: 'zebra-3', userId: 'user-1', content: 'zebra', createdAt: 3 });
    await seedMemory({ id: 'case-only', userId: 'user-1', content: 'alpha', createdAt: 1 });
    await seedMemory({ id: 'whitespace-only', userId: 'user-1', content: ' zebra', createdAt: 1 });
    await seedMemory({ id: 'deleted-alpha', userId: 'user-1', content: 'Alpha', createdAt: 0, deletedAt: 99 });
    await seedMemory({ id: 'agent-alpha-1', agentId: 'user-1', content: 'Alpha', createdAt: 0 });
    await seedMemory({ id: 'agent-alpha-2', agentId: 'user-1', content: 'Alpha', createdAt: 1 });

    await expect(getDashboardDeduplicationSummary(env, 'user', 'user-1')).resolves.toEqual({
      duplicate_groups: 2,
      removable_memories: 3,
      previews: [
        { memory: 'Alpha', duplicate_count: 1 },
        { memory: 'zebra', duplicate_count: 2 },
      ],
    });
  });

  it('selects later user duplicates by creation time and id without crossing into agent scope', async () => {
    await seedMemory({ id: 'b-tie', userId: 'shared', content: 'Exact', createdAt: 10 });
    await seedMemory({ id: 'a-tie', userId: 'shared', content: 'Exact', createdAt: 10 });
    await seedMemory({ id: 'later-user', userId: 'shared', content: 'Exact', createdAt: 11 });
    await seedMemory({ id: 'deleted-user', userId: 'shared', content: 'Exact', createdAt: 1, deletedAt: 2 });
    await seedMemory({ id: 'agent-canonical', agentId: 'shared', content: 'Exact', createdAt: 1 });
    await seedMemory({ id: 'agent-later', agentId: 'shared', content: 'Exact', createdAt: 2 });

    await expect(listDashboardDuplicateMemoryIds(env, 'user', 'shared')).resolves.toEqual(['b-tie', 'later-user']);
    await expect(listDashboardDuplicateMemoryIds(env, 'agent', 'shared')).resolves.toEqual(['agent-later']);
  });

  it('soft-deletes only selected scoped duplicates, preserves history, and is idempotent', async () => {
    await seedMemory({ id: 'canonical', userId: 'scope', content: 'Same', createdAt: 1 });
    await seedMemory({ id: 'duplicate', userId: 'scope', content: 'Same', createdAt: 2 });
    await seedMemory({ id: 'agent-duplicate', agentId: 'scope', content: 'Same', createdAt: 2 });
    await env.DB.prepare(`
      INSERT INTO memory_history (id, memory_id, operation, content, metadata_json, hash, created_at)
      VALUES ('history-1', 'duplicate', 'ADD', 'Same', '{}', 'history-hash', 2)
    `).run();

    expect(await softDeleteDashboardMemories(env, 'user', 'scope', ['duplicate', 'agent-duplicate'])).toBe(1);
    expect(await listDashboardDuplicateMemoryIds(env, 'user', 'scope')).toEqual([]);
    expect(await softDeleteDashboardMemories(env, 'user', 'scope', ['duplicate'])).toBe(0);

    await expect(env.DB.prepare('SELECT deleted_at FROM memories WHERE id = ?').bind('duplicate').first<{ deleted_at: number | null }>())
      .resolves.toEqual(expect.objectContaining({ deleted_at: expect.any(Number) }));
    await expect(env.DB.prepare('SELECT deleted_at FROM memories WHERE id = ?').bind('agent-duplicate').first<{ deleted_at: number | null }>())
      .resolves.toEqual({ deleted_at: null });
    await expect(env.DB.prepare('SELECT COUNT(*) AS count FROM memory_history WHERE memory_id = ?').bind('duplicate').first<{ count: number }>())
      .resolves.toEqual({ count: 1 });
    await expect(softDeleteDashboardMemories(env, 'user', 'scope', [])).resolves.toBe(0);
  });

  it('rejects canonical and unique IDs even when they are supplied with a valid later duplicate', async () => {
    await seedMemory({ id: 'canonical', userId: 'scope', content: 'Same', createdAt: 1 });
    await seedMemory({ id: 'later-duplicate', userId: 'scope', content: 'Same', createdAt: 2 });
    await seedMemory({ id: 'unique', userId: 'scope', content: 'Different', createdAt: 1 });

    await expect(softDeleteDashboardMemories(env, 'user', 'scope', ['canonical', 'unique', 'later-duplicate'])).resolves.toBe(1);
    await expect(env.DB.prepare('SELECT id FROM memories WHERE deleted_at IS NOT NULL ORDER BY id').all<{ id: string }>())
      .resolves.toEqual({ results: [{ id: 'later-duplicate' }], success: true, meta: expect.any(Object) });
  });

  it('soft-deletes more than 99 valid later duplicates in batches', async () => {
    await seedMemory({ id: 'canonical', userId: 'scope', content: 'Same', createdAt: 1 });
    const ids = Array.from({ length: 100 }, (_, index) => `duplicate-${index}`);
    for (const [index, id] of ids.entries()) {
      await seedMemory({ id, userId: 'scope', content: 'Same', createdAt: index + 2 });
    }

    await expect(softDeleteDashboardMemories(env, 'user', 'scope', ids)).resolves.toBe(100);
    await expect(env.DB.prepare('SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NOT NULL').first<{ count: number }>())
      .resolves.toEqual({ count: 100 });
    await expect(env.DB.prepare('SELECT deleted_at FROM memories WHERE id = ?').bind('canonical').first<{ deleted_at: number | null }>())
      .resolves.toEqual({ deleted_at: null });
  });
});
