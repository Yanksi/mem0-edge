import { beforeEach, describe, expect, it, vi } from 'vitest';
import { entities, memories, memoryEntityLinks, relationships } from '../src/db/schema';
import type { Env } from '../src/env';
// Vite supplies raw assets at test runtime; this project does not include Vite's ambient declarations.
// @ts-expect-error Raw asset module declarations are intentionally absent from tsconfig.
import readme from '../README.md?raw';
// @ts-expect-error Raw asset module declarations are intentionally absent from tsconfig.
import wranglerConfig from '../wrangler.toml?raw';

const dependencies = vi.hoisted(() => ({
  createDb: vi.fn(),
  searchMemories: vi.fn(),
  reflectWithGraphModel: vi.fn(),
}));

vi.mock('../src/db/client', () => ({ createDb: dependencies.createDb }));
vi.mock('../src/memory/service', () => ({ searchMemories: dependencies.searchMemories }));
vi.mock('../src/llm', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/llm')>(),
  reflectWithGraphModel: dependencies.reflectWithGraphModel,
}));

import { boundedEvidenceCandidates, reflectMemories } from '../src/reflect/service';
import { GraphLlmConfigurationError, UpstreamServiceError } from '../src/llm';
import worker from '../src/index';

const env = {} as Env;
const routeEnv = { MEM0_API_KEY: 'test-api-key' } as Env;
const authorization = { Authorization: 'Bearer test-api-key' };

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
let memoryPredicates: unknown[] = [];
let seedLinks = [{ memoryId: 'memory-ada', entityId: 'entity-ada' }];

function createReadOnlyDb() {
  const where = vi.fn((predicate: unknown) => ({ all: vi.fn().mockResolvedValue(rowsFor(predicate)) }));
  const from = vi.fn((table: unknown) => ({ where: (predicate: unknown) => {
    if (table === relationships) relationshipPredicates.push(predicate);
    if (table === memories) memoryPredicates.push(predicate);
    return { all: vi.fn().mockResolvedValue(rowsFor(predicate, table)) };
  } }));
  const select = vi.fn(() => ({ from }));
  return { db: { select }, from, where };
}

function rowsFor(_predicate: unknown, table?: unknown): unknown[] {
  if (table === memoryEntityLinks) return seedLinks;
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
    memoryPredicates = [];
    seedLinks = [{ memoryId: 'memory-ada', entityId: 'entity-ada' }];
    dependencies.createDb.mockReturnValue(createReadOnlyDb().db);
    dependencies.searchMemories.mockResolvedValue([{ id: 'memory-ada', memory: 'Ada reports to Benoit.', user_id: 'user-a', metadata: {}, created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z' }]);
    dependencies.reflectWithGraphModel.mockResolvedValue({
      result: 'Chandra manages Ada through Benoit.', evidence_relation_refs: ['R1', 'R2'],
    });
  });

  it('keeps evidence candidates seed-first, deduplicated, and within count and character caps', () => {
    const memory = (id: string, size = 1) => ({
      id, memory: 'x'.repeat(size), user_id: 'user-a', metadata: {}, created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
    });

    expect(boundedEvidenceCandidates(
      Array.from({ length: 21 }, (_, index) => memory(`seed-${index + 1}`)),
      [memory('seed-1'), memory('graph-z'), memory('graph-a')],
    ).map(({ id }) => id)).toEqual(Array.from({ length: 20 }, (_, index) => `seed-${index + 1}`));
    expect(boundedEvidenceCandidates(
      Array.from({ length: 13 }, (_, index) => memory(`large-${index + 1}`, 2_000)), [],
    )).toHaveLength(12);
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

  it('chunks large graph evidence lookups below the D1 bound-parameter limit', async () => {
    seedLinks = Array.from({ length: 120 }, (_, index) => ({
      memoryId: `bulk-memory-${String(index + 1).padStart(3, '0')}`,
      entityId: 'entity-ada',
    }));

    await reflectMemories(env, {
      query: 'Who manages Ada?', user_id: 'user-a', agent_id: 'agent-a',
    }, 'request-large-evidence');

    expect(memoryPredicates).toHaveLength(2);
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

  it.each([
    ['configuration', new GraphLlmConfigurationError('Missing graph configuration')],
    ['upstream', new UpstreamServiceError('Graph service unavailable', 503)],
  ])('propagates %s graph-model failures for route error handling', async (_name, error) => {
    dependencies.reflectWithGraphModel.mockRejectedValue(error);

    await expect(reflectMemories(env, {
      query: 'Who manages Ada?', user_id: 'user-a', agent_id: 'agent-a',
    }, 'request-model-error')).rejects.toBe(error);
  });

  it('caps seed entities at 24 in deterministic ID order before graph mapping', async () => {
    const extraEntities = Array.from({ length: 25 }, (_, index) => ({
      id: `entity-seed-${String(index + 1).padStart(2, '0')}`,
      userId: 'user-a', name: `Seed ${index + 1}`, type: 'person', metadataJson: '{}', createdAt: 1, updatedAt: 1,
    }));
    const originalRelationships = [...relationshipRows];
    entityRows.push(...extraEntities);
    seedLinks = extraEntities.map((entity) => ({ memoryId: 'memory-ada', entityId: entity.id }));
    relationshipRows.splice(0, relationshipRows.length, {
      id: 'relationship-seed', userId: 'user-a', sourceEntityId: 'entity-seed-01', targetEntityId: 'entity-seed-02',
      relationType: 'knows', confidence: 0, evidenceMemoryId: 'memory-ada', metadataJson: '{}', createdAt: 1, updatedAt: 1,
    });
    dependencies.reflectWithGraphModel.mockResolvedValue({ result: 'Seed 1 knows Seed 2.', evidence_relation_refs: ['R1'] });
    try {
      await reflectMemories(env, {
        query: 'Who knows Seed 2?', user_id: 'user-a', agent_id: 'agent-a',
      }, 'request-cap');

      const graph = dependencies.reflectWithGraphModel.mock.calls[0][1];
      expect(graph.entities).toHaveLength(24);
      expect(graph.entities.map((entity: { name: string }) => entity.name)).toEqual(
        Array.from({ length: 24 }, (_, index) => `Seed ${index + 1}`),
      );
    } finally {
      entityRows.splice(-extraEntities.length);
      relationshipRows.splice(0, relationshipRows.length, ...originalRelationships);
    }
  });

  it('fails closed when selected relationships reference cross-user or soft-deleted source memories', async () => {
    relationshipRows[0] = { ...relationshipRows[0], evidenceMemoryId: 'memory-other-user' };
    relationshipRows[1] = { ...relationshipRows[1], evidenceMemoryId: 'memory-deleted' };
    try {
      const result = await reflectMemories(env, {
        query: 'Who manages Ada?', user_id: 'user-a', agent_id: 'agent-a',
      }, 'request-isolated');

      expect(result).toMatchObject({ uncertainty: 'high', evidences: [], relation_paths: [] });
    } finally {
      relationshipRows[0] = { ...relationshipRows[0], evidenceMemoryId: 'memory-ada' };
      relationshipRows[1] = { ...relationshipRows[1], evidenceMemoryId: 'memory-benoit' };
    }
  });
});

describe('graph reflection deployment documentation', () => {
  it('sets OpenRouter graph defaults without declaring the graph API key and documents reflection', () => {
    expect(wranglerConfig).toContain('GRAPH_LLM_API_BASE_URL = "https://openrouter.ai/api/v1"');
    expect(wranglerConfig).toContain('GRAPH_LLM_MODEL = "deepseek/deepseek-v4-flash"');
    expect(wranglerConfig).toContain('GRAPH_LLM_THINKING_LEVEL = "low"');
    expect(wranglerConfig).not.toMatch(/^GRAPH_LLM_API_KEY\s*=/m);
    expect(readme).toContain('| `POST` | `/v1/reflect` |');
    expect(readme).toContain('### Reflect on a bounded graph');
  });
});

describe('reflect route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    relationshipPredicates = [];
    seedLinks = [{ memoryId: 'memory-ada', entityId: 'entity-ada' }];
    dependencies.createDb.mockReturnValue(createReadOnlyDb().db);
    dependencies.searchMemories.mockResolvedValue([
      {
        id: 'memory-ada',
        memory: 'Ada reports to Benoit.',
        user_id: 'user-a',
        metadata: {},
        created_at: '2026-07-15T00:00:00.000Z',
        updated_at: '2026-07-15T00:00:00.000Z',
      },
    ]);
    dependencies.reflectWithGraphModel.mockResolvedValue({
      result: 'Chandra manages Ada through Benoit.',
      evidence_relation_refs: ['R1', 'R2'],
    });
  });

  it('requires API authentication', async () => {
    const response = await worker.fetch(new Request('https://example.com/v1/reflect', {
      method: 'POST',
      body: JSON.stringify({ query: 'Who manages Ada?', user_id: 'user-a', agent_id: 'agent-a' }),
    }), routeEnv);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('reflects authenticated requests and logs only operational metadata after the outcome', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const response = await worker.fetch(new Request('https://example.com/v1/reflect', {
        method: 'POST',
        headers: authorization,
        body: JSON.stringify({ query: 'Who manages Ada?', user_id: 'user-a', agent_id: 'agent-a' }),
      }), routeEnv);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        result: 'Chandra manages Ada through Benoit.',
        uncertainty: 'medium',
        request_id: expect.stringMatching(/^[A-Za-z0-9_-]{21}$/),
      });
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(log.mock.calls[0][0])).toEqual({
        event: 'reflect.completed',
        request_id: expect.stringMatching(/^[A-Za-z0-9_-]{21}$/),
        user_id: 'user-a',
        agent_id: 'agent-a',
        latency_ms: expect.any(Number),
      });
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ['malformed JSON', '{'],
    ['invalid payload', JSON.stringify({ query: '', user_id: 'user-a', agent_id: 'agent-a' })],
  ])('returns validation errors for %s', async (_name, body) => {
    const response = await worker.fetch(new Request('https://example.com/v1/reflect', {
      method: 'POST', headers: authorization, body,
    }), routeEnv);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Validation failed' });
    expect(dependencies.reflectWithGraphModel).not.toHaveBeenCalled();
  });

  it.each([
    ['configuration', new GraphLlmConfigurationError('Missing graph configuration'), 503, 'Graph reflection is not configured'],
    ['upstream', new UpstreamServiceError('Graph service unavailable', 503), 502, 'Graph reflection provider request failed'],
    ['unexpected', new Error('unexpected'), 500, 'Internal server error'],
  ])('maps %s reflection failures', async (_name, error, status, message) => {
    dependencies.reflectWithGraphModel.mockRejectedValueOnce(error);

    const response = await worker.fetch(new Request('https://example.com/v1/reflect', {
      method: 'POST',
      headers: authorization,
      body: JSON.stringify({ query: 'Who manages Ada?', user_id: 'user-a', agent_id: 'agent-a' }),
    }), routeEnv);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: message });
  });
});
