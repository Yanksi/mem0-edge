import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { entities, memories, memoryEntityLinks, memoryHistory, memoryRequests, relationships } from '../src/db/schema';
import { sha256Hex } from '../src/memory/idempotency';

const dependencies = vi.hoisted(() => ({
  createDb: vi.fn(),
  embedText: vi.fn(),
  extractMemories: vi.fn(),
  extractMemoryGraph: vi.fn(),
  upsertVectors: vi.fn(),
  upsertEntityVectors: vi.fn(),
  deleteVector: vi.fn(),
  searchVectors: vi.fn(),
  searchEntityVectors: vi.fn(),
  prepareMemoryWrite: vi.fn(),
  findActiveExactMemory: vi.fn(),
}));

vi.mock('../src/db/client', () => ({ createDb: dependencies.createDb }));
vi.mock('../src/llm', () => ({
  embedText: dependencies.embedText,
  extractMemories: dependencies.extractMemories,
  extractMemoryGraph: dependencies.extractMemoryGraph,
}));
vi.mock('../src/vectorize', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/vectorize')>(),
  upsertVectors: dependencies.upsertVectors,
  upsertEntityVectors: dependencies.upsertEntityVectors,
  deleteVector: dependencies.deleteVector,
  searchVectors: dependencies.searchVectors,
  searchEntityVectors: dependencies.searchEntityVectors,
}));
vi.mock('../src/memory/deduplication', () => ({
  prepareMemoryWrite: dependencies.prepareMemoryWrite,
  findActiveExactMemory: dependencies.findActiveExactMemory,
}));

const service = vi.hoisted(() => {
  class MemoryContentConflictError extends Error {}
  class MemoryMutationConflictError extends Error {}
  class DurableMemoryMutationError extends Error {
    constructor(readonly mutationId: string, message: string) { super(message); }
  }
  return {
    addMemory: vi.fn(),
    searchMemories: vi.fn(),
    listMemories: vi.fn(),
    getMemory: vi.fn(),
    getMemoryById: vi.fn(),
    getMemoryOwnerById: vi.fn(),
    updateMemory: vi.fn(),
    deleteMemory: vi.fn(),
    MemoryContentConflictError,
    MemoryMutationConflictError,
    DurableMemoryMutationError,
  };
});

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
  const requestSet = vi.fn().mockReturnValue({ where: requestWhere });

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
        values: vi.fn((row: Record<string, unknown>) => ({
          onConflictDoNothing: vi.fn().mockReturnValue({
            run: memoryInsert,
            returning: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue(table === memories ? row : undefined) }),
          }),
        })),
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
      set: requestSet,
    })),
    requestWhere,
    requestSet,
  };
}

function createMemoryWriteDb(options: {
  claimRows?: Array<{ idempotencyKey: string }>;
  ledgerRow?: Record<string, unknown>;
  retryRows?: Array<Record<string, unknown>>;
  memoryInsertResults?: Array<Record<string, unknown> | undefined>;
  memoryGetRows?: Array<Record<string, unknown> | undefined>;
  cleanupUpdateRows?: Array<Array<Record<string, unknown>>>;
} = {}) {
  const requestClaim = vi.fn().mockResolvedValue(options.claimRows ?? [{ idempotencyKey: 'request-123' }]);
  const getLedger = vi.fn().mockResolvedValue(options.ledgerRow);
  const memoryInsertGet = vi.fn();
  for (const row of options.memoryInsertResults ?? []) memoryInsertGet.mockResolvedValueOnce(row);
  memoryInsertGet.mockResolvedValue(undefined);
  const memoryGet = vi.fn();
  for (const row of options.memoryGetRows ?? []) memoryGet.mockResolvedValueOnce(row);
  memoryGet.mockResolvedValue(undefined);
  const insertValues: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const requestUpdates: Array<Record<string, unknown>> = [];
  const cleanupUpdateRows = [...(options.cleanupUpdateRows ?? [])];
  const requestSet = vi.fn((values: Record<string, unknown>) => {
    requestUpdates.push(values);
    const retryTransition = 'leaseToken' in values && (values.status === 'processing' || values.status === 'queued');
    const cleanupTransition = 'cleanupVectorIdsJson' in values;
    return {
      where: vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({}),
        returning: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue(
            retryTransition
              ? (options.retryRows ?? [{ leaseToken: 2, candidatesJson: null, cleanupVectorIdsJson: null }])
              : cleanupTransition && cleanupUpdateRows.length > 0
                ? cleanupUpdateRows.shift()
                : [{ leaseToken: 1 }],
          ),
        }),
      }),
    };
  });

  const db = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) => {
        insertValues.push({ table, values });
        if (table === memoryRequests) {
          return {
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue({ all: requestClaim }),
            }),
          };
        }
        return {
          onConflictDoNothing: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({}),
            returning: vi.fn().mockReturnValue({ get: memoryInsertGet }),
          }),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn().mockReturnValue(table === memoryRequests
          ? { get: getLedger, all: vi.fn().mockResolvedValue([]) }
          : { get: memoryGet, all: vi.fn().mockResolvedValue([]) }),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: table === memoryRequests
        ? requestSet
        : vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({}) }) }),
    })),
  };

  return { db, insertValues, requestSet, requestUpdates };
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
    dependencies.prepareMemoryWrite.mockImplementation(async (_env, _scope, content: string) => ({
      contentHash: `digest:${content}`,
      exactScopeKey: 'scope-key',
    }));
    dependencies.findActiveExactMemory.mockResolvedValue(undefined);
    dependencies.deleteVector.mockResolvedValue(undefined);
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

  it('persists inferred candidates trimmed and exact-deduplicated in first-seen order', async () => {
    const db = createLedgerDb({ claimRows: [{ idempotencyKey: 'request-123' }] });
    dependencies.createDb.mockReturnValue(db);
    dependencies.extractMemories.mockResolvedValue([
      { memory: '  First fact  ', entities: [], relationships: [] },
      { memory: 'First fact', entities: [{ name: 'ignored duplicate' }], relationships: [] },
      { memory: '   ', entities: [], relationships: [] },
      { memory: 'Second fact', entities: [], relationships: [] },
      { memory: ' Second fact ', entities: [], relationships: [] },
    ]);
    dependencies.embedText.mockResolvedValue([0.1, 0.2]);
    dependencies.upsertVectors.mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    const result = await actual.addMemory(env, addRequest);

    const persisted = db.requestSet.mock.calls
      .map(([values]) => values as { candidatesJson?: string })
      .find(({ candidatesJson }) => candidatesJson !== undefined);
    expect(JSON.parse(persisted?.candidatesJson ?? 'null')).toEqual([
      { memory: 'First fact', entities: [], relationships: [] },
      { memory: 'Second fact', entities: [], relationships: [] },
    ]);
    expect(Array.isArray(result) ? result.map(({ memory }) => memory) : result).toEqual(['First fact', 'Second fact']);
  });

  it('persists the final trimmed direct candidate for lease retries', async () => {
    const db = createLedgerDb({ claimRows: [{ idempotencyKey: 'request-123' }] });
    dependencies.createDb.mockReturnValue(db);
    dependencies.embedText.mockResolvedValue([0.1, 0.2]);
    dependencies.upsertVectors.mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    const result = await actual.addMemory(env, {
      ...addRequest,
      infer: false,
      messages: [{ role: 'user', content: '  Direct fact  ' }],
    });

    const persisted = db.requestSet.mock.calls
      .map(([values]) => values as { candidatesJson?: string })
      .find(({ candidatesJson }) => candidatesJson !== undefined);
    expect(JSON.parse(persisted?.candidatesJson ?? 'null')).toEqual([
      { memory: 'Direct fact', entities: [], relationships: [] },
    ]);
    expect(Array.isArray(result) ? result.map(({ memory }) => memory) : result).toEqual(['Direct fact']);
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
    let storedMemory: Record<string, unknown> | undefined;
    const historyRun = vi.fn().mockRejectedValueOnce(new Error('history insert failed')).mockResolvedValue({});
    const requestRun = vi.fn().mockResolvedValue({});
    const retryClaim = vi.fn().mockResolvedValue([{ leaseToken: 2, candidatesJson, cleanupVectorIdsJson: null }]);
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
        return {
          values: vi.fn((row: Record<string, unknown>) => {
            if (table === memories) storedMemory = row;
            return {
              onConflictDoNothing: vi.fn().mockReturnValue(table === memories
                ? { returning: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue(row) }) }
                : { run: historyRun }),
            };
          }),
        };
      }),
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn().mockReturnValue({
            get: table === memoryRequests ? failedLedger : vi.fn().mockImplementation(async () => storedMemory),
            all: vi.fn().mockResolvedValue([]),
          }),
        })),
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

    expect(memoryRows).toHaveLength(1);
    expect(memoryValues[0].id).toEqual(expect.any(String));
    expect(historyValues[1].id).toBe(historyValues[0].id);
    expect(dependencies.upsertVectors).toHaveBeenCalledOnce();
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
          return {
            onConflictDoNothing: vi.fn().mockReturnValue(table === memories
              ? { returning: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue(row) }) }
              : { run: vi.fn().mockResolvedValue({}) }),
          };
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

  it('returns an existing exact duplicate without embedding or write side effects', async () => {
    const canonical = { ...memoryRow('canonical', 'Existing fact'), contentHash: 'exact-digest' };
    const { db, insertValues, requestUpdates } = createMemoryWriteDb();
    dependencies.createDb.mockReturnValue(db);
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'exact-digest',
      exactScopeKey: 'scope-key',
      duplicate: canonical,
    });
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.addMemory(env, { ...addRequest, infer: false })).resolves.toEqual([
      expect.objectContaining({ id: 'canonical', memory: 'Existing fact' }),
    ]);

    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
    expect(requestUpdates.some(({ cleanupVectorIdsJson }) => cleanupVectorIdsJson !== undefined)).toBe(false);
    expect(insertValues.some(({ table }) => table === memories)).toBe(false);
    expect(insertValues.some(({ table }) => table !== memoryRequests)).toBe(false);
  });

  it('returns a semantic duplicate canonically without persistence side effects', async () => {
    const canonical = { ...memoryRow('semantic-winner', 'Canonical wording'), contentHash: 'winner-digest' };
    const { db, insertValues } = createMemoryWriteDb();
    dependencies.createDb.mockReturnValue(db);
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'new-digest',
      exactScopeKey: 'scope-key',
      embedding: [0.7, 0.8],
      duplicate: canonical,
    });
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.addMemory(env, { ...addRequest, infer: false })).resolves.toEqual([
      expect.objectContaining({ id: 'semantic-winner', memory: 'Canonical wording' }),
    ]);

    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    expect(insertValues.some(({ table }) => table !== memoryRequests)).toBe(false);
  });

  it('reuses the prepared embedding and writes content hash plus scoped vector metadata', async () => {
    const { db, insertValues } = createMemoryWriteDb({
      memoryInsertResults: [memoryRow('inserted-placeholder', 'unused')],
    });
    dependencies.createDb.mockReturnValue(db);
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'new-content-digest',
      exactScopeKey: 'scope-key',
      embedding: [0.3, 0.4],
    });
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await actual.addMemory(env, { ...addRequest, infer: false, agent_id: 'agent-123' });

    expect(dependencies.embedText).not.toHaveBeenCalled();
    const insertedRow = insertValues.find(({ table }) => table === memories)?.values;
    expect(insertedRow).toEqual(expect.objectContaining({ contentHash: 'new-content-digest' }));
    expect(dependencies.upsertVectors).toHaveBeenCalledWith(env.VECTORIZE, [expect.objectContaining({
      values: [0.3, 0.4],
      metadata: expect.objectContaining({ scope_key: expect.any(String) }),
    })]);
  });

  it.each([
    ['without an agent', undefined, null],
    ['with an agent', 'agent-123', 'agent-123'],
  ] as const)('prepares a normal new candidate with full scope %s', async (_label, agentId, expectedAgentId) => {
    const { db } = createMemoryWriteDb({
      memoryInsertResults: [memoryRow('inserted-placeholder', 'Scoped fact')],
    });
    dependencies.createDb.mockReturnValue(db);
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'scoped-content-digest',
      exactScopeKey: 'scope-key',
      embedding: [0.2, 0.4],
    });
    dependencies.upsertVectors.mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await actual.addMemory(env, {
      ...addRequest,
      infer: false,
      ...(agentId === undefined ? {} : { agent_id: agentId }),
      messages: [{ role: 'user', content: 'Scoped fact' }],
    });

    expect(dependencies.prepareMemoryWrite).toHaveBeenCalledOnce();
    expect(dependencies.prepareMemoryWrite).toHaveBeenCalledWith(
      env,
      { userId: 'user-123', agentId: expectedAgentId },
      'Scoped fact',
    );
  });

  it('embeds a normal new candidate exactly once when preparation has no embedding', async () => {
    const { db } = createMemoryWriteDb({
      memoryInsertResults: [memoryRow('inserted-placeholder', 'Fallback fact')],
    });
    dependencies.createDb.mockReturnValue(db);
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'fallback-content-digest',
      exactScopeKey: 'scope-key',
    });
    dependencies.embedText.mockResolvedValue([0.6, 0.8]);
    dependencies.upsertVectors.mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await actual.addMemory(env, {
      ...addRequest,
      infer: false,
      messages: [{ role: 'user', content: 'Fallback fact' }],
    });

    expect(dependencies.embedText).toHaveBeenCalledOnce();
    expect(dependencies.embedText).toHaveBeenCalledWith(env, 'Fallback fact');
    expect(dependencies.upsertVectors).toHaveBeenCalledWith(env.VECTORIZE, [expect.objectContaining({
      values: [0.6, 0.8],
    })]);
  });

  it('upserts the candidate vector before attempting the memory row insert', async () => {
    const { db } = createMemoryWriteDb({
      memoryInsertResults: [memoryRow('inserted-placeholder', 'Ordered fact')],
    });
    dependencies.createDb.mockReturnValue(db);
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'ordered-content-digest',
      exactScopeKey: 'scope-key',
      embedding: [0.1, 0.9],
    });
    dependencies.upsertVectors.mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await actual.addMemory(env, {
      ...addRequest,
      infer: false,
      messages: [{ role: 'user', content: 'Ordered fact' }],
    });

    const memoryInsertCall = db.insert.mock.calls.findIndex(([table]) => table === memories);
    expect(memoryInsertCall).toBeGreaterThanOrEqual(0);
    expect(dependencies.upsertVectors.mock.invocationCallOrder[0])
      .toBeLessThan(db.insert.mock.invocationCallOrder[memoryInsertCall]);
  });

  it('deletes a concurrent unique-index loser vector and returns the exact winner', async () => {
    const winner = { ...memoryRow('concurrent-winner', 'Direct fact'), contentHash: 'digest:Direct fact' };
    const { db, requestSet, requestUpdates } = createMemoryWriteDb({
      memoryInsertResults: [undefined],
      memoryGetRows: [undefined],
    });
    dependencies.createDb.mockReturnValue(db);
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'digest:Direct fact', exactScopeKey: 'scope-key', embedding: [0.5, 0.6],
    });
    dependencies.findActiveExactMemory.mockResolvedValue(winner);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.addMemory(env, { ...addRequest, infer: false, messages: [{ role: 'user', content: 'Direct fact' }] }))
      .resolves.toEqual([expect.objectContaining({ id: 'concurrent-winner' })]);

    const candidateId = dependencies.upsertVectors.mock.calls[0][1][0].id;
    expect(dependencies.deleteVector).toHaveBeenCalledWith(env.VECTORIZE, candidateId);
    expect(requestUpdates).toContainEqual(expect.objectContaining({ cleanupVectorIdsJson: JSON.stringify([candidateId]) }));
    expect(requestUpdates).toContainEqual(expect.objectContaining({ cleanupVectorIdsJson: null }));
    const markerCall = requestSet.mock.calls.findIndex(([values]) => values.cleanupVectorIdsJson === JSON.stringify([candidateId]));
    expect(requestSet.mock.invocationCallOrder[markerCall]).toBeLessThan(dependencies.deleteVector.mock.invocationCallOrder[0]);
  });

  it('retains the cleanup marker when losing-vector deletion fails', async () => {
    const winner = { ...memoryRow('concurrent-winner', 'Direct fact'), contentHash: 'digest:Direct fact' };
    const { db, requestUpdates } = createMemoryWriteDb({
      memoryInsertResults: [undefined],
      memoryGetRows: [undefined],
    });
    dependencies.createDb.mockReturnValue(db);
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'digest:Direct fact', exactScopeKey: 'scope-key', embedding: [0.5, 0.6],
    });
    dependencies.findActiveExactMemory.mockResolvedValue(winner);
    dependencies.deleteVector.mockRejectedValue(new Error('vector deletion unavailable'));
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.addMemory(env, { ...addRequest, infer: false, messages: [{ role: 'user', content: 'Direct fact' }] }))
      .rejects.toThrow('vector deletion unavailable');

    const candidateId = dependencies.upsertVectors.mock.calls[0][1][0].id;
    const cleanupUpdates = requestUpdates.filter(({ cleanupVectorIdsJson }) => cleanupVectorIdsJson !== undefined);
    expect(cleanupUpdates).toEqual([
      expect.objectContaining({ cleanupVectorIdsJson: JSON.stringify([candidateId]) }),
    ]);
  });

  it('retains cleanup state and throws transiently when a conflict has no winner', async () => {
    const { db, requestUpdates } = createMemoryWriteDb({
      memoryInsertResults: [undefined],
      memoryGetRows: [undefined],
    });
    dependencies.createDb.mockReturnValue(db);
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'digest:Direct fact', exactScopeKey: 'scope-key', embedding: [0.5, 0.6],
    });
    dependencies.findActiveExactMemory.mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.addMemory(env, { ...addRequest, infer: false, messages: [{ role: 'user', content: 'Direct fact' }] }))
      .rejects.toBeInstanceOf(actual.TransientMemoryJobError);

    const candidateId = dependencies.upsertVectors.mock.calls[0][1][0].id;
    expect(requestUpdates).toContainEqual(expect.objectContaining({
      cleanupVectorIdsJson: JSON.stringify([candidateId]),
    }));
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
  });

  it('cleans a claimed retry marker before exact duplicate lookup and completion', async () => {
    const candidatesJson = JSON.stringify([{ memory: 'Direct fact', entities: [], relationships: [] }]);
    const canonical = { ...memoryRow('retry-winner', 'Direct fact'), contentHash: 'digest:Direct fact' };
    const { db, requestSet } = createMemoryWriteDb({
      claimRows: [],
      ledgerRow: { status: 'failed', candidatesJson, cleanupVectorIdsJson: '["stale-vector"]' },
      retryRows: [{ leaseToken: 2, candidatesJson, cleanupVectorIdsJson: '["stale-vector"]' }],
    });
    dependencies.createDb.mockReturnValue(db);
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'digest:Direct fact', exactScopeKey: 'scope-key', duplicate: canonical,
    });
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.addMemory(env, { ...addRequest, infer: false, messages: [{ role: 'user', content: 'Direct fact' }] }))
      .resolves.toEqual([expect.objectContaining({ id: 'retry-winner' })]);

    expect(dependencies.deleteVector).toHaveBeenCalledWith(env.VECTORIZE, 'stale-vector');
    const clearCall = requestSet.mock.calls.findIndex(([values]) => values.cleanupVectorIdsJson === null);
    const completeCall = requestSet.mock.calls.findIndex(([values]) => values.status === 'completed');
    expect(requestSet.mock.invocationCallOrder[clearCall]).toBeLessThan(dependencies.prepareMemoryWrite.mock.invocationCallOrder[0]);
    expect(requestSet.mock.invocationCallOrder[clearCall]).toBeLessThan(requestSet.mock.invocationCallOrder[completeCall]);
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
  });

  it('repairs deterministic history and graph on retry without replacing its vector', async () => {
    const candidatesJson = JSON.stringify([{
      memory: 'Ada works at Acme.',
      entities: [{ name: 'Ada', type: 'person' }, { name: 'Acme', type: 'company' }],
      relationships: [{ source: 'Ada', target: 'Acme', relation_type: 'works_at' }],
    }]);
    const ownId = await sha256Hex('memory:user-123:request-123:0');
    const own = memoryRow(ownId, 'Ada works at Acme.');
    const { db, insertValues } = createMemoryWriteDb({
      claimRows: [],
      ledgerRow: { status: 'failed', candidatesJson, cleanupVectorIdsJson: null },
      retryRows: [{ leaseToken: 2, candidatesJson, cleanupVectorIdsJson: null }],
      memoryGetRows: [own],
    });
    dependencies.createDb.mockReturnValue(db);
    dependencies.embedText.mockResolvedValue([0.2, 0.3]);
    dependencies.upsertEntityVectors.mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    const result = await actual.addMemory(env, { ...addRequest, messages: [{ role: 'user', content: 'Ada works at Acme.' }] });

    expect(result).toEqual([expect.objectContaining({ id: ownId })]);
    expect(dependencies.prepareMemoryWrite).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
    expect(insertValues.some(({ table }) => table === memories)).toBe(false);
    expect(insertValues.some(({ table }) => table === entities)).toBe(true);
    expect(insertValues.some(({ table }) => table === memoryEntityLinks)).toBe(true);
    expect(insertValues.some(({ table }) => table === relationships)).toBe(true);
  });

  it('repairs its deterministic row when retry pre-read misses and preparation finds it', async () => {
    const candidatesJson = JSON.stringify([{
      memory: 'Ada works at Acme.',
      entities: [{ name: 'Ada', type: 'person' }, { name: 'Acme', type: 'company' }],
      relationships: [{ source: 'Ada', target: 'Acme', relation_type: 'works_at' }],
    }]);
    const ownId = await sha256Hex('memory:user-123:request-123:0');
    const own = memoryRow(ownId, 'Ada works at Acme.');
    const { db, insertValues } = createMemoryWriteDb({
      claimRows: [],
      ledgerRow: { status: 'failed', candidatesJson, cleanupVectorIdsJson: null },
      retryRows: [{ leaseToken: 2, candidatesJson, cleanupVectorIdsJson: null }],
      memoryGetRows: [undefined],
    });
    dependencies.createDb.mockReturnValue(db);
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: own.contentHash!, exactScopeKey: 'scope-key', duplicate: own,
    });
    dependencies.embedText.mockResolvedValue([0.2, 0.3]);
    dependencies.upsertEntityVectors.mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    const result = await actual.addMemory(env, { ...addRequest, messages: [{ role: 'user', content: own.content }] });

    expect(result).toEqual([expect.objectContaining({ id: ownId })]);
    expect(dependencies.prepareMemoryWrite).toHaveBeenCalledOnce();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
    expect(insertValues.some(({ table }) => table === memoryHistory)).toBe(true);
    expect(insertValues.some(({ table }) => table === entities)).toBe(true);
    expect(insertValues.some(({ table }) => table === memoryEntityLinks)).toBe(true);
    expect(insertValues.some(({ table }) => table === relationships)).toBe(true);
  });

  it('cleans a previously published candidate vector when retry preparation finds another canonical row', async () => {
    const candidatesJson = JSON.stringify([{ memory: 'Direct fact', entities: [], relationships: [] }]);
    const candidateId = await sha256Hex('memory:user-123:request-123:0');
    const canonical = memoryRow('canonical-winner', 'Direct fact');
    const { db, requestSet, requestUpdates } = createMemoryWriteDb({
      claimRows: [],
      ledgerRow: { status: 'failed', candidatesJson, cleanupVectorIdsJson: null },
      retryRows: [{ leaseToken: 2, candidatesJson, cleanupVectorIdsJson: null }],
      memoryGetRows: [undefined],
    });
    dependencies.createDb.mockReturnValue(db);
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: canonical.contentHash!, exactScopeKey: 'scope-key', duplicate: canonical,
    });
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.addMemory(env, {
      ...addRequest, infer: false, messages: [{ role: 'user', content: canonical.content }],
    })).resolves.toEqual([expect.objectContaining({ id: canonical.id })]);

    expect(requestUpdates).toContainEqual(expect.objectContaining({
      cleanupVectorIdsJson: JSON.stringify([candidateId]),
    }));
    expect(dependencies.deleteVector).toHaveBeenCalledWith(env.VECTORIZE, candidateId);
    expect(dependencies.deleteVector).not.toHaveBeenCalledWith(env.VECTORIZE, canonical.id);
    expect(requestUpdates).toContainEqual(expect.objectContaining({ cleanupVectorIdsJson: null }));
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    const markerCall = requestSet.mock.calls.findIndex(([values]) => (
      values.cleanupVectorIdsJson === JSON.stringify([candidateId])
    ));
    const clearCall = requestSet.mock.calls.findIndex(([values]) => values.cleanupVectorIdsJson === null);
    const completeCall = requestSet.mock.calls.findIndex(([values]) => values.status === 'completed');
    expect(requestSet.mock.invocationCallOrder[markerCall]).toBeLessThan(
      dependencies.deleteVector.mock.invocationCallOrder[0],
    );
    expect(dependencies.deleteVector.mock.invocationCallOrder[0]).toBeLessThan(
      requestSet.mock.invocationCallOrder[clearCall],
    );
    expect(requestSet.mock.invocationCallOrder[clearCall]).toBeLessThan(
      requestSet.mock.invocationCallOrder[completeCall],
    );
  });

  it('does not delete the candidate after a D1-conflict crash when cleanup marker lease is replaced', async () => {
    const candidatesJson = JSON.stringify([{ memory: 'Direct fact', entities: [], relationships: [] }]);
    const candidateId = await sha256Hex('memory:user-123:request-123:0');
    const canonical = memoryRow('canonical-winner', 'Direct fact');
    const { db, requestUpdates } = createMemoryWriteDb({
      claimRows: [],
      ledgerRow: { status: 'failed', candidatesJson, cleanupVectorIdsJson: null },
      retryRows: [{ leaseToken: 2, candidatesJson, cleanupVectorIdsJson: null }],
      memoryGetRows: [undefined],
      cleanupUpdateRows: [[]],
    });
    dependencies.createDb.mockReturnValue(db);
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: canonical.contentHash!, exactScopeKey: 'scope-key', duplicate: canonical,
    });
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.addMemory(env, {
      ...addRequest, infer: false, messages: [{ role: 'user', content: canonical.content }],
    })).rejects.toBeInstanceOf(actual.TransientMemoryJobError);

    expect(requestUpdates).toContainEqual(expect.objectContaining({
      cleanupVectorIdsJson: JSON.stringify([candidateId]),
    }));
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
    expect(requestUpdates.filter(({ cleanupVectorIdsJson }) => cleanupVectorIdsJson === null)).toEqual([]);
  });
});

function memoryRow(id: string, content: string): typeof memories.$inferSelect {
  return {
    id,
    userId: 'user-123',
    agentId: null,
    runId: null,
    actorId: null,
    content,
    metadataJson: '{}',
    hash: 'request-123',
    contentHash: `digest:${content}`,
    createdAt: 1_784_028_800,
    updatedAt: 1_784_028_800,
    deletedAt: null,
    mutationVersion: 0,
    lastMutationId: null,
  };
}

function createUpdateDb(
  current: typeof memories.$inferSelect,
  options: { updateErrors?: Error[] } = {},
) {
  let stored = current;
  const updateErrors = [...(options.updateErrors ?? [])];
  const updateValues: Array<Record<string, unknown>> = [];
  const historyValues: Array<Record<string, unknown>> = [];
  const deleteRun = vi.fn().mockResolvedValue({});
  let pendingUpdate: Record<string, unknown> | undefined;
  const updateRun = vi.fn(async () => {
    const error = updateErrors.shift();
    if (error !== undefined) throw error;
    stored = { ...stored, ...pendingUpdate };
    return {};
  });
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn().mockReturnValue({ get: vi.fn().mockImplementation(async () => stored) }) })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateValues.push(values);
        pendingUpdate = values;
        return { where: vi.fn().mockReturnValue({ run: updateRun }) };
      }),
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockReturnValue({ run: deleteRun }) })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        historyValues.push(values);
        return { onConflictDoNothing: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({}) }) };
      }),
    })),
  };
  return { db, updateRun, updateValues, historyValues };
}

describe('updateMemory deduplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.findActiveExactMemory.mockResolvedValue(undefined);
    dependencies.embedText.mockResolvedValue([0.8, 0.9]);
    dependencies.extractMemoryGraph.mockResolvedValue({ entities: [], relationships: [] });
    dependencies.upsertVectors.mockResolvedValue(undefined);
  });

  it('rejects changed content that matches an active memory before vector mutation', async () => {
    const current = { ...memoryRow('memory-to-update', 'Old content'), agentId: 'agent-123' };
    const winner = { ...memoryRow('existing-winner', 'New content'), agentId: 'agent-123' };
    const { db, updateValues, historyValues } = createUpdateDb(current);
    dependencies.createDb.mockReturnValue(db);
    dependencies.findActiveExactMemory.mockResolvedValue(winner);
    const actual = await vi.importActual<typeof import('../src/memory/service')>('../src/memory/service');

    await expect(actual.updateMemory(env, current.id, 'user-123', { memory: 'New content' }))
      .rejects.toBeInstanceOf(actual.MemoryContentConflictError);

    expect(dependencies.findActiveExactMemory).toHaveBeenCalledWith(
      env,
      { userId: 'user-123', agentId: 'agent-123' },
      'New content',
      expect.any(String),
      current.id,
    );
    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    expect(updateValues).toEqual([]);
    expect(historyValues).toEqual([]);
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

  it('returns 409 when changed content conflicts with an active memory', async () => {
    service.updateMemory.mockRejectedValue(new service.MemoryContentConflictError('duplicate'));

    const response = await worker.fetch(request('/v1/memories/memory-123?user_id=user-123', {
      method: 'PATCH',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ memory: 'Existing content' }),
    }), env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'An active memory with this content already exists' });
  });

  it('returns a distinct 409 when optimistic update versioning loses a race', async () => {
    service.updateMemory.mockRejectedValue(new service.MemoryMutationConflictError('raced'));
    const response = await worker.fetch(request('/v1/memories/memory-123?user_id=user-123', {
      method: 'PATCH', headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ memory: 'New content' }),
    }), env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Memory changed during update; retry with the latest version',
    });
  });

  it('returns durable mutation identity and Retry-After for recoverable update failures', async () => {
    service.updateMemory.mockRejectedValue(new service.DurableMemoryMutationError('mutation-1', 'queued'));
    const response = await worker.fetch(request('/v1/memories/memory-123?user_id=user-123', {
      method: 'PATCH', headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ memory: 'New content' }),
    }), env);

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    await expect(response.json()).resolves.toEqual({ error: 'queued', mutation_id: 'mutation-1' });
  });

  it('does not translate unrelated update errors into content conflicts', async () => {
    service.updateMemory.mockRejectedValue(new Error('database unavailable'));

    const response = await worker.fetch(request('/v1/memories/memory-123?user_id=user-123', {
      method: 'PATCH',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ memory: 'New content' }),
    }), env);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' });
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

  it.each(['/memories/memory-123', '/v1/memories/memory-123'])(
    'resolves a soft-deleted owner so DELETE %s can retry vector cleanup', async (path) => {
    service.getMemoryById.mockResolvedValue(null);
    service.getMemoryOwnerById.mockResolvedValue('user-123');
    service.deleteMemory.mockResolvedValue(true);

    const deleted = await worker.fetch(request(path, {
      method: 'DELETE', headers: { 'X-API-Key': 'test-api-key' },
    }), env);

    expect(deleted.status).toBe(200);
    expect(service.deleteMemory).toHaveBeenCalledWith(env, 'memory-123', 'user-123');
    },
  );

  it('returns durable mutation identity for a recoverable Hermes update failure', async () => {
    service.getMemoryById.mockResolvedValue(memory);
    service.updateMemory.mockRejectedValue(new service.DurableMemoryMutationError('mutation-2', 'queued'));
    const response = await worker.fetch(request('/memories/memory-123', {
      method: 'PUT', headers: { 'X-API-Key': 'test-api-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'New content' }),
    }), env);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'queued', mutation_id: 'mutation-2' });
  });

  it.each(['/memories/memory-123', '/v1/memories/memory-123'])(
    'returns the memory content conflict response for Hermes PUT %s',
    async (path) => {
      service.getMemoryById.mockResolvedValue(memory);
      service.updateMemory.mockRejectedValue(new service.MemoryContentConflictError('duplicate'));

      const response = await worker.fetch(request(path, {
        method: 'PUT',
        headers: { 'X-API-Key': 'test-api-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Existing content' }),
      }), env);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: 'An active memory with this content already exists',
      });
    },
  );

  it.each(['/memories/memory-123', '/v1/memories/memory-123'])(
    'propagates unrelated Hermes PUT errors for %s',
    async (path) => {
      service.getMemoryById.mockResolvedValue(memory);
      service.updateMemory.mockRejectedValue(new Error('database unavailable'));

      const response = await worker.fetch(request(path, {
        method: 'PUT',
        headers: { 'X-API-Key': 'test-api-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'New content' }),
      }), env);

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'Internal server error' });
    },
  );

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
