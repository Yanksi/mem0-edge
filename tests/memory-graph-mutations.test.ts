/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as workerEnv, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { sha256Hex } from '../src/memory/idempotency';

const dependencies = vi.hoisted(() => ({
  embedText: vi.fn(),
  extractMemoryGraph: vi.fn(),
  extractMemories: vi.fn(),
  upsertVectors: vi.fn(),
  upsertEntityVectors: vi.fn(),
  deleteVector: vi.fn(),
}));

vi.mock('../src/llm', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/llm')>(),
  embedText: dependencies.embedText,
  extractMemoryGraph: dependencies.extractMemoryGraph,
  extractMemories: dependencies.extractMemories,
}));
vi.mock('../src/vectorize', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/vectorize')>(),
  upsertVectors: dependencies.upsertVectors,
  upsertEntityVectors: dependencies.upsertEntityVectors,
  deleteVector: dependencies.deleteVector,
}));

import { deleteMemory, getMemoryOwnerById, updateMemory } from '../src/memory/service';

const db = (workerEnv as unknown as Env).DB;
const memoryIndex = {} as VectorizeIndex;
const entityIndex = {} as VectorizeIndex;

function testEnv(): Env {
  return { DB: db, VECTORIZE: memoryIndex, ENTITY_VECTORIZE: entityIndex } as unknown as Env;
}

afterEach(async () => reset());

beforeEach(async () => {
  vi.clearAllMocks();
  dependencies.embedText.mockResolvedValue([0.2, 0.8]);
  dependencies.extractMemoryGraph.mockResolvedValue({
    entities: [
      { name: 'Ada', type: 'person' },
      { name: 'Chandra', type: 'person' },
    ],
    relationships: [{ source: 'Ada', target: 'Chandra', relation_type: 'reports_to', confidence: 0.9 }],
  });
  dependencies.upsertVectors.mockResolvedValue(undefined);
  dependencies.upsertEntityVectors.mockResolvedValue(undefined);
  dependencies.deleteVector.mockResolvedValue(undefined);

  const adaId = await sha256Hex('entity:user-1:ada:person');
  const benoitId = await sha256Hex('entity:user-1:benoit:person');
  await db.batch([
    db.prepare(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, user_id TEXT, agent_id TEXT, run_id TEXT, actor_id TEXT,
      content TEXT NOT NULL, metadata_json TEXT NOT NULL, hash TEXT NOT NULL,
      content_hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`),
    db.prepare(`CREATE UNIQUE INDEX memories_active_user_content_idx
      ON memories (user_id, content_hash, content)
      WHERE deleted_at IS NULL AND user_id IS NOT NULL AND agent_id IS NULL`),
    db.prepare(`CREATE TABLE memory_history (
      id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      operation TEXT NOT NULL, content TEXT NOT NULL, metadata_json TEXT NOT NULL,
      hash TEXT NOT NULL, created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE entities (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare('CREATE UNIQUE INDEX entities_user_name_type_idx ON entities (user_id, name, type)'),
    db.prepare(`CREATE TABLE relationships (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      source_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL, confidence REAL,
      evidence_memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE memory_entity_links (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, PRIMARY KEY (memory_id, entity_id)
    )`),
  ]);

  await db.batch([
    db.prepare(`INSERT INTO memories
      (id, user_id, agent_id, run_id, actor_id, content, metadata_json, hash, content_hash, created_at, updated_at, deleted_at)
      VALUES ('memory-1', 'user-1', NULL, NULL, NULL, 'Ada reports to Benoit.', '{}', 'request-1', 'old-digest', 1, 1, NULL)`),
    db.prepare(`INSERT INTO entities
      (id, user_id, name, type, metadata_json, created_at, updated_at)
      VALUES (?, 'user-1', 'Ada', 'person', '{}', 1, 1)`).bind(adaId),
    db.prepare(`INSERT INTO entities
      (id, user_id, name, type, metadata_json, created_at, updated_at)
      VALUES (?, 'user-1', 'Benoit', 'person', '{}', 1, 1)`).bind(benoitId),
    db.prepare("INSERT INTO memory_entity_links (memory_id, entity_id, created_at) VALUES ('memory-1', ?, 1)").bind(adaId),
    db.prepare("INSERT INTO memory_entity_links (memory_id, entity_id, created_at) VALUES ('memory-1', ?, 1)").bind(benoitId),
    db.prepare(`INSERT INTO relationships
      (id, user_id, source_entity_id, target_entity_id, relation_type, confidence, evidence_memory_id, metadata_json, created_at, updated_at)
      VALUES ('relationship-old', 'user-1', ?, ?, 'reports_to', 0.9, 'memory-1', '{}', 1, 1)`).bind(adaId, benoitId),
  ]);
});

async function graphState() {
  const [links, relationships] = await Promise.all([
    db.prepare('SELECT memory_id, entity_id FROM memory_entity_links ORDER BY entity_id').all(),
    db.prepare('SELECT id, relation_type, evidence_memory_id FROM relationships ORDER BY id').all(),
  ]);
  return { links: links.results, relationships: relationships.results };
}

describe('memory graph reconciliation', () => {
  it('replaces relationships and links when memory content is updated', async () => {
    await updateMemory(testEnv(), 'memory-1', 'user-1', { memory: 'Ada reports to Chandra.' });

    const stored = await db.prepare('SELECT content, deleted_at FROM memories WHERE id = ?').bind('memory-1').first();
    expect(stored).toEqual(expect.objectContaining({ content: 'Ada reports to Chandra.', deleted_at: null }));
    const state = await graphState();
    expect(state.relationships).toEqual([
      expect.objectContaining({ relation_type: 'reports_to', evidence_memory_id: 'memory-1' }),
    ]);
    expect(state.relationships).not.toContainEqual(expect.objectContaining({ id: 'relationship-old' }));
    expect(state.links).toHaveLength(2);
    expect(dependencies.extractMemoryGraph).toHaveBeenCalledWith(expect.anything(), 'Ada reports to Chandra.');
  });

  it('leaves graph state untouched for metadata-only updates', async () => {
    const before = await graphState();

    await updateMemory(testEnv(), 'memory-1', 'user-1', { metadata: { source: 'dashboard' } });

    expect(await graphState()).toEqual(before);
    expect(dependencies.extractMemoryGraph).not.toHaveBeenCalled();
  });

  it('does not mutate memory or graph when graph extraction fails', async () => {
    dependencies.extractMemoryGraph.mockRejectedValueOnce(new Error('extraction unavailable'));
    const before = await graphState();

    await expect(updateMemory(testEnv(), 'memory-1', 'user-1', { memory: 'Ada reports to Chandra.' }))
      .rejects.toThrow('extraction unavailable');

    expect(await db.prepare('SELECT content FROM memories WHERE id = ?').bind('memory-1').first())
      .toEqual({ content: 'Ada reports to Benoit.' });
    expect(await graphState()).toEqual(before);
  });

  it('removes graph evidence before completing a soft delete', async () => {
    await expect(deleteMemory(testEnv(), 'memory-1', 'user-1')).resolves.toBe(true);

    expect(await graphState()).toEqual({ links: [], relationships: [] });
    expect(await db.prepare('SELECT deleted_at FROM memories WHERE id = ?').bind('memory-1').first())
      .toEqual({ deleted_at: expect.any(Number) });
    await expect(getMemoryOwnerById(testEnv(), 'memory-1')).resolves.toBe('user-1');
    expect(dependencies.deleteVector).toHaveBeenCalledWith(memoryIndex, 'memory-1');
  });

  it('retries vector cleanup for an already soft-deleted memory', async () => {
    dependencies.deleteVector.mockRejectedValueOnce(new Error('vector unavailable'));
    await expect(deleteMemory(testEnv(), 'memory-1', 'user-1')).rejects.toThrow('vector unavailable');

    await expect(deleteMemory(testEnv(), 'memory-1', 'user-1')).resolves.toBe(true);
    expect(dependencies.deleteVector).toHaveBeenCalledTimes(2);
    const history = await db.prepare("SELECT COUNT(*) AS count FROM memory_history WHERE memory_id = 'memory-1' AND operation = 'deleted'").first<{ count: number }>();
    expect(history?.count).toBe(1);
  });
});
