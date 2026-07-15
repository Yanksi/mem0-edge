import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { entities, memories, memoryEntityLinks, memoryRequests, relationships } from '../src/db/schema';

const dependencies = vi.hoisted(() => ({
  createDb: vi.fn(),
  embedText: vi.fn(),
  extractMemories: vi.fn(),
  upsertVectors: vi.fn(),
  upsertEntityVectors: vi.fn(),
  searchVectors: vi.fn(),
  searchEntityVectors: vi.fn(),
}));

vi.mock('../src/db/client', () => ({ createDb: dependencies.createDb }));
vi.mock('../src/llm', () => ({
  embedText: dependencies.embedText,
  extractMemories: dependencies.extractMemories,
}));
vi.mock('../src/vectorize', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/vectorize')>(),
  upsertVectors: dependencies.upsertVectors,
  upsertEntityVectors: dependencies.upsertEntityVectors,
  searchVectors: dependencies.searchVectors,
  searchEntityVectors: dependencies.searchEntityVectors,
}));

const service = vi.hoisted(() => ({
  addMemory: vi.fn(),
  searchMemories: vi.fn(),
  listMemories: vi.fn(),
  getMemory: vi.fn(),
  getMemoryById: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
}));

vi.mock('../src/memory/service', () => service);

import worker from '../src/index';

const env = {
  MEM0_API_KEY: 'test-api-key',
} as Env;

const authorization = { Authorization: 'Bearer test-api-key' };
const memory = {
  id: 'memory-123',
  memory: 'User lives in Zurich.',
  user_id: 'user-123',
  metadata: {},
  created_at: '2026-07-14T12:00:00.000Z',
  updated_at: '2026-07-14T12:00:00.000Z',
};

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://example.com${path}`, init);
}

function containsValue(value: unknown, expected: unknown, seen = new Set<unknown>()): boolean {
  if (value === expected) return true;
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) => containsValue((value as Record<PropertyKey, unknown>)[key], expected, seen));
}

function createLedgerDb(options: {
  claimRows?: Array<{ idempotencyKey: string }>;
  claimRowsSequence?: Array<Array<{ idempotencyKey: string }>>;
  ledgerRow?: Record<string, unknown>;
  retryRows?: Array<{ idempotencyKey?: string; leaseToken?: number; candidatesJson?: string | null }>;
}) {
  const claim = vi.fn();
  for (const rows of options.claimRowsSequence ?? [options.claimRows ?? []]) claim.mockResolvedValueOnce(rows);
  claim.mockResolvedValue([]);
  const getLedger = vi.fn().mockResolvedValue(options.ledgerRow);
  const memoryInsert = vi.fn().mockResolvedValue({});
  const requestUpdate = vi.fn().mockResolvedValue({});
  const requestWhere = vi.fn().mockReturnValue({
    run: requestUpdate,
    returning: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue(options.retryRows ?? [{ leaseToken: 1 }]) }),
  });

  return {
    insert: vi.fn((table: unknown) => {
      if (table === memoryRequests) {
        return {
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue({ all: claim }),
            }),
          }),
        };
      }
      return {
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({ run: memoryInsert }),
        }),
      };
    }),
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn().mockReturnValue(table === memoryRequests
          ? { get: getLedger }
          : { all: vi.fn().mockResolvedValue([]) }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn().mockReturnValue({
        where: requestWhere,
      }),
    })),
    requestWhere,
  };
}

const addRequest = {
  request_id: 'request-123',
  user_id: 'user-123',
  metadata: {},
  infer: true,
  async: false,
  messages: [{ role: 'user' as const, content: 'I live in Zurich.' }],
};

describe('addMemory idempotency ledger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('only lets the winning async claim enqueue the job', async () => {
    const db = createLedgerDb({ claimRows: [{ idempotencyKey: 'request-123' }] });
    dependencies.createDb.mockReturnValue(db);
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.addMemory({ ...env, MEMORY_JOBS: queue as unknown as Env['MEMORY_JOBS'] }, { ...addRequest, async: true }))
      .resolves.toEqual({ request_id: 'request-123', status: 'queued' });

    expect(queue.send).toHaveBeenCalledOnce();
    expect(dependencies.extractMemories).not.toHaveBeenCalled();
  });

  it('marks a failed async enqueue and resends after acquiring a new lease', async () => {
    const db = createLedgerDb({
      claimRowsSequence: [[{ idempotencyKey: 'request-123' }], []],
      ledgerRow: { status: 'failed' },
      retryRows: [{ leaseToken: 7, candidatesJson: null }],
    });
    dependencies.createDb.mockReturnValue(db);
    const queue = { send: vi.fn().mockRejectedValue(new Error('queue unavailable')) };
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.addMemory({ ...env, MEMORY_JOBS: queue as unknown as Env['MEMORY_JOBS'] }, { ...addRequest, async: true }))
      .rejects.toThrow('queue unavailable');
    await expect(actual.addMemory({ ...env, MEMORY_JOBS: queue as unknown as Env['MEMORY_JOBS'] }, { ...addRequest, async: true }))
      .rejects.toThrow('queue unavailable');

    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(db.update).toHaveBeenCalledTimes(3);
    expect(containsValue(db.requestWhere.mock.calls, 7)).toBe(true);
  });

  it('only lets the winning sync claim extract memories', async () => {
    const db = createLedgerDb({ claimRows: [{ idempotencyKey: 'request-123' }] });
    dependencies.createDb.mockReturnValue(db);
    dependencies.extractMemories.mockResolvedValue([{ memory: 'User lives in Zurich.' }]);
    dependencies.embedText.mockResolvedValue([0.1, 0.2]);
    dependencies.upsertVectors.mockResolvedValue(undefined);
    dependencies.upsertEntityVectors.mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await actual.addMemory(env, addRequest);

    expect(dependencies.extractMemories).toHaveBeenCalledOnce();
  });

  it('returns cached completed results without queueing or extracting', async () => {
    const cached = [{ ...memory }];
    const db = createLedgerDb({
      ledgerRow: { status: 'completed', resultJson: JSON.stringify(cached) },
    });
    dependencies.createDb.mockReturnValue(db);
    const queue = { send: vi.fn() };
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.addMemory({ ...env, MEMORY_JOBS: queue as unknown as Env['MEMORY_JOBS'] }, { ...addRequest, async: true }))
      .resolves.toEqual(cached);

    expect(queue.send).not.toHaveBeenCalled();
    expect(dependencies.extractMemories).not.toHaveBeenCalled();
  });

  it('returns an accepted result for a queued duplicate without queueing or extracting', async () => {
    const db = createLedgerDb({ ledgerRow: { status: 'queued' } });
    dependencies.createDb.mockReturnValue(db);
    const queue = { send: vi.fn() };
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.addMemory({ ...env, MEMORY_JOBS: queue as unknown as Env['MEMORY_JOBS'] }, { ...addRequest, async: true }))
      .resolves.toEqual({ request_id: 'request-123', status: 'queued' });

    expect(queue.send).not.toHaveBeenCalled();
    expect(dependencies.extractMemories).not.toHaveBeenCalled();
  });

  it('retries a failed request only after winning its conditional ledger transition', async () => {
    const db = createLedgerDb({
      ledgerRow: { status: 'failed' },
      retryRows: [{ leaseToken: 1, candidatesJson: null }],
    });
    dependencies.createDb.mockReturnValue(db);
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.addMemory({ ...env, MEMORY_JOBS: queue as unknown as Env['MEMORY_JOBS'] }, { ...addRequest, async: true }))
      .resolves.toEqual({ request_id: 'request-123', status: 'queued' });

    expect(queue.send).toHaveBeenCalledOnce();
  });

  it('reuses deterministic memory and history IDs after a partial write retry', async () => {
    const requestClaim = vi.fn()
      .mockResolvedValueOnce([{ idempotencyKey: 'request-123' }])
      .mockResolvedValueOnce([]);
    const candidatesJson = JSON.stringify([{
      memory: 'User lives in Zurich.',
      entities: [{ name: 'User', type: 'person' }, { name: 'Zurich', type: 'city' }],
      relationships: [{ source: 'User', target: 'Zurich', relation_type: 'lives_in' }],
    }]);
    const failedLedger = vi.fn().mockResolvedValue({ status: 'failed', candidatesJson });
    const memoryRun = vi.fn().mockResolvedValue({});
    const historyRun = vi.fn().mockRejectedValueOnce(new Error('history insert failed')).mockResolvedValue({});
    const requestRun = vi.fn().mockResolvedValue({});
    const retryClaim = vi.fn().mockResolvedValue([{ leaseToken: 2, candidatesJson }]);
    const db = {
      insert: vi.fn((table: unknown) => {
        if (table === memoryRequests) {
          return {
            values: vi.fn().mockReturnValue({
              onConflictDoNothing: vi.fn().mockReturnValue({
                returning: vi.fn().mockReturnValue({ all: requestClaim }),
              }),
            }),
          };
        }
        const run = table === memories ? memoryRun : historyRun;
        return {
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({ run }),
          }),
        };
      }),
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockReturnValue({ get: failedLedger, all: vi.fn().mockResolvedValue([]) }) })),
      })),
      update: vi.fn(() => ({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ run: requestRun, returning: vi.fn().mockReturnValue({ all: retryClaim }) }),
        }),
      })),
    };
    dependencies.createDb.mockReturnValue(db);
    dependencies.extractMemories.mockResolvedValue([{ memory: 'User lives in Zurich.' }]);
    dependencies.embedText.mockResolvedValue([0.1, 0.2]);
    dependencies.upsertVectors.mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.addMemory(env, addRequest)).rejects.toThrow('history insert failed');
    await expect(actual.addMemory(env, addRequest)).resolves.toHaveLength(1);

    expect(dependencies.extractMemories).toHaveBeenCalledOnce();
    const memoryRows = db.insert.mock.calls
      .filter(([table]) => table === memories)
      .map(([,]) => undefined);
    const memoryValues = db.insert.mock.results
      .filter((result, index) => db.insert.mock.calls[index]?.[0] === memories)
      .map((result) => result.value.values.mock.calls[0][0]);
    const historyValues = db.insert.mock.results
      .filter((result, index) => db.insert.mock.calls[index]?.[0] !== memories && db.insert.mock.calls[index]?.[0] !== memoryRequests)
      .map((result) => result.value.values.mock.calls[0][0]);

    expect(memoryRows).toHaveLength(2);
    expect(memoryValues[1].id).toBe(memoryValues[0].id);
    expect(historyValues[1].id).toBe(historyValues[0].id);
    expect(dependencies.upsertVectors.mock.calls[1][1][0].id).toBe(dependencies.upsertVectors.mock.calls[0][1][0].id);
    expect(db.insert.mock.calls.some(([table]) => table === entities)).toBe(true);
    expect(db.insert.mock.calls.some(([table]) => table === memoryEntityLinks)).toBe(true);
    expect(db.insert.mock.calls.some(([table]) => table === relationships)).toBe(true);
  });

  it('persists extracted graph entities, links, and relationships after the memory row', async () => {
    const graphInserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const db = {
      insert: vi.fn((table: unknown) => {
        if (table === memoryRequests) {
          return { values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockReturnValue({ returning: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue([{ idempotencyKey: 'request-123' }]) }) }) }) };
        }
        const values = vi.fn((row: Record<string, unknown>) => {
          graphInserts.push({ table, values: row });
          return { onConflictDoNothing: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({}) }) };
        });
        return { values };
      }),
      update: vi.fn(() => ({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({}), returning: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue([{ leaseToken: 1 }]) }) }) }) })),
      select: vi.fn(),
    };
    dependencies.createDb.mockReturnValue(db);
    dependencies.extractMemories.mockResolvedValue([{
      memory: 'Ada works at Acme.',
      entities: [{ name: 'Ada', type: 'person', summary: 'Engineer' }, { name: 'Acme', type: 'company' }],
      relationships: [{ source: 'Ada', target: 'Acme', relation_type: 'works_at', confidence: 0.9 }],
    }]);
    dependencies.embedText.mockResolvedValue([0.1, 0.2]);
    dependencies.upsertVectors.mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await actual.addMemory(env, addRequest);

    const entityRows = graphInserts.filter(({ table }) => table === entities).map(({ values }) => values);
    const linkRows = graphInserts.filter(({ table }) => table === memoryEntityLinks).map(({ values }) => values);
    const relationshipRows = graphInserts.filter(({ table }) => table === relationships).map(({ values }) => values);
    expect(entityRows).toHaveLength(2);
    expect(entityRows.every((row) => row.userId === 'user-123')).toBe(true);
    expect(linkRows).toHaveLength(2);
    expect(relationshipRows).toEqual([expect.objectContaining({ userId: 'user-123', relationType: 'works_at', confidence: 0.9 })]);
    expect(dependencies.upsertEntityVectors).toHaveBeenCalledWith(
      env.ENTITY_VECTORIZE,
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(String),
          values: [0.1, 0.2],
          metadata: expect.objectContaining({ user_id: 'user-123', entity: 'ada' }),
        }),
      ]),
    );
  });

  it('does not persist graph rows when inference is disabled', async () => {
    const db = createLedgerDb({ claimRows: [{ idempotencyKey: 'request-123' }] });
    dependencies.createDb.mockReturnValue(db);
    dependencies.embedText.mockResolvedValue([0.1, 0.2]);
    dependencies.upsertVectors.mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await actual.addMemory(env, { ...addRequest, infer: false });

    expect(db.insert).not.toHaveBeenCalledWith(entities);
    expect(db.insert).not.toHaveBeenCalledWith(memoryEntityLinks);
    expect(db.insert).not.toHaveBeenCalledWith(relationships);
    expect(dependencies.upsertEntityVectors).not.toHaveBeenCalled();
  });
});

describe('user-scoped entity-linked search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('boosts only semantic candidates linked to matching entities', async () => {
    const semanticRows = [
      { id: 'semantic-first', content: 'Other memory', userId: 'user-123', agentId: null, runId: null, actorId: null, metadataJson: '{}', hash: 'a', createdAt: 1, updatedAt: 1, deletedAt: null },
      { id: 'entity-linked', content: 'Ada works at Acme', userId: 'user-123', agentId: null, runId: null, actorId: null, metadataJson: '{}', hash: 'b', createdAt: 1, updatedAt: 1, deletedAt: null },
    ];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn().mockReturnValue(table === memories
            ? { all: vi.fn().mockResolvedValue(semanticRows) }
            : { all: vi.fn().mockResolvedValue([
              { memoryId: 'entity-linked', entityId: 'entity-ada' },
              { memoryId: 'outside-pool', entityId: 'entity-ada' },
            ]) }),
        })),
      })),
    };
    dependencies.createDb.mockReturnValue(db);
    dependencies.embedText.mockResolvedValue([0.1, 0.2]);
    dependencies.searchVectors.mockResolvedValue([
      { id: 'semantic-first', score: 0.9 },
      { id: 'entity-linked', score: 0.84 },
    ]);
    dependencies.searchEntityVectors.mockResolvedValue([{ id: 'entity-ada', score: 1 }]);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    const results = await actual.searchMemories(env, { query: 'Where does Ada work?', user_id: 'user-123', filters: {}, limit: 2 });

    expect(dependencies.embedText).toHaveBeenCalledOnce();
    expect(dependencies.searchVectors).toHaveBeenCalledWith(env.VECTORIZE, [0.1, 0.2], expect.anything(), { candidatePool: 50 });
    expect(dependencies.searchEntityVectors).toHaveBeenCalledWith(env.ENTITY_VECTORIZE, [0.1, 0.2], 'user-123');
    expect(results.map(({ id }) => id)).toEqual(['entity-linked', 'semantic-first']);
    expect(results.map(({ id }) => id)).not.toContain('outside-pool');
  });

  it('preserves semantic score order when no entity links match', async () => {
    const rows = [
      { id: 'a', content: 'First', userId: 'user-123', agentId: null, runId: null, actorId: null, metadataJson: '{}', hash: 'a', createdAt: 1, updatedAt: 1, deletedAt: null },
      { id: 'b', content: 'Second', userId: 'user-123', agentId: null, runId: null, actorId: null, metadataJson: '{}', hash: 'b', createdAt: 1, updatedAt: 1, deletedAt: null },
    ];
    dependencies.createDb.mockReturnValue({ select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue(rows) }) })) })) });
    dependencies.embedText.mockResolvedValue([0.1, 0.2]);
    dependencies.searchVectors.mockResolvedValue([{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }]);
    dependencies.searchEntityVectors.mockResolvedValue([]);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.searchMemories(env, { query: 'query', user_id: 'user-123', filters: {}, limit: 2 }))
      .resolves.toMatchObject([{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }]);
  });

  it('keeps agent-scoped search semantic-only', async () => {
    const row = { id: 'agent-memory', content: 'Agent note', userId: null, agentId: 'agent-123', runId: null, actorId: null, metadataJson: '{}', hash: 'a', createdAt: 1, updatedAt: 1, deletedAt: null };
    dependencies.createDb.mockReturnValue({ select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue([row]) }) })) })) });
    dependencies.embedText.mockResolvedValue([0.1, 0.2]);
    dependencies.searchVectors.mockResolvedValue([{ id: 'agent-memory', score: 0.9 }]);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.searchMemories(env, { query: 'query', agent_id: 'agent-123', filters: {}, limit: 1 }))
      .resolves.toMatchObject([{ id: 'agent-memory', score: 0.9 }]);

    expect(dependencies.searchVectors).toHaveBeenCalledWith(env.VECTORIZE, [0.1, 0.2], expect.anything());
    expect(dependencies.searchEntityVectors).not.toHaveBeenCalled();
  });
});

describe('/v1/memories routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires API authentication', async () => {
    const response = await worker.fetch(request('/v1/memories'), env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('adds a memory and returns its result envelope', async () => {
    service.addMemory.mockResolvedValue([memory]);
    const body = {
      request_id: 'request-123',
      user_id: 'user-123',
      messages: [{ role: 'user', content: 'I live in Zurich.' }],
    };

    const response = await worker.fetch(request('/v1/memories', {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [memory] });
    expect(service.addMemory).toHaveBeenCalledWith(env, {
      ...body,
      metadata: {},
      infer: true,
      async: false,
    });
  });

  it('returns an accepted response for async additions with the stable request ID', async () => {
    service.addMemory.mockResolvedValue({ request_id: 'request-123', status: 'queued' });
    const body = {
      request_id: 'request-123',
      user_id: 'user-123',
      messages: [{ role: 'user', content: 'I live in Zurich.' }],
      async: true,
    };

    const response = await worker.fetch(request('/v1/memories', {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), env);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ request_id: 'request-123', status: 'queued' });
  });

  it('returns structured 400 validation errors for malformed and invalid JSON bodies', async () => {
    const malformed = await worker.fetch(request('/v1/memories', {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: '{',
    }), env);
    const invalid = await worker.fetch(request('/v1/memories/search', {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Zurich' }),
    }), env);

    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual(expect.objectContaining({ error: 'Validation failed' }));
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual(expect.objectContaining({ error: 'Validation failed' }));
    expect(service.addMemory).not.toHaveBeenCalled();
    expect(service.searchMemories).not.toHaveBeenCalled();
  });

  it('searches with parsed defaults and returns a result envelope', async () => {
    service.searchMemories.mockResolvedValue([{ ...memory, score: 0.98 }]);

    const response = await worker.fetch(request('/v1/memories/search', {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Where does the user live?', user_id: 'user-123' }),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [{ ...memory, score: 0.98 }] });
    expect(service.searchMemories).toHaveBeenCalledWith(env, {
      query: 'Where does the user live?', user_id: 'user-123', limit: 10, filters: {},
    });
  });

  it('requires user_id for lists and caps route results through the service', async () => {
    const missingUser = await worker.fetch(request('/v1/memories', { headers: authorization }), env);
    service.listMemories.mockResolvedValue([memory]);
    const response = await worker.fetch(request('/v1/memories?user_id=user-123&limit=999', { headers: authorization }), env);

    expect(missingUser.status).toBe(400);
    await expect(missingUser.json()).resolves.toEqual(expect.objectContaining({ error: 'Validation failed' }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [memory] });
    expect(service.listMemories).toHaveBeenCalledWith(env, 'user-123', 100);
  });

  it('requires user_id for individual memory operations', async () => {
    const get = await worker.fetch(request('/v1/memories/memory-123', { headers: authorization }), env);
    const patch = await worker.fetch(request('/v1/memories/memory-123', {
      method: 'PATCH', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ metadata: {} }),
    }), env);
    const remove = await worker.fetch(request('/v1/memories/memory-123', { method: 'DELETE', headers: authorization }), env);

    for (const response of [get, patch, remove]) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual(expect.objectContaining({ error: 'Validation failed' }));
    }
    expect(service.getMemory).not.toHaveBeenCalled();
    expect(service.updateMemory).not.toHaveBeenCalled();
    expect(service.deleteMemory).not.toHaveBeenCalled();
  });

  it('gets, updates, and deletes individual memories scoped to user_id', async () => {
    service.getMemory.mockResolvedValueOnce(null).mockResolvedValueOnce(memory);
    service.updateMemory.mockResolvedValue(memory);
    service.deleteMemory.mockResolvedValue(true);

    const missing = await worker.fetch(request('/v1/memories/missing?user_id=wrong-owner', { headers: authorization }), env);
    const found = await worker.fetch(request('/v1/memories/memory-123?user_id=user-123', { headers: authorization }), env);
    const updated = await worker.fetch(request('/v1/memories/memory-123?user_id=user-123', {
      method: 'PATCH', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ metadata: { source: 'api' } }),
    }), env);
    const deleted = await worker.fetch(request('/v1/memories/memory-123?user_id=user-123', { method: 'DELETE', headers: authorization }), env);

    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: 'Memory not found' });
    expect(found.status).toBe(200);
    await expect(found.json()).resolves.toEqual(memory);
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toEqual(memory);
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ deleted: true });
    expect(service.getMemory).toHaveBeenNthCalledWith(1, env, 'missing', 'wrong-owner');
    expect(service.getMemory).toHaveBeenNthCalledWith(2, env, 'memory-123', 'user-123');
    expect(service.updateMemory).toHaveBeenCalledWith(env, 'memory-123', 'user-123', { metadata: { source: 'api' } });
    expect(service.deleteMemory).toHaveBeenCalledWith(env, 'memory-123', 'user-123');
  });

  it('returns 400 for an invalid update rather than passing it to the service', async () => {
    const response = await worker.fetch(request('/v1/memories/memory-123?user_id=user-123', {
      method: 'PATCH', headers: { ...authorization, 'Content-Type': 'application/json' }, body: '{}',
    }), env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ error: 'Validation failed' }));
    expect(service.updateMemory).not.toHaveBeenCalled();
  });

  it('returns JSON for unexpected application errors', async () => {
    service.searchMemories.mockRejectedValue(new Error('database unavailable'));

    const response = await worker.fetch(request('/v1/memories/search', {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Zurich', user_id: 'user-123' }),
    }), env);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' });
  });
});

describe('Hermes self-hosted compatibility routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts Hermes X-API-Key memory writes and preserves the supplied user scope', async () => {
    service.addMemory.mockResolvedValue([memory]);
    const body = {
      user_id: 'hermes-user',
      agent_id: 'hermes',
      infer: false,
      messages: [{ role: 'user', content: 'I live in Zurich.' }],
    };

    const response = await worker.fetch(request('/memories', {
      method: 'POST',
      headers: { 'X-API-Key': 'test-api-key', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [memory] });
    expect(service.addMemory).toHaveBeenCalledWith(env, {
      ...body,
      metadata: {},
      async: false,
    });
  });

  it('maps Hermes filter user_id and top_k into the Worker search scope', async () => {
    service.searchMemories.mockResolvedValue([{ ...memory, score: 0.98 }]);

    const response = await worker.fetch(request('/search', {
      method: 'POST',
      headers: { 'X-API-Key': 'test-api-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'Where does the user live?',
        top_k: 7,
        filters: { user_id: 'hermes-user' },
      }),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [{ ...memory, score: 0.98 }] });
    expect(service.searchMemories).toHaveBeenCalledWith(env, {
      query: 'Where does the user live?',
      user_id: 'hermes-user',
      limit: 7,
      filters: {},
    });
  });

  it('resolves the stored owner before Hermes updates and deletes by memory ID', async () => {
    service.getMemoryById.mockResolvedValue(memory);
    service.updateMemory.mockResolvedValue({ ...memory, memory: 'User now lives in Bern.' });
    service.deleteMemory.mockResolvedValue(true);

    const updated = await worker.fetch(request('/memories/memory-123', {
      method: 'PUT',
      headers: { 'X-API-Key': 'test-api-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'User now lives in Bern.' }),
    }), env);
    const deleted = await worker.fetch(request('/memories/memory-123', {
      method: 'DELETE',
      headers: { 'X-API-Key': 'test-api-key' },
    }), env);

    expect(updated.status).toBe(200);
    expect(deleted.status).toBe(200);
    expect(service.updateMemory).toHaveBeenCalledWith(env, 'memory-123', 'user-123', {
      memory: 'User now lives in Bern.',
    });
    expect(service.deleteMemory).toHaveBeenCalledWith(env, 'memory-123', 'user-123');
  });

  it('accepts Hermes search requests at /v1/search and keeps identity filters out of metadata filters', async () => {
    service.searchMemories.mockResolvedValue([{ ...memory, score: 0.98 }]);

    const response = await worker.fetch(request('/v1/search', {
      method: 'POST',
      headers: { 'X-API-Key': 'test-api-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'Where does the user live?',
        top_k: 7,
        filters: {
          user_id: 'hermes-user',
          agent_id: 'neko-chan',
          run_id: 'run-123',
          channel: 'discord',
        },
      }),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [{ ...memory, score: 0.98 }] });
    expect(service.searchMemories).toHaveBeenCalledWith(env, {
      query: 'Where does the user live?',
      user_id: 'hermes-user',
      agent_id: 'neko-chan',
      run_id: 'run-123',
      limit: 7,
      filters: { channel: 'discord' },
    });
  });

  it('accepts the Hermes search body at the native search path', async () => {
    service.searchMemories.mockResolvedValue([]);

    const response = await worker.fetch(request('/v1/memories/search', {
      method: 'POST',
      headers: { 'X-API-Key': 'test-api-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Where does the user live?', top_k: 7, filters: { user_id: 'hermes-user' } }),
    }), env);

    expect(response.status).toBe(200);
    expect(service.searchMemories).toHaveBeenCalledWith(env, {
      query: 'Where does the user live?', user_id: 'hermes-user', limit: 7, filters: {},
    });
  });

  it('resolves a SHA-256-like ID for Hermes /v1 PUT and DELETE requests', async () => {
    const id = 'a'.repeat(64);
    service.getMemoryById.mockResolvedValue({ ...memory, id });
    service.updateMemory.mockResolvedValue({ ...memory, id, memory: 'User now lives in Bern.' });
    service.deleteMemory.mockResolvedValue(true);

    const updated = await worker.fetch(request(`/v1/memories/${id}`, {
      method: 'PUT',
      headers: { 'X-API-Key': 'test-api-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'User now lives in Bern.' }),
    }), env);
    const deleted = await worker.fetch(request(`/v1/memories/${id}`, {
      method: 'DELETE', headers: { 'X-API-Key': 'test-api-key' },
    }), env);

    expect(updated.status).toBe(200);
    expect(deleted.status).toBe(200);
    expect(service.updateMemory).toHaveBeenCalledWith(env, id, 'user-123', { memory: 'User now lives in Bern.' });
    expect(service.deleteMemory).toHaveBeenCalledWith(env, id, 'user-123');
  });
});
