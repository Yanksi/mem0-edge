/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as workerEnv, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { contentHash, scopeKey, type MemoryOwnerScope } from '../src/memory/identity';

const dependencies = vi.hoisted(() => ({
  assertDedupLlmConfigured: vi.fn(),
  embedText: vi.fn(),
  getSemanticDedupEnabled: vi.fn(),
  searchDeduplicationCandidates: vi.fn(),
  selectSemanticDuplicate: vi.fn(),
}));

vi.mock('../src/settings/service', () => ({
  assertDedupLlmConfigured: dependencies.assertDedupLlmConfigured,
  getSemanticDedupEnabled: dependencies.getSemanticDedupEnabled,
}));
vi.mock('../src/llm', () => ({ embedText: dependencies.embedText }));
vi.mock('../src/vectorize', () => ({
  searchDeduplicationCandidates: dependencies.searchDeduplicationCandidates,
}));
vi.mock('../src/memory/deduplication-llm', () => ({
  selectSemanticDuplicate: dependencies.selectSemanticDuplicate,
}));

import {
  findActiveExactMemory,
  prepareMemoryWrite,
  type MemoryRow,
} from '../src/memory/deduplication';

const env = workerEnv as unknown as Env;
const configuredEnv = (overrides: Partial<Env> = {}) => ({
  ...env,
  DEDUP_LLM_API_BASE_URL: 'https://dedup.example/v1',
  DEDUP_LLM_MODEL: 'dedup-model',
  DEDUP_LLM_API_KEY: 'dedup-secret',
  ...overrides,
}) as Env;

interface SeedMemoryOptions {
  id: string;
  content: string;
  userId?: string | null;
  agentId?: string | null;
  contentHash?: string | null;
  deletedAt?: number | null;
  createdAt?: number;
}

beforeEach(async () => {
  vi.clearAllMocks();
  dependencies.assertDedupLlmConfigured.mockImplementation(() => undefined);
  dependencies.embedText.mockResolvedValue([0.1, 0.2]);
  dependencies.getSemanticDedupEnabled.mockResolvedValue(false);
  dependencies.searchDeduplicationCandidates.mockResolvedValue([]);
  dependencies.selectSemanticDuplicate.mockResolvedValue(null);

  await env.DB.prepare(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      agent_id TEXT,
      run_id TEXT,
      actor_id TEXT,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      hash TEXT NOT NULL,
      content_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      mutation_version INTEGER NOT NULL DEFAULT 0,
      last_mutation_id TEXT
    )
  `).run();
  await env.DB.prepare(`
    CREATE INDEX memories_active_user_agent_content_hash_lookup_idx
      ON memories (user_id, agent_id, content_hash)
      WHERE deleted_at IS NULL AND user_id IS NOT NULL AND agent_id IS NOT NULL
  `).run();
  await env.DB.prepare(`
    CREATE INDEX memories_active_user_content_hash_lookup_idx
      ON memories (user_id, content_hash)
      WHERE deleted_at IS NULL AND user_id IS NOT NULL AND agent_id IS NULL
  `).run();
  await env.DB.prepare(`
    CREATE INDEX memories_active_agent_content_hash_lookup_idx
      ON memories (agent_id, content_hash)
      WHERE deleted_at IS NULL AND user_id IS NULL AND agent_id IS NOT NULL
  `).run();
});

afterEach(async () => {
  await reset();
});

describe('findActiveExactMemory', () => {
  it('finds a phase-one null hash by raw content and conditionally backfills the digest', async () => {
    const content = 'The launch date is October 8.';
    const digest = await contentHash(content);
    await seedMemory({
      id: 'memory-null-hash',
      content,
      userId: 'user-1',
      agentId: null,
      contentHash: null,
    });

    await expect(findActiveExactMemory(
      env,
      { userId: 'user-1', agentId: null },
      content,
      digest,
    )).resolves.toMatchObject({ id: 'memory-null-hash', contentHash: digest });
    await expect(env.DB.prepare(
      'SELECT content_hash FROM memories WHERE id = ?',
    ).bind('memory-null-hash').first()).resolves.toEqual({ content_hash: digest });
  });

  it('uses one ordered lookup for matching and phase-one hashes', async () => {
    const content = 'The launch date is October 8.';
    const digest = await contentHash(content);
    const lookupQueries: string[] = [];
    await seedMemory({
      id: 'memory-null-hash',
      content,
      userId: 'user-1',
      contentHash: null,
    });
    const observedEnv = withPreparedQueryObserver((query) => {
      if (query.startsWith('select') && query.includes('from "memories"')) {
        lookupQueries.push(query);
      }
    });

    await findActiveExactMemory(
      observedEnv,
      { userId: 'user-1', agentId: null },
      content,
      digest,
    );

    expect(lookupQueries).toHaveLength(1);
    expect(lookupQueries[0]).toContain(
      '("memories"."content_hash" = ? or "memories"."content_hash" is null)',
    );
    expect(lookupQueries[0]).toContain(
      'order by "memories"."created_at" asc, "memories"."id" asc limit ?',
    );
  });

  it('canonically selects the oldest row across mixed matching and null hashes', async () => {
    const content = 'The launch date is October 8.';
    const digest = await contentHash(content);
    await seedMemory({
      id: 'newer-hashed',
      content,
      userId: 'user-1',
      contentHash: digest,
      createdAt: 20,
    });
    await seedMemory({
      id: 'older-null',
      content,
      userId: 'user-1',
      contentHash: null,
      createdAt: 10,
    });

    await expect(findActiveExactMemory(
      env,
      { userId: 'user-1', agentId: null },
      content,
      digest,
    )).resolves.toMatchObject({ id: 'older-null', contentHash: digest });
    await expect(env.DB.prepare(
      'SELECT content_hash FROM memories WHERE id = ?',
    ).bind('older-null').first()).resolves.toEqual({ content_hash: digest });
  });

  it.each([
    ['deleted', 'UPDATE memories SET deleted_at = ? WHERE id = ?', { deleted_at: 12 }],
    ['moved to another owner', 'UPDATE memories SET user_id = ? WHERE id = ?', { user_id: 'user-2' }],
    ['changed to different content', 'UPDATE memories SET content = ? WHERE id = ?', { content: 'Changed concurrently' }],
  ] as const)('does not return a phase-one row that is %s before backfill', async (_label, sql, changed) => {
    const content = 'The launch date is October 8.';
    const digest = await contentHash(content);
    await seedMemory({
      id: 'memory-raced',
      content,
      userId: 'user-1',
      agentId: null,
      contentHash: null,
    });
    const racedEnv = withMutationBeforeBackfill(async () => {
      const value = Object.values(changed)[0];
      await env.DB.prepare(sql).bind(value, 'memory-raced').run();
    });

    await expect(findActiveExactMemory(
      racedEnv,
      { userId: 'user-1', agentId: null },
      content,
      digest,
    )).resolves.toBeUndefined();
    await expect(env.DB.prepare(
      'SELECT content_hash FROM memories WHERE id = ?',
    ).bind('memory-raced').first()).resolves.toEqual({ content_hash: null });
  });

  it('does not overwrite or return a concurrently populated different digest', async () => {
    const content = 'The launch date is October 8.';
    const digest = await contentHash(content);
    await seedMemory({
      id: 'memory-raced',
      content,
      userId: 'user-1',
      contentHash: null,
    });
    const racedEnv = withMutationBeforeBackfill(async () => {
      await env.DB.prepare(
        'UPDATE memories SET content_hash = ? WHERE id = ?',
      ).bind('different-digest', 'memory-raced').run();
    });

    await expect(findActiveExactMemory(
      racedEnv,
      { userId: 'user-1', agentId: null },
      content,
      digest,
    )).resolves.toBeUndefined();
    await expect(env.DB.prepare(
      'SELECT content_hash FROM memories WHERE id = ?',
    ).bind('memory-raced').first()).resolves.toEqual({ content_hash: 'different-digest' });
  });

  it('honors exclusions, active state, raw equality, and null/value ownership semantics', async () => {
    const content = 'The office is in Zurich.';
    const digest = await contentHash(content);
    await seedMemory({ id: 'user-first', content, userId: 'user-1', contentHash: digest });
    await seedMemory({ id: 'user-second', content, userId: 'user-1', contentHash: digest });
    await seedMemory({ id: 'paired', content, userId: 'user-1', agentId: 'agent-1', contentHash: digest });
    await seedMemory({ id: 'agent-only', content, agentId: 'agent-1', contentHash: digest });
    await seedMemory({ id: 'ownerless', content, contentHash: digest });
    await seedMemory({ id: 'deleted', content, userId: 'user-1', contentHash: digest, deletedAt: 12 });
    await seedMemory({ id: 'collision', content: 'Different raw content', userId: 'user-2', contentHash: digest });

    await expect(findActiveExactMemory(
      env,
      { userId: 'user-1', agentId: null },
      content,
      digest,
      'user-first',
    )).resolves.toMatchObject({ id: 'user-second' });
    await expect(findActiveExactMemory(
      env,
      { userId: 'user-1', agentId: 'agent-1' },
      content,
      digest,
    )).resolves.toMatchObject({ id: 'paired' });
    await expect(findActiveExactMemory(
      env,
      { userId: null, agentId: 'agent-1' },
      content,
      digest,
    )).resolves.toMatchObject({ id: 'agent-only' });
    await expect(findActiveExactMemory(
      env,
      { userId: null, agentId: null },
      content,
      digest,
    )).resolves.toMatchObject({ id: 'ownerless' });
    await expect(findActiveExactMemory(
      env,
      { userId: 'user-2', agentId: null },
      content,
      digest,
    )).resolves.toBeUndefined();
  });
});

describe('prepareMemoryWrite', () => {
  it('returns an exact duplicate before settings, embedding, Vectorize, or LLM work', async () => {
    const scope = { userId: 'user-1', agentId: 'agent-1' };
    const content = 'The launch date is October 8.';
    const digest = await contentHash(content);
    await seedMemory({ id: 'exact', content, ...scope, contentHash: digest });

    await expect(prepareMemoryWrite(configuredEnv(), scope, content)).resolves.toMatchObject({
      contentHash: digest,
      exactScopeKey: await scopeKey(scope),
      duplicate: { id: 'exact', content },
    });
    expect(dependencies.getSemanticDedupEnabled).not.toHaveBeenCalled();
    expect(dependencies.assertDedupLlmConfigured).not.toHaveBeenCalled();
    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.searchDeduplicationCandidates).not.toHaveBeenCalled();
    expect(dependencies.selectSemanticDuplicate).not.toHaveBeenCalled();
  });

  it('returns hash and exact scope without embedding when semantic deduplication is disabled', async () => {
    const scope = { userId: 'user-1', agentId: null };
    const content = 'The office is in Zurich.';

    await expect(prepareMemoryWrite(env, scope, content)).resolves.toEqual({
      contentHash: await contentHash(content),
      exactScopeKey: await scopeKey(scope),
    });
    expect(dependencies.getSemanticDedupEnabled).toHaveBeenCalledWith(env);
    expect(dependencies.assertDedupLlmConfigured).not.toHaveBeenCalled();
    expect(dependencies.embedText).not.toHaveBeenCalled();
  });

  it('validates semantic configuration before embedding', async () => {
    dependencies.getSemanticDedupEnabled.mockResolvedValue(true);
    dependencies.assertDedupLlmConfigured.mockImplementation(() => {
      throw new Error('missing semantic configuration');
    });

    await expect(prepareMemoryWrite(
      configuredEnv(),
      { userId: 'user-1', agentId: null },
      'A new memory.',
    )).rejects.toThrow('missing semantic configuration');
    expect(dependencies.assertDedupLlmConfigured).toHaveBeenCalledOnce();
    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.searchDeduplicationCandidates).not.toHaveBeenCalled();
  });

  it('embeds once, caps an oversized limit, filters below 0.85, and skips LLM with no survivors', async () => {
    const scope = { userId: 'user-1', agentId: null };
    const content = 'A new durable memory.';
    const embedding = [0.3, 0.4];
    dependencies.getSemanticDedupEnabled.mockResolvedValue(true);
    dependencies.embedText.mockResolvedValue(embedding);
    dependencies.searchDeduplicationCandidates.mockResolvedValue([
      { id: 'below-threshold', score: 0.8499 },
    ]);
    await seedMemory({
      id: 'below-threshold',
      content: 'A similar old memory.',
      userId: 'user-1',
      contentHash: await contentHash('A similar old memory.'),
    });

    await expect(prepareMemoryWrite(
      configuredEnv({ DEDUP_CANDIDATE_LIMIT: '200' }),
      scope,
      content,
    )).resolves.toEqual({
      contentHash: await contentHash(content),
      exactScopeKey: await scopeKey(scope),
      embedding,
    });
    expect(dependencies.assertDedupLlmConfigured).toHaveBeenCalledOnce();
    expect(dependencies.embedText).toHaveBeenCalledOnce();
    expect(dependencies.embedText).toHaveBeenCalledWith(expect.anything(), content);
    expect(dependencies.assertDedupLlmConfigured.mock.invocationCallOrder[0])
      .toBeLessThan(dependencies.embedText.mock.invocationCallOrder[0]);
    expect(dependencies.searchDeduplicationCandidates.mock.calls[0][0] === env.VECTORIZE).toBe(true);
    expect(dependencies.searchDeduplicationCandidates).toHaveBeenCalledWith(
      expect.anything(),
      embedding,
      await scopeKey(scope),
      20,
    );
    expect(dependencies.selectSemanticDuplicate).not.toHaveBeenCalled();
  });

  it('revalidates active exact scope in D1 and sends only opaque refs and text to the LLM', async () => {
    const scope = { userId: 'user-1', agentId: null };
    dependencies.getSemanticDedupEnabled.mockResolvedValue(true);
    dependencies.searchDeduplicationCandidates.mockResolvedValue([
      { id: 'deleted', score: 0.99 },
      { id: 'wrong-user', score: 0.98 },
      { id: 'survivor-two', score: 0.97 },
      { id: 'wrong-agent', score: 0.96 },
      { id: 'survivor-one', score: 0.95 },
      { id: 'stale-vector', score: 0.94 },
    ]);
    await seedMemory({ id: 'deleted', content: 'Deleted', ...scope, deletedAt: 5 });
    await seedMemory({ id: 'wrong-user', content: 'Wrong user', userId: 'user-2' });
    await seedMemory({ id: 'survivor-one', content: 'First survivor', ...scope, createdAt: 1 });
    await seedMemory({ id: 'wrong-agent', content: 'Wrong agent', userId: 'user-1', agentId: 'agent-1' });
    await seedMemory({ id: 'survivor-two', content: 'Second survivor', ...scope, createdAt: 2 });

    await prepareMemoryWrite(configuredEnv(), scope, 'Brand new memory');

    expect(dependencies.selectSemanticDuplicate.mock.calls[0][1]).toEqual({
      new_memory: { ref: 'NEW', text: 'Brand new memory' },
      candidates: [
        { ref: 'M1', text: 'Second survivor' },
        { ref: 'M2', text: 'First survivor' },
      ],
    });
    const input = dependencies.selectSemanticDuplicate.mock.calls[0][1];
    expect(JSON.stringify(input)).not.toContain('score');
    expect(JSON.stringify(input)).not.toContain('survivor-one');
    expect(JSON.stringify(input)).not.toContain('createdAt');
  });

  it('orders equal-score semantic candidates by creation time before assigning refs', async () => {
    const scope = { userId: 'user-1', agentId: null };
    dependencies.getSemanticDedupEnabled.mockResolvedValue(true);
    dependencies.searchDeduplicationCandidates.mockResolvedValue([
      { id: 'created-later', score: 0.9 },
      { id: 'created-earlier', score: 0.9 },
    ]);
    await seedMemory({ id: 'created-later', content: 'Created later', ...scope, createdAt: 20 });
    await seedMemory({ id: 'created-earlier', content: 'Created earlier', ...scope, createdAt: 10 });

    await prepareMemoryWrite(configuredEnv(), scope, 'Brand new memory');

    expect(dependencies.selectSemanticDuplicate.mock.calls[0][1]).toEqual({
      new_memory: { ref: 'NEW', text: 'Brand new memory' },
      candidates: [
        { ref: 'M1', text: 'Created earlier' },
        { ref: 'M2', text: 'Created later' },
      ],
    });
  });

  it('orders equal-score and equal-time semantic candidates by ID before assigning refs', async () => {
    const scope = { userId: 'user-1', agentId: null };
    dependencies.getSemanticDedupEnabled.mockResolvedValue(true);
    dependencies.searchDeduplicationCandidates.mockResolvedValue([
      { id: 'candidate-z', score: 0.9 },
      { id: 'candidate-a', score: 0.9 },
    ]);
    await seedMemory({ id: 'candidate-z', content: 'Candidate Z', ...scope, createdAt: 10 });
    await seedMemory({ id: 'candidate-a', content: 'Candidate A', ...scope, createdAt: 10 });

    await prepareMemoryWrite(configuredEnv(), scope, 'Brand new memory');

    expect(dependencies.selectSemanticDuplicate.mock.calls[0][1]).toEqual({
      new_memory: { ref: 'NEW', text: 'Brand new memory' },
      candidates: [
        { ref: 'M1', text: 'Candidate A' },
        { ref: 'M2', text: 'Candidate Z' },
      ],
    });
  });

  it('returns the selected full D1 row and preserves the generated embedding', async () => {
    const scope = { userId: 'user-1', agentId: 'agent-1' };
    const embedding = [0.5, 0.6];
    dependencies.getSemanticDedupEnabled.mockResolvedValue(true);
    dependencies.embedText.mockResolvedValue(embedding);
    dependencies.searchDeduplicationCandidates.mockResolvedValue([
      { id: 'candidate-one', score: 0.95 },
      { id: 'candidate-two', score: 0.94 },
    ]);
    dependencies.selectSemanticDuplicate.mockResolvedValue('M2');
    await seedMemory({ id: 'candidate-one', content: 'Candidate one', ...scope, createdAt: 10 });
    await seedMemory({ id: 'candidate-two', content: 'Candidate two', ...scope, createdAt: 20 });

    const result = await prepareMemoryWrite(configuredEnv(), scope, 'New memory');

    expect(result.embedding).toBe(embedding);
    expect(result.duplicate).toEqual(await memoryById('candidate-two'));
  });

  it('returns the generated embedding without a duplicate when the LLM selects null', async () => {
    const scope = { userId: null, agentId: 'agent-1' };
    const embedding = [0.7, 0.8];
    dependencies.getSemanticDedupEnabled.mockResolvedValue(true);
    dependencies.embedText.mockResolvedValue(embedding);
    dependencies.searchDeduplicationCandidates.mockResolvedValue([
      { id: 'candidate', score: 0.9 },
    ]);
    await seedMemory({ id: 'candidate', content: 'Candidate', ...scope });

    await expect(prepareMemoryWrite(configuredEnv(), scope, 'New memory')).resolves.toEqual({
      contentHash: await contentHash('New memory'),
      exactScopeKey: await scopeKey(scope),
      embedding,
    });
  });

  it('uses threshold 0.85 and candidate limit 8 for invalid configuration', async () => {
    const scope = { userId: 'user-1', agentId: null };
    dependencies.getSemanticDedupEnabled.mockResolvedValue(true);
    dependencies.searchDeduplicationCandidates.mockResolvedValue([
      { id: 'below', score: 0.8499 },
      { id: 'at-threshold', score: 0.85 },
    ]);
    await seedMemory({ id: 'below', content: 'Below', ...scope });
    await seedMemory({ id: 'at-threshold', content: 'At threshold', ...scope });

    await prepareMemoryWrite(configuredEnv({
      DEDUP_SIMILARITY_THRESHOLD: 'not-a-number',
      DEDUP_CANDIDATE_LIMIT: '-2',
    }), scope, 'New memory');

    expect(dependencies.searchDeduplicationCandidates.mock.calls[0][0] === env.VECTORIZE).toBe(true);
    expect(dependencies.searchDeduplicationCandidates).toHaveBeenCalledWith(
      expect.anything(),
      [0.1, 0.2],
      await scopeKey(scope),
      8,
    );
    expect(dependencies.selectSemanticDuplicate).toHaveBeenCalledWith(expect.anything(), {
      new_memory: { ref: 'NEW', text: 'New memory' },
      candidates: [{ ref: 'M1', text: 'At threshold' }],
    });
  });
});

async function seedMemory({
  id,
  content,
  userId = null,
  agentId = null,
  contentHash: digest = null,
  deletedAt = null,
  createdAt = 100,
}: SeedMemoryOptions): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO memories (
      id, user_id, agent_id, run_id, actor_id, content, metadata_json, hash,
      content_hash, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, '{}', ?, ?, ?, ?, ?)
  `).bind(
    id,
    userId,
    agentId,
    content,
    `legacy-${id}`,
    digest,
    createdAt,
    createdAt + 1,
    deletedAt,
  ).run();
}

async function memoryById(id: string): Promise<MemoryRow | undefined> {
  const row = await env.DB.prepare(`
    SELECT
      id,
      user_id AS userId,
      agent_id AS agentId,
      run_id AS runId,
      actor_id AS actorId,
      content,
      metadata_json AS metadataJson,
      hash,
      content_hash AS contentHash,
      created_at AS createdAt,
      updated_at AS updatedAt,
      deleted_at AS deletedAt,
      mutation_version AS mutationVersion,
      last_mutation_id AS lastMutationId
    FROM memories
    WHERE id = ?
  `).bind(id).first<MemoryRow>();

  return row ?? undefined;
}

function withMutationBeforeBackfill(mutate: () => Promise<void>): Env {
  const database = env.DB;
  let mutationPending = true;
  const wrappedDatabase = {
    prepare(query: string) {
      const statement = database.prepare(query);
      if (!query.startsWith('update "memories" set "content_hash"')) {
        return statement;
      }

      let values: unknown[] = [];
      const wrappedStatement = {
        bind(...bindings: unknown[]) {
          values = bindings;
          return wrappedStatement;
        },
        async raw<T>() {
          if (mutationPending) {
            mutationPending = false;
            await mutate();
          }
          return statement.bind(...values).raw<T>();
        },
      };
      return wrappedStatement as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;

  return { ...env, DB: wrappedDatabase };
}

function withPreparedQueryObserver(observe: (query: string) => void): Env {
  const database = env.DB;
  const wrappedDatabase = {
    prepare(query: string) {
      observe(query);
      return database.prepare(query);
    },
  } as unknown as D1Database;

  return { ...env, DB: wrappedDatabase };
}
