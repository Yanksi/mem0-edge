/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as workerEnv, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, ReclassifyMem0AgentJob } from '../src/env';

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

import { processMem0AgentReclassificationJob } from '../src/import/service';
import { contentHash, scopeKey, vectorStateHash } from '../src/memory/identity';

const db = (workerEnv as unknown as Env).DB;
const vectorIndex = {} as VectorizeIndex;
const content = 'Exact reclassified memory.';
const job: ReclassifyMem0AgentJob = {
  type: 'reclassify-mem0-agent',
  id: 'source-memory',
  sourceUserId: 'legacy-user',
  agentId: 'agent-1',
  content,
  metadataJson: '{}',
};

afterEach(async () => reset());

beforeEach(async () => {
  vi.clearAllMocks();
  dependencies.embedText.mockResolvedValue([0.2, 0.8]);
  dependencies.upsertVectors.mockResolvedValue({ mutationId: 'upsert-1' });
  dependencies.deleteVector.mockResolvedValue(undefined);

  await db.prepare(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      agent_id TEXT,
      run_id TEXT,
      actor_id TEXT,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      hash TEXT NOT NULL,
      content_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )
  `).run();
  await db.prepare(`
    CREATE UNIQUE INDEX memories_active_agent_content_hash_unique_idx
    ON memories (agent_id, content_hash)
    WHERE deleted_at IS NULL AND user_id IS NULL AND agent_id IS NOT NULL
  `).run();
  await db.prepare(`
    CREATE TABLE entities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL
    )
  `).run();
  await db.prepare(`
    CREATE TABLE relationships (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      source_entity_id TEXT NOT NULL REFERENCES entities(id),
      target_entity_id TEXT NOT NULL REFERENCES entities(id),
      relation_type TEXT NOT NULL,
      evidence_memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL
    )
  `).run();
  await db.prepare(`
    CREATE TABLE memory_entity_links (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (memory_id, entity_id)
    )
  `).run();
  await db.batch([
    db.prepare("INSERT INTO entities (id, user_id, name, type) VALUES ('entity-source', 'legacy-user', 'Source', 'person')"),
    db.prepare("INSERT INTO entities (id, user_id, name, type) VALUES ('entity-target', 'legacy-user', 'Target', 'person')"),
  ]);
});

function testEnv(database: D1Database = db): Env {
  return { DB: database, VECTORIZE: vectorIndex } as unknown as Env;
}

async function seedMemory({
  id,
  userId,
  agentId,
  createdAt,
  digest,
  metadataJson = '{}',
  hash = `${id}-hash`,
}: {
  id: string;
  userId: string | null;
  agentId: string | null;
  createdAt: number;
  digest: string | null;
  metadataJson?: string;
  hash?: string;
}): Promise<void> {
  await db.prepare(`
    INSERT INTO memories (
      id, user_id, agent_id, run_id, actor_id, content, metadata_json,
      hash, content_hash, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, 'run-1', 'actor-1', ?, ?, ?, ?, ?, ?, NULL)
  `).bind(id, userId, agentId, content, metadataJson, hash, digest, createdAt, createdAt).run();
}

async function seedGraph(sourceEvidenceId = 'source-memory', targetEvidenceId = 'target-memory'): Promise<void> {
  await db.batch([
    db.prepare(`
      INSERT INTO memory_entity_links (memory_id, entity_id, created_at)
      VALUES ('source-memory', 'entity-source', 11)
    `),
    db.prepare(`
      INSERT INTO memory_entity_links (memory_id, entity_id, created_at)
      VALUES ('target-memory', 'entity-target', 12)
    `),
    db.prepare(`
      INSERT INTO relationships (
        id, user_id, source_entity_id, target_entity_id, relation_type, evidence_memory_id
      ) VALUES ('relationship-source', 'legacy-user', 'entity-source', 'entity-target', 'knows', ?)
    `).bind(sourceEvidenceId),
    db.prepare(`
      INSERT INTO relationships (
        id, user_id, source_entity_id, target_entity_id, relation_type, evidence_memory_id
      ) VALUES ('relationship-target', 'legacy-user', 'entity-target', 'entity-source', 'knows', ?)
    `).bind(targetEvidenceId),
  ]);
}

async function seedSourceGraph(): Promise<void> {
  await db.batch([
    db.prepare(`
      INSERT INTO memory_entity_links (memory_id, entity_id, created_at)
      VALUES ('source-memory', 'entity-source', 11)
    `),
    db.prepare(`
      INSERT INTO relationships (
        id, user_id, source_entity_id, target_entity_id, relation_type, evidence_memory_id
      ) VALUES ('relationship-source', 'legacy-user', 'entity-source', 'entity-target', 'knows', 'source-memory')
    `),
  ]);
}

async function memory(id: string) {
  return db.prepare(`
    SELECT id, user_id, agent_id, content, metadata_json, hash, content_hash,
      created_at, deleted_at
    FROM memories WHERE id = ?
  `).bind(id).first();
}

async function graphState() {
  const [links, relationships] = await Promise.all([
    db.prepare(`
      SELECT memory_id, entity_id, created_at
      FROM memory_entity_links ORDER BY memory_id, entity_id
    `).all(),
    db.prepare(`
      SELECT id, evidence_memory_id FROM relationships ORDER BY id
    `).all(),
  ]);
  return { links: links.results, relationships: relationships.results };
}

function beforeFirstBatch(action: () => Promise<void>): D1Database {
  let pending = true;
  return {
    prepare: db.prepare.bind(db),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (pending) {
        pending = false;
        await action();
      }
      return db.batch<T>(statements);
    },
  } as unknown as D1Database;
}

describe('agent reclassification consistency', () => {
  it('keeps an older target canonical and removes graph state for both memories', async () => {
    const digest = await contentHash(content);
    await seedMemory({ id: 'source-memory', userId: 'legacy-user', agentId: null, createdAt: 2, digest: null });
    await seedMemory({ id: 'target-memory', userId: null, agentId: 'agent-1', createdAt: 1, digest: null, hash: 'canonical-hash' });
    await seedGraph();

    await processMem0AgentReclassificationJob(testEnv(), job);

    expect(await memory('target-memory')).toEqual(expect.objectContaining({
      user_id: null,
      agent_id: 'agent-1',
      content,
      hash: 'canonical-hash',
      content_hash: digest,
      deleted_at: null,
    }));
    expect(await memory('source-memory')).toEqual(expect.objectContaining({ deleted_at: expect.any(Number) }));
    expect(await graphState()).toEqual({ links: [], relationships: [] });
    expect(dependencies.deleteVector).toHaveBeenCalledWith(vectorIndex, 'source-memory');
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
  });

  it('keeps an older source canonical, removes both graphs, and reindexes the source scope', async () => {
    const digest = await contentHash(content);
    const metadataJson = JSON.stringify({ label: 'source', agent_id: 'spoofed', scope_key: 'spoofed' });
    await seedMemory({ id: 'source-memory', userId: 'legacy-user', agentId: null, createdAt: 1, digest: null, metadataJson, hash: 'source-hash' });
    await seedMemory({ id: 'target-memory', userId: null, agentId: 'agent-1', createdAt: 2, digest, hash: 'target-hash' });
    await seedGraph();

    await processMem0AgentReclassificationJob(testEnv(), { ...job, metadataJson });

    expect(await memory('source-memory')).toEqual(expect.objectContaining({
      user_id: null,
      agent_id: 'agent-1',
      hash: 'source-hash',
      content_hash: digest,
      deleted_at: null,
    }));
    expect(await memory('target-memory')).toEqual(expect.objectContaining({
      hash: 'target-hash',
      deleted_at: expect.any(Number),
    }));
    expect(await graphState()).toEqual({ links: [], relationships: [] });
    expect(dependencies.upsertVectors).toHaveBeenCalledWith(vectorIndex, [{
      id: 'source-memory',
      values: [0.2, 0.8],
      metadata: {
        label: 'source',
        agent_id: 'agent-1',
        run_id: 'run-1',
        actor_id: 'actor-1',
        scope_key: await scopeKey({ userId: null, agentId: 'agent-1' }),
        content_hash: await contentHash(content),
        memory_vector_schema: '1',
        vector_state_hash: await vectorStateHash({
          userId: null, agentId: 'agent-1', runId: 'run-1', actorId: 'actor-1',
          metadataJson, contentHash: digest,
        }),
      },
    }]);
    expect(dependencies.deleteVector).toHaveBeenCalledWith(vectorIndex, 'target-memory');
  });

  it('uses id ordering to keep the source canonical when creation times tie', async () => {
    const digest = await contentHash(content);
    const tieJob = { ...job, id: 'a-source' };
    await seedMemory({ id: 'a-source', userId: 'legacy-user', agentId: null, createdAt: 1, digest });
    await seedMemory({ id: 'z-target', userId: null, agentId: 'agent-1', createdAt: 1, digest });

    await processMem0AgentReclassificationJob(testEnv(), tieJob);

    expect(await memory('a-source')).toEqual(expect.objectContaining({ agent_id: 'agent-1', deleted_at: null }));
    expect(await memory('z-target')).toEqual(expect.objectContaining({ deleted_at: expect.any(Number) }));
    expect(dependencies.deleteVector).toHaveBeenCalledWith(vectorIndex, 'z-target');
  });

  it('atomically removes graph state when moving without a collision', async () => {
    const digest = await contentHash(content);
    await seedMemory({ id: 'source-memory', userId: 'legacy-user', agentId: null, createdAt: 1, digest });
    await seedSourceGraph();

    await processMem0AgentReclassificationJob(testEnv(), job);

    expect(await memory('source-memory')).toEqual(expect.objectContaining({
      user_id: null,
      agent_id: 'agent-1',
      deleted_at: null,
    }));
    expect(await graphState()).toEqual({ links: [], relationships: [] });
    expect(dependencies.upsertVectors).toHaveBeenCalledOnce();
  });

  it('moves a paired user-agent source into the target agent-only scope', async () => {
    const digest = await contentHash(content);
    await seedMemory({
      id: 'source-memory',
      userId: 'legacy-user',
      agentId: 'existing-agent',
      createdAt: 1,
      digest: null,
      metadataJson: JSON.stringify({ label: 'paired', user_id: 'spoofed', agent_id: 'spoofed' }),
    });

    await processMem0AgentReclassificationJob(testEnv(), job);

    expect(await memory('source-memory')).toEqual(expect.objectContaining({
      user_id: null,
      agent_id: 'agent-1',
      content_hash: digest,
      deleted_at: null,
    }));
    expect(dependencies.upsertVectors).toHaveBeenCalledWith(vectorIndex, [{
      id: 'source-memory',
      values: [0.2, 0.8],
      metadata: {
        label: 'paired',
        agent_id: 'agent-1',
        run_id: 'run-1',
        actor_id: 'actor-1',
        scope_key: await scopeKey({ userId: null, agentId: 'agent-1' }),
        content_hash: digest,
        memory_vector_schema: '1',
        vector_state_hash: await vectorStateHash({
          userId: null, agentId: 'agent-1', runId: 'run-1', actorId: 'actor-1',
          metadataJson: JSON.stringify({ label: 'paired', user_id: 'spoofed', agent_id: 'spoofed' }),
          contentHash: digest,
        }),
      },
    }]);
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
  });

  it('guards the observed agent on a paired collision before retrying with the new snapshot', async () => {
    const digest = await contentHash(content);
    await seedMemory({ id: 'source-memory', userId: 'legacy-user', agentId: 'existing-agent', createdAt: 2, digest });
    await seedMemory({ id: 'target-memory', userId: null, agentId: 'agent-1', createdAt: 1, digest });
    await seedGraph();
    let batchCalls = 0;
    const racingDb = {
      prepare: db.prepare.bind(db),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        batchCalls += 1;
        if (batchCalls === 1) {
          await db.prepare(`
            UPDATE memories SET agent_id = 'raced-agent' WHERE id = 'source-memory'
          `).run();
        }
        return db.batch<T>(statements);
      },
    } as unknown as D1Database;

    await processMem0AgentReclassificationJob(testEnv(racingDb), job);

    expect(batchCalls).toBe(2);
    expect(await memory('source-memory')).toEqual(expect.objectContaining({
      agent_id: 'raced-agent',
      deleted_at: expect.any(Number),
    }));
    expect(await graphState()).toEqual({ links: [], relationships: [] });
    expect(dependencies.deleteVector).toHaveBeenCalledWith(vectorIndex, 'source-memory');
  });

  it.each([
    ['edited', "UPDATE memories SET content = 'Edited after lookup', content_hash = 'edited-hash' WHERE id = 'source-memory'"],
    ['moved', "UPDATE memories SET user_id = NULL, agent_id = 'other-agent' WHERE id = 'source-memory'"],
  ])('does not merge when the source is %s after collision lookup', async (_label, mutation) => {
    const digest = await contentHash(content);
    await seedMemory({ id: 'source-memory', userId: 'legacy-user', agentId: null, createdAt: 2, digest });
    await seedMemory({ id: 'target-memory', userId: null, agentId: 'agent-1', createdAt: 1, digest });
    await seedGraph();
    const originalGraph = await graphState();

    await processMem0AgentReclassificationJob(testEnv(beforeFirstBatch(async () => {
      await db.prepare(mutation).run();
    })), job);

    expect(await memory('source-memory')).toEqual(expect.objectContaining({ deleted_at: null }));
    expect(await memory('target-memory')).toEqual(expect.objectContaining({ deleted_at: null }));
    expect(await graphState()).toEqual(originalGraph);
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
  });

  it.each([
    ['deleted', "UPDATE memories SET deleted_at = 99 WHERE id = 'target-memory'"],
    ['reclassified', "UPDATE memories SET agent_id = 'other-agent' WHERE id = 'target-memory'"],
  ])('does not merge into a target that is %s after collision lookup', async (_label, mutation) => {
    const digest = await contentHash(content);
    await seedMemory({ id: 'source-memory', userId: 'legacy-user', agentId: null, createdAt: 2, digest });
    await seedMemory({ id: 'target-memory', userId: null, agentId: 'agent-1', createdAt: 1, digest });
    await seedGraph();
    await processMem0AgentReclassificationJob(testEnv(beforeFirstBatch(async () => {
      await db.prepare(mutation).run();
    })), job);

    expect(await memory('source-memory')).toEqual(expect.objectContaining({
      user_id: null,
      agent_id: 'agent-1',
      deleted_at: null,
    }));
    expect(await graphState()).toEqual({
      links: [{ memory_id: 'target-memory', entity_id: 'entity-target', created_at: 12 }],
      relationships: [{ id: 'relationship-target', evidence_memory_id: 'target-memory' }],
    });
    expect(dependencies.upsertVectors).toHaveBeenCalledOnce();
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
  });

  it('rolls back every graph mutation when the guarded D1 batch fails', async () => {
    const digest = await contentHash(content);
    await seedMemory({ id: 'source-memory', userId: 'legacy-user', agentId: null, createdAt: 2, digest });
    await seedMemory({ id: 'target-memory', userId: null, agentId: 'agent-1', createdAt: 1, digest });
    await seedGraph();
    const originalGraph = await graphState();
    const failingDb = {
      prepare: db.prepare.bind(db),
      batch: <T>(statements: D1PreparedStatement[]) => db.batch<T>([
        ...statements,
        db.prepare('INSERT INTO table_that_does_not_exist (id) VALUES (1)'),
      ]),
    } as unknown as D1Database;

    await expect(processMem0AgentReclassificationJob(testEnv(failingDb), job)).rejects.toThrow();

    expect(await memory('source-memory')).toEqual(expect.objectContaining({ deleted_at: null }));
    expect(await memory('target-memory')).toEqual(expect.objectContaining({ deleted_at: null }));
    expect(await graphState()).toEqual(originalGraph);
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
  });

  it('recovers a prospective unique-index race by re-reading and merging the new target', async () => {
    const digest = await contentHash(content);
    await seedMemory({ id: 'source-memory', userId: 'legacy-user', agentId: null, createdAt: 2, digest });
    const racingDb = beforeFirstBatch(async () => {
      await seedMemory({ id: 'racing-target', userId: null, agentId: 'agent-1', createdAt: 1, digest });
    });

    await processMem0AgentReclassificationJob(testEnv(racingDb), job);

    expect(await memory('source-memory')).toEqual(expect.objectContaining({ deleted_at: expect.any(Number) }));
    expect(await memory('racing-target')).toEqual(expect.objectContaining({ deleted_at: null }));
    expect(dependencies.deleteVector).toHaveBeenCalledWith(vectorIndex, 'source-memory');
  });

  it('recovers a phase-one target insertion race before the ownership update', async () => {
    const digest = await contentHash(content);
    await db.prepare('DROP INDEX memories_active_agent_content_hash_unique_idx').run();
    await seedMemory({ id: 'source-memory', userId: 'legacy-user', agentId: null, createdAt: 2, digest });
    const racingDb = beforeFirstBatch(async () => {
      await seedMemory({ id: 'phase-one-target', userId: null, agentId: 'agent-1', createdAt: 1, digest });
    });

    await processMem0AgentReclassificationJob(testEnv(racingDb), job);

    expect(await memory('source-memory')).toEqual(expect.objectContaining({ deleted_at: expect.any(Number) }));
    expect(await memory('phase-one-target')).toEqual(expect.objectContaining({ deleted_at: null }));
    expect(dependencies.deleteVector).toHaveBeenCalledWith(vectorIndex, 'source-memory');
  });

  it('retries target-wins vector deletion after the guarded D1 merge committed', async () => {
    const digest = await contentHash(content);
    await seedMemory({ id: 'source-memory', userId: 'legacy-user', agentId: null, createdAt: 2, digest });
    await seedMemory({ id: 'target-memory', userId: null, agentId: 'agent-1', createdAt: 1, digest });
    dependencies.deleteVector.mockRejectedValueOnce(new Error('Vector delete unavailable'));

    await expect(processMem0AgentReclassificationJob(testEnv(), job)).rejects.toThrow('Vector delete unavailable');
    expect(await memory('source-memory')).toEqual(expect.objectContaining({ deleted_at: expect.any(Number) }));

    await expect(processMem0AgentReclassificationJob(testEnv(), job)).resolves.toBeUndefined();

    expect(dependencies.deleteVector).toHaveBeenCalledTimes(2);
    expect(dependencies.deleteVector).toHaveBeenLastCalledWith(vectorIndex, 'source-memory');
    expect(await memory('target-memory')).toEqual(expect.objectContaining({ deleted_at: null }));
  });

  it('retries source-wins reindex and loser deletion from observable D1 state', async () => {
    const digest = await contentHash(content);
    await seedMemory({ id: 'source-memory', userId: 'legacy-user', agentId: null, createdAt: 1, digest });
    await seedMemory({ id: 'target-memory', userId: null, agentId: 'agent-1', createdAt: 2, digest });
    dependencies.upsertVectors.mockRejectedValueOnce(new Error('Vector upsert unavailable'));

    await expect(processMem0AgentReclassificationJob(testEnv(), job)).rejects.toThrow('Vector upsert unavailable');
    expect(await memory('source-memory')).toEqual(expect.objectContaining({ agent_id: 'agent-1', deleted_at: null }));
    expect(await memory('target-memory')).toEqual(expect.objectContaining({ deleted_at: expect.any(Number) }));
    expect(dependencies.deleteVector).not.toHaveBeenCalled();

    await expect(processMem0AgentReclassificationJob(testEnv(), job)).resolves.toBeUndefined();

    expect(dependencies.upsertVectors).toHaveBeenCalledTimes(2);
    expect(dependencies.deleteVector).toHaveBeenCalledWith(vectorIndex, 'target-memory');
    expect(await memory('source-memory')).toEqual(expect.objectContaining({ hash: 'source-memory-hash', deleted_at: null }));
  });

  it('retries source-wins loser deletion without changing the canonical source', async () => {
    const digest = await contentHash(content);
    await seedMemory({ id: 'source-memory', userId: 'legacy-user', agentId: null, createdAt: 1, digest, hash: 'stable-source-hash' });
    await seedMemory({ id: 'target-memory', userId: null, agentId: 'agent-1', createdAt: 2, digest });
    dependencies.deleteVector.mockRejectedValueOnce(new Error('Vector delete unavailable'));

    await expect(processMem0AgentReclassificationJob(testEnv(), job)).rejects.toThrow('Vector delete unavailable');
    await expect(processMem0AgentReclassificationJob(testEnv(), job)).resolves.toBeUndefined();

    expect(dependencies.upsertVectors).toHaveBeenCalledTimes(2);
    expect(dependencies.deleteVector).toHaveBeenCalledTimes(2);
    expect(await memory('source-memory')).toEqual(expect.objectContaining({
      hash: 'stable-source-hash',
      agent_id: 'agent-1',
      deleted_at: null,
    }));
  });
});
