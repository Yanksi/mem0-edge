import { beforeEach, describe, expect, it, vi } from 'vitest';
import { entities, memories, memoryEntityLinks, relationships } from '../src/db/schema';
import type { Env } from '../src/env';

const dependencies = vi.hoisted(() => ({
  createDb: vi.fn(),
  searchMemories: vi.fn(),
  reflectWithGraphModel: vi.fn(),
}));

vi.mock('../src/db/client', () => ({ createDb: dependencies.createDb }));
vi.mock('../src/memory/service', () => ({ searchMemories: dependencies.searchMemories }));
vi.mock('../src/llm', () => ({ reflectWithGraphModel: dependencies.reflectWithGraphModel }));

import { reflectMemories } from '../src/reflect/service';

const env = {} as Env;

const entityRows = [
  { id: 'entity-ada', userId: 'user-a', name: 'Ada', type: 'person', metadataJson: '{}', createdAt: 1, updatedAt: 1 },
  { id: 'entity-benoit', userId: 'user-a', name: 'Benoit', type: 'person', metadataJson: '{}', createdAt: 1, updatedAt: 1 },
  { id: 'entity-chandra', userId: 'user-a', name: 'Chandra', type: 'person', metadataJson: '{}', createdAt: 1, updatedAt: 1 },
];
const relationshipRows = [
  { id: 'relationship-ada', userId: 'user-a', sourceEntityId: 'entity-ada', targetEntityId: 'entity-benoit', relationType: 'reports_to', confidence: 0.9, evidenceMemoryId: 'memory-ada', metadataJson: '{}', createdAt: 1, updatedAt: 1 },
  { id: 'relationship-benoit', userId: 'user-a', sourceEntityId: 'entity-benoit', targetEntityId: 'entity-chandra', relationType: 'managed_by', confidence: 0.8, evidenceMemoryId: 'memory-benoit', metadataJson: '{}', createdAt: 2, updatedAt: 2 },
];
const memoryRows = [
  { id: 'memory-ada', userId: 'user-a', agentId: 'agent-a', runId: null, actorId: null, content: 'Ada reports to Benoit.', metadataJson: '{}', hash: 'a', createdAt: 1, updatedAt: 1, deletedAt: null },
  { id: 'memory-benoit', userId: 'user-a', agentId: 'agent-a', runId: null, actorId: null, content: 'Benoit is managed by Chandra.', metadataJson: '{}', hash: 'b', createdAt: 2, updatedAt: 2, deletedAt: null },
  { id: 'memory-other-user', userId: 'user-b', agentId: 'agent-b', runId: null, actorId: null, content: 'Do not expose.', metadataJson: '{}', hash: 'c', createdAt: 3, updatedAt: 3, deletedAt: null },
  { id: 'memory-deleted', userId: 'user-a', agentId: 'agent-a', runId: null, actorId: null, content: 'Deleted.', metadataJson: '{}', hash: 'd', createdAt: 4, updatedAt: 4, deletedAt: 4 },
];

let relationshipPredicates: unknown[] = [];

function createReadOnlyDb() {
  const where = vi.fn((predicate: unknown) => ({ all: vi.fn().mockResolvedValue(rowsFor(predicate)) }));
  const from = vi.fn((table: unknown) => ({ where: (predicate: unknown) => {
    if (table === relationships) relationshipPredicates.push(predicate);
    return { all: vi.fn().mockResolvedValue(rowsFor(predicate, table)) };
  } }));
  const select = vi.fn(() => ({ from }));
  return { db: { select }, from, where };
}

function rowsFor(_predicate: unknown, table?: unknown): unknown[] {
  if (table === memoryEntityLinks) return [{ memoryId: 'memory-ada', entityId: 'entity-ada' }];
  if (table === relationships) return relationshipRows;
  if (table === entities) return entityRows;
  if (table === memories) return memoryRows.filter((row) => row.userId === 'user-a' && row.deletedAt === null);
  return [];
}

function containsValue(value: unknown, expected: unknown, seen = new Set<unknown>()): boolean {
  if (value === expected) return true;
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) => containsValue((value as Record<PropertyKey, unknown>)[key], expected, seen));
}

describe('reflectMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    relationshipPredicates = [];
    dependencies.createDb.mockReturnValue(createReadOnlyDb().db);
    dependencies.searchMemories.mockResolvedValue([{ id: 'memory-ada', memory: 'Ada reports to Benoit.', user_id: 'user-a', metadata: {}, created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z' }]);
    dependencies.reflectWithGraphModel.mockResolvedValue({
      result: 'Chandra manages Ada through Benoit.', evidence_relation_refs: ['R1', 'R2'],
    });
  });

  it('builds a bounded two-hop graph and resolves selected relationship evidence deterministically', async () => {
    await expect(reflectMemories(env, {
      query: 'Who manages Ada?', user_id: 'user-a', agent_id: 'agent-a',
    }, 'request-1')).resolves.toMatchObject({
      result: 'Chandra manages Ada through Benoit.',
      uncertainty: 'medium',
      request_id: 'request-1',
      evidences: [
        { relationship: expect.objectContaining({ id: 'relationship-ada' }) },
        { relationship: expect.objectContaining({ id: 'relationship-benoit' }) },
      ],
      relation_paths: [{ entity_ids: ['entity-ada', 'entity-benoit', 'entity-chandra'], relationship_ids: ['relationship-ada', 'relationship-benoit'] }],
    });

    expect(dependencies.searchMemories).toHaveBeenCalledWith(env, {
      query: 'Who manages Ada?', user_id: 'user-a', agent_id: 'agent-a', limit: 12, filters: {},
    });
    expect(dependencies.reflectWithGraphModel).toHaveBeenCalledWith(env, {
      query: 'Who manages Ada?',
      entities: [
        { ref: 'E1', name: 'Ada', type: 'person' },
        { ref: 'E2', name: 'Benoit', type: 'person' },
        { ref: 'E3', name: 'Chandra', type: 'person' },
      ],
      relations: [
        { ref: 'R1', source: 'E1', predicate: 'reports_to', target: 'E2', confidence: 0.9 },
        { ref: 'R2', source: 'E2', predicate: 'managed_by', target: 'E3', confidence: 0.8 },
      ],
    });
    expect(relationshipPredicates).toHaveLength(2);
    for (const predicate of relationshipPredicates) {
      expect(containsValue(predicate, relationships.userId)).toBe(true);
      expect(containsValue(predicate, 'user-a')).toBe(true);
    }
  });

  it('returns a static high-uncertainty response without D1 or model access when semantic search has no seeds', async () => {
    dependencies.searchMemories.mockResolvedValue([]);

    await expect(reflectMemories(env, {
      query: 'Who manages Ada?', user_id: 'user-a', agent_id: 'agent-a',
    }, 'request-empty')).resolves.toMatchObject({
      result: 'I cannot answer reliably from the retrieved memories.', uncertainty: 'high', evidences: [], relation_paths: [], request_id: 'request-empty',
    });
    expect(dependencies.createDb).not.toHaveBeenCalled();
    expect(dependencies.reflectWithGraphModel).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', []],
    ['unknown', ['R99']],
    ['duplicate', ['R1', 'R1']],
  ])('fails closed for %s model relationship refs', async (_name, refs) => {
    dependencies.reflectWithGraphModel.mockResolvedValue({ result: 'Untrusted answer.', evidence_relation_refs: refs });

    await expect(reflectMemories(env, {
      query: 'Who manages Ada?', user_id: 'user-a', agent_id: 'agent-a',
    }, 'request-invalid')).resolves.toMatchObject({
      uncertainty: 'high', evidences: [], relation_paths: [], request_id: 'request-invalid',
    });
  });

  it('does not attach cross-user or soft-deleted source memories as evidence', async () => {
    relationshipRows[0] = { ...relationshipRows[0], evidenceMemoryId: 'memory-other-user' };
    relationshipRows[1] = { ...relationshipRows[1], evidenceMemoryId: 'memory-deleted' };
    try {
      const result = await reflectMemories(env, {
        query: 'Who manages Ada?', user_id: 'user-a', agent_id: 'agent-a',
      }, 'request-isolated');

      expect(result.uncertainty).toBe('medium');
      expect(result.evidences).toHaveLength(2);
      expect(result.evidences.every((evidence) => evidence.evidence_memory === undefined)).toBe(true);
    } finally {
      relationshipRows[0] = { ...relationshipRows[0], evidenceMemoryId: 'memory-ada' };
      relationshipRows[1] = { ...relationshipRows[1], evidenceMemoryId: 'memory-benoit' };
    }
  });
});
