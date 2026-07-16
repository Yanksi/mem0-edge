import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';

const dependencies = vi.hoisted(() => ({
  embedText: vi.fn(),
  prepareMemoryWrite: vi.fn(),
  findActiveExactMemory: vi.fn(),
  upsertVectors: vi.fn(),
  deleteVector: vi.fn(),
}));

vi.mock('../src/llm', () => ({ embedText: dependencies.embedText }));
vi.mock('../src/memory/deduplication', () => ({
  prepareMemoryWrite: dependencies.prepareMemoryWrite,
  findActiveExactMemory: dependencies.findActiveExactMemory,
}));
vi.mock('../src/vectorize', () => ({
  upsertVectors: dependencies.upsertVectors,
  deleteVector: dependencies.deleteVector,
}));

import { handleMemoryQueue } from '../src/queue';
import worker from '../src/index';
import {
  dispatchPendingMem0Imports,
  enqueueMem0Import,
  processMem0AgentReclassificationJob,
  processMem0ImportJob,
  RawMemoryMigrationExport,
} from '../src/import/service';
import { contentHash, scopeKey, vectorStateHash } from '../src/memory/identity';

const env = {
  MEMORY_JOBS: { send: vi.fn(), sendBatch: vi.fn() },
  VECTORIZE: {} as VectorizeIndex,
} as unknown as Env;

const exportedMemory = {
  memory: '  User prefers espresso.  ',
  created_at: '2024-01-02T03:04:05.000Z',
  updated_at: null,
};

type ImportRequestFixture = {
  request_id: string;
  entity_type: 'user' | 'agent';
  entity_id: string;
  item_json: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  lease_token: number;
  attempt_count?: number;
  cleanup_vector_id?: string | null;
  cleanup_vector_generation?: number;
};

const duplicateMemory = (id = 'canonical-memory-id') => ({
  id,
  userId: 'canonical-user',
  agentId: null,
  runId: null,
  actorId: null,
  content: exportedMemory.memory,
  metadataJson: '{}',
  hash: 'canonical-hash',
  contentHash: 'content-hash',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
});

function durableImportDb(canonical: ImportRequestFixture = {
  request_id: 'stable-memory-id',
  entity_type: 'user',
  entity_id: 'canonical-user',
  item_json: JSON.stringify(exportedMemory),
  status: 'processing',
  lease_token: 7,
}, options: {
  claim?: ImportRequestFixture | null;
  completionChanges?: number;
  existingRows?: Array<ImportRequestFixture | null>;
  dispatchRows?: Array<{ request_id: string; publish_token: number }>;
  memoryInsertChanges?: number;
  cleanupMarkerChanges?: number;
} = {}) {
  const canonicalRow = {
    attempt_count: 1,
    cleanup_vector_id: null,
    cleanup_vector_generation: 0,
    ...canonical,
  };
  let cleanupVectorId = canonicalRow.cleanup_vector_id;
  let cleanupVectorGeneration = canonicalRow.cleanup_vector_generation;
  const events: string[] = [];
  const statements: Array<{ sql: string; bindings: unknown[] }> = [];
  let existingRead = 0;
  const prepare = vi.fn((sql: string) => {
    const call = { sql, bindings: [] as unknown[] };
    statements.push(call);
    const statement = {
      bind: vi.fn((...bindings: unknown[]) => {
        call.bindings = bindings;
        return statement;
      }),
      first: vi.fn(async () => {
        if (/SET status = 'processing'/i.test(sql) && /RETURNING/i.test(sql)) {
          const claimed = options.claim === undefined ? canonicalRow : options.claim;
          return claimed === null ? null : {
            ...claimed,
            cleanup_vector_generation: cleanupVectorGeneration,
            cleanup_vector_id: cleanupVectorId,
          };
        }
        if (/SET cleanup_vector_id = \?/i.test(sql) && /RETURNING cleanup_vector_generation/i.test(sql)) {
          if ((options.cleanupMarkerChanges ?? 1) === 0 || cleanupVectorId !== null) return null;
          cleanupVectorId = call.bindings[0] as string;
          cleanupVectorGeneration += 1;
          return { cleanup_vector_generation: cleanupVectorGeneration };
        }
        if (/SET cleanup_vector_id = \?/i.test(sql) && /RETURNING request_id/i.test(sql)) {
          cleanupVectorId = call.bindings[0] as string;
          cleanupVectorGeneration += 1;
          return { ...canonicalRow, cleanup_vector_id: cleanupVectorId, cleanup_vector_generation: cleanupVectorGeneration };
        }
        if (/SELECT/i.test(sql) && /FROM mem0_import_requests/i.test(sql)) {
          if (/cleanup_vector_id IS NOT NULL/i.test(sql)) {
            return cleanupVectorId === null ? null : {
              cleanup_vector_id: cleanupVectorId,
              cleanup_vector_generation: cleanupVectorGeneration,
            };
          }
          if (/SELECT request_id/i.test(sql) && /cleanup_vector_generation = \?/i.test(sql)) {
            return cleanupVectorId === call.bindings[2]
              && cleanupVectorGeneration === call.bindings[3]
              ? { request_id: canonicalRow.request_id }
              : null;
          }
          if (options.existingRows !== undefined && existingRead < options.existingRows.length) {
            return options.existingRows[existingRead++];
          }
          return { ...canonicalRow, cleanup_vector_id: cleanupVectorId, cleanup_vector_generation: cleanupVectorGeneration };
        }
        return null;
      }),
      all: vi.fn(async () => ({
        success: true,
        results: /publish_token = publish_token \+ 1/i.test(sql) ? (options.dispatchRows ?? []) : [],
        meta: { changes: options.dispatchRows?.length ?? 0 },
      })),
      run: vi.fn(async () => {
        let changes = /INSERT INTO memories/i.test(sql) ? (options.memoryInsertChanges ?? 1) : 1;
        if (/SET cleanup_vector_id = NULL/i.test(sql)) {
          changes = options.cleanupMarkerChanges ?? 1;
          if (changes === 1) cleanupVectorId = null;
        }
        return { success: true, results: [], meta: { changes } };
      }),
    };
    return statement;
  });
  const batch = vi.fn(async (items: unknown[]) => {
    events.push('d1-batch');
    return items.map((_item, index) => ({
      success: true,
      results: [],
      meta: { changes: index === items.length - 1 ? (options.completionChanges ?? 1) : 1 },
    }));
  });
  return { prepare, batch, statements, events };
}

function reclassificationDb(updatedRow?: {
  userId: string | null;
  agentId: string | null;
  runId: string | null;
  actorId: string | null;
  metadataJson: string;
}) {
  let source = {
    id: 'source-memory',
    userId: 'legacy-agent-user' as string | null,
    agentId: null as string | null,
    runId: 'run-1' as string | null,
    actorId: 'actor-1' as string | null,
    content: '  Exact raw memory.  ',
    metadataJson: JSON.stringify({ source: 'mem0', ignoredNull: null, agent_id: 'spoofed' }),
    hash: 'source-hash',
    contentHash: null as string | null,
    createdAt: 2,
    deletedAt: null as number | null,
  };
  const statements: Array<{ sql: string; bindings: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => {
    const call = { sql, bindings: [] as unknown[] };
    statements.push(call);
    const statement = {
      bind: vi.fn((...bindings: unknown[]) => {
        call.bindings = bindings;
        return statement;
      }),
      first: vi.fn(async () => {
        if (/SELECT id, user_id AS userId/i.test(sql) && /FROM memories/i.test(sql)) return source;
        if (/SET content_hash = \?/i.test(sql) && /RETURNING/i.test(sql)) {
          source = { ...source, contentHash: call.bindings[0] as string };
          return source;
        }
        if (/SET user_id = NULL, agent_id = \?/i.test(sql) && /RETURNING/i.test(sql)) {
          source = {
            ...source,
            userId: null,
            agentId: call.bindings[0] as string,
            contentHash: source.contentHash ?? call.bindings[1] as string,
            ...(updatedRow ?? {}),
          };
          return source;
        }
        return null;
      }),
      all: vi.fn(async () => ({ success: true, results: [], meta: { changes: 0 } })),
      run: vi.fn(async () => ({ success: true, results: [], meta: { changes: 1 } })),
    };
    return statement;
  });
  const batch = vi.fn(async (items: unknown[]) => {
    if (items.length === 3) source = { ...source, deletedAt: 1 };
    return items.map(() => ({
      success: true,
      results: [],
      meta: { changes: 1 },
    }));
  });
  return { prepare, batch, statements };
}

describe('Mem0 migration imports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'content-hash',
      exactScopeKey: 'scope-key',
    });
    dependencies.findActiveExactMemory.mockResolvedValue(undefined);
    dependencies.deleteVector.mockResolvedValue(undefined);
  });

  it('validates non-empty text and valid optional source timestamps', () => {
    expect(RawMemoryMigrationExport.safeParse({ memories: [exportedMemory] }).success).toBe(true);
    expect(RawMemoryMigrationExport.safeParse({ memories: [{ memory: 'Only memory is required.' }] }).success).toBe(true);
    expect(RawMemoryMigrationExport.safeParse({ memories: [{ ...exportedMemory, memory: '   ' }] }).success).toBe(false);
    expect(RawMemoryMigrationExport.safeParse({ memories: [{ ...exportedMemory, created_at: 'not-a-date' }] }).success).toBe(false);
    expect(RawMemoryMigrationExport.safeParse({ memories: [{ ...exportedMemory, updated_at: 42 }] }).success).toBe(false);
  });

  it('enqueues one stable durable job per exported item', async () => {
    const db = durableImportDb(undefined, {
      dispatchRows: [
        { request_id: 'dispatch-1', publish_token: 1 },
        { request_id: 'dispatch-2', publish_token: 1 },
      ],
    });
    const sendBatch = vi.fn().mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
    const exportPayload = { memories: [exportedMemory, { ...exportedMemory, memory: 'User works in Zurich.' }] };

    await expect(enqueueMem0Import({ ...env, DB: db, MEMORY_JOBS: { sendBatch } } as unknown as Env, { entityType: 'user', entityId: 'user-123' }, exportPayload))
      .resolves.toBe(2);
    const firstPass = sendBatch.mock.calls[0][0];

    sendBatch.mockClear();
    await enqueueMem0Import({ ...env, DB: db, MEMORY_JOBS: { sendBatch } } as unknown as Env, { entityType: 'user', entityId: 'user-123' }, exportPayload);

    expect(sendBatch).toHaveBeenCalledOnce();
    expect(firstPass).toEqual(sendBatch.mock.calls[0][0]);
    expect(firstPass).toEqual(expect.arrayContaining([
      { body: expect.objectContaining({ type: 'import-mem0-memory', requestId: expect.any(String) }) },
    ]));
  });

  it('persists and counts exact duplicate export memories once', async () => {
    const db = durableImportDb();
    const sendBatch = vi.fn();
    const duplicate = {
      ...exportedMemory,
      created_at: '2025-01-02T03:04:05.000Z',
      updated_at: '2025-02-03T04:05:06.000Z',
    };

    await expect(enqueueMem0Import(
      { ...env, DB: db, MEMORY_JOBS: { sendBatch } } as unknown as Env,
      { entityType: 'user', entityId: 'user-123' },
      { memories: [exportedMemory, duplicate] },
    )).resolves.toBe(1);

    const inserts = db.statements.filter(({ sql }) => /INSERT INTO mem0_import_requests/i.test(sql));
    expect(inserts).toHaveLength(1);
    expect(JSON.parse(inserts[0].bindings[3] as string)).toEqual(exportedMemory);
  });

  it('selects the earliest valid created_at before null or invalid duplicate dates', async () => {
    const db = durableImportDb();
    const selected = {
      memory: exportedMemory.memory,
      created_at: '2024-01-02T03:04:05.000Z',
      updated_at: '2024-03-04T05:06:07.000Z',
    };
    const exportPayload = {
      memories: [
        { ...exportedMemory, created_at: null, updated_at: '2025-01-01T00:00:00.000Z' },
        { ...exportedMemory, created_at: 'not-a-date', updated_at: '2026-01-01T00:00:00.000Z' },
        { ...exportedMemory, created_at: '2024-02-03T04:05:06.000Z' },
        selected,
      ],
    } as unknown as Parameters<typeof enqueueMem0Import>[2];

    await enqueueMem0Import(
      { ...env, DB: db, MEMORY_JOBS: { sendBatch: vi.fn() } } as unknown as Env,
      { entityType: 'user', entityId: 'user-123' },
      exportPayload,
    );

    const insert = db.statements.find(({ sql }) => /INSERT INTO mem0_import_requests/i.test(sql));
    expect(JSON.parse(insert?.bindings[3] as string)).toEqual(selected);
  });

  it('uses original input order to break duplicate created_at ties', async () => {
    const db = durableImportDb();
    const first = {
      memory: exportedMemory.memory,
      created_at: exportedMemory.created_at,
      updated_at: '2024-02-03T04:05:06.000Z',
    };
    const second = {
      ...first,
      updated_at: '2025-02-03T04:05:06.000Z',
    };

    await enqueueMem0Import(
      { ...env, DB: db, MEMORY_JOBS: { sendBatch: vi.fn() } } as unknown as Env,
      { entityType: 'user', entityId: 'user-123' },
      { memories: [first, second] },
    );

    const inserts = db.statements.filter(({ sql }) => /INSERT INTO mem0_import_requests/i.test(sql));
    expect(inserts).toHaveLength(1);
    const [insert] = inserts;
    expect(JSON.parse(insert?.bindings[3] as string)).toEqual(first);
  });

  it('keeps identical user-only and agent-only imports in separate durable identities', async () => {
    const userDb = durableImportDb();
    const agentDb = durableImportDb();
    const memoryJobs = { sendBatch: vi.fn() };

    await enqueueMem0Import(
      { ...env, DB: userDb, MEMORY_JOBS: memoryJobs } as unknown as Env,
      { entityType: 'user', entityId: 'shared-id' },
      { memories: [exportedMemory] },
    );
    await enqueueMem0Import(
      { ...env, DB: agentDb, MEMORY_JOBS: memoryJobs } as unknown as Env,
      { entityType: 'agent', entityId: 'shared-id' },
      { memories: [exportedMemory] },
    );

    const userInsert = userDb.statements.find(({ sql }) => /INSERT INTO mem0_import_requests/i.test(sql));
    const agentInsert = agentDb.statements.find(({ sql }) => /INSERT INTO mem0_import_requests/i.test(sql));
    expect(userInsert?.bindings.slice(1, 3)).toEqual(['user', 'shared-id']);
    expect(agentInsert?.bindings.slice(1, 3)).toEqual(['agent', 'shared-id']);
    expect(userInsert?.bindings[0]).not.toBe(agentInsert?.bindings[0]);
  });

  it('enqueues agent imports with an agent-only owner', async () => {
    const db = durableImportDb(undefined, {
      dispatchRows: [{ request_id: 'agent-dispatch', publish_token: 1 }],
    });
    const sendBatch = vi.fn().mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });

    await enqueueMem0Import(
      { ...env, DB: db, MEMORY_JOBS: { sendBatch } } as unknown as Env,
      { entityType: 'agent', entityId: 'hermes' },
      { memories: [exportedMemory] },
    );

    expect(db.statements.find(({ sql }) => /INSERT INTO mem0_import_requests/i.test(sql))?.bindings)
      .toEqual(expect.arrayContaining(['agent', 'hermes']));
    expect(sendBatch).toHaveBeenCalledOnce();
  });

  it('persists every canonical import item before publishing compact queue triggers', async () => {
    const db = durableImportDb(undefined, {
      dispatchRows: [
        { request_id: 'dispatch-1', publish_token: 1 },
        { request_id: 'dispatch-2', publish_token: 1 },
      ],
    });
    const events = db.events;
    db.batch.mockImplementationOnce(async (items: unknown[]) => {
      events.push('ledger');
      return items.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
    });
    const sendBatch = vi.fn(async () => {
      events.push('queue');
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    });
    const exportPayload = { memories: [exportedMemory, { ...exportedMemory, memory: 'User works in Zurich.' }] };

    await enqueueMem0Import({ ...env, DB: db, MEMORY_JOBS: { sendBatch } } as unknown as Env, { entityType: 'user', entityId: 'user-123' }, exportPayload);

    expect(events.slice(0, 2)).toEqual(['ledger', 'queue']);
    expect(db.statements.filter(({ sql }) => /INSERT INTO mem0_import_requests/i.test(sql))).toHaveLength(2);
    expect(sendBatch).toHaveBeenCalledWith(expect.arrayContaining([
      { body: { type: 'import-mem0-memory', requestId: expect.any(String) } },
    ]));
  });

  it('dispatches only rows claimed by a stale publication lease and marks them published by token', async () => {
    const db = durableImportDb(undefined, {
      dispatchRows: [
        { request_id: 'dispatch-1', publish_token: 3 },
        { request_id: 'dispatch-2', publish_token: 5 },
      ],
    });
    const sendBatch = vi.fn().mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });

    await expect(dispatchPendingMem0Imports(
      { ...env, DB: db, MEMORY_JOBS: { sendBatch } } as unknown as Env,
      1_700_000_000,
    )).resolves.toBe(2);

    expect(sendBatch).toHaveBeenCalledWith([
      { body: { type: 'import-mem0-memory', requestId: 'dispatch-1' } },
      { body: { type: 'import-mem0-memory', requestId: 'dispatch-2' } },
    ]);
    const sql = db.statements.map((statement) => statement.sql).join('\n');
    expect(sql).toMatch(/published_at IS NULL/i);
    expect(sql).toMatch(/publish_attempted_at IS NULL OR publish_attempted_at < \?/i);
    expect(sql).toMatch(/SET published_at = \?/i);
    expect(db.statements.find((statement) => /SET published_at = \?/i.test(statement.sql))?.bindings)
      .toEqual([1_700_000_000, 'dispatch-1', 3]);
  });

  it('does not publish when no unpublished dispatch lease can be claimed', async () => {
    const db = durableImportDb(undefined, { dispatchRows: [] });
    const sendBatch = vi.fn();

    await expect(dispatchPendingMem0Imports(
      { ...env, DB: db, MEMORY_JOBS: { sendBatch } } as unknown as Env,
      1_700_000_000,
    )).resolves.toBe(0);

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it('leaves a claimed dispatch unpublished when Queue publication fails', async () => {
    const db = durableImportDb(undefined, {
      dispatchRows: [{ request_id: 'dispatch-1', publish_token: 3 }],
    });
    const sendBatch = vi.fn().mockRejectedValue(new Error('Queue unavailable'));

    await expect(dispatchPendingMem0Imports(
      { ...env, DB: db, MEMORY_JOBS: { sendBatch } } as unknown as Env,
      1_700_000_000,
    )).rejects.toThrow('Queue unavailable');

    expect(db.statements.map(({ sql }) => sql).join('\n')).not.toMatch(/SET published_at = \?/i);
  });

  it('runs pending import dispatch from the scheduled Worker handler', async () => {
    const db = durableImportDb(undefined, {
      dispatchRows: [{ request_id: 'scheduled-dispatch', publish_token: 1 }],
    });
    const sendBatch = vi.fn().mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
    const promises: Promise<unknown>[] = [];
    const context = { waitUntil: vi.fn((promise: Promise<unknown>) => promises.push(promise)) };

    await worker.scheduled?.(
      {} as ScheduledController,
      { ...env, DB: db, MEMORY_JOBS: { sendBatch } } as unknown as Env,
      context as unknown as ExecutionContext,
    );
    await Promise.all(promises);

    expect(context.waitUntil).toHaveBeenCalledOnce();
    expect(sendBatch).toHaveBeenCalledWith([
      { body: { type: 'import-mem0-memory', requestId: 'scheduled-dispatch' } },
    ]);
  });

  it('processes the canonical ledger owner and item instead of a conflicting queue payload', async () => {
    const canonicalItem = { memory: 'Canonical memory from the ledger.', created_at: null, updated_at: null };
    const db = durableImportDb({
      request_id: 'stable-memory-id',
      entity_type: 'agent',
      entity_id: 'canonical-agent',
      item_json: JSON.stringify(canonicalItem),
      status: 'processing',
      lease_token: 7,
    });
    dependencies.embedText.mockImplementation(async (_env, text: string) => {
      db.events.push(`embed:${text}`);
      return [0.1, 0.2];
    });
    dependencies.upsertVectors.mockImplementation(async () => {
      db.events.push('vector');
      return { mutationId: 'mutation-1' };
    });

    await processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory', requestId: 'stable-memory-id',
    });

    expect(dependencies.embedText).toHaveBeenCalledWith(expect.anything(), canonicalItem.memory);
    expect(dependencies.upsertVectors).toHaveBeenCalledWith(env.VECTORIZE, [expect.objectContaining({
      id: 'stable-memory-id',
      metadata: expect.objectContaining({ agent_id: 'canonical-agent' }),
    })]);
    expect(db.events).toEqual([
      `embed:${canonicalItem.memory}`,
      'vector',
      'd1-batch',
    ]);
    expect(db.batch).toHaveBeenCalledOnce();
    expect(db.statements.map(({ sql }) => sql).join('\n')).toMatch(/INSERT INTO memories/i);
    expect(db.statements.map(({ sql }) => sql).join('\n')).toMatch(/INSERT INTO memory_history/i);
    expect(db.statements.map(({ sql }) => sql).join('\n')).toMatch(/status = 'completed'/i);
  });

  it('records a failed lease without publishing D1 memory rows when Vectorize rejects the mutation', async () => {
    const db = durableImportDb();
    dependencies.embedText.mockResolvedValue([0.1, 0.2]);
    dependencies.upsertVectors.mockRejectedValue(new Error('VECTOR_UPSERT_ERROR (code = 40041): Too Many Requests'));

    await expect(processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory',
      requestId: 'stable-memory-id',
    })).rejects.toThrow('40041');

    expect(db.batch).not.toHaveBeenCalled();
    expect(db.statements.map(({ sql }) => sql).join('\n')).toMatch(/status = 'failed'/i);
    expect(db.statements.map(({ sql }) => sql).join('\n')).not.toMatch(/INSERT INTO memories/i);
  });

  it('returns noop without embedding an already completed import', async () => {
    const completed = {
      request_id: 'stable-memory-id', entity_type: 'user' as const, entity_id: 'user-123',
      item_json: JSON.stringify(exportedMemory), status: 'completed' as const, lease_token: 8,
    };
    const db = durableImportDb(completed, { claim: null });

    await expect(processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory', requestId: 'stable-memory-id',
    })).resolves.toBe('noop');

    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('returns inflight when stale cleanup is re-armed after a completed-row claim miss', async () => {
    const completed = {
      request_id: 'stable-memory-id', entity_type: 'user' as const, entity_id: 'user-123',
      item_json: JSON.stringify(exportedMemory), status: 'completed' as const, lease_token: 8,
      cleanup_vector_id: 'stable-memory-id', cleanup_vector_generation: 2,
    };
    const db = durableImportDb(completed, { claim: null });

    await expect(processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory', requestId: 'stable-memory-id',
    })).resolves.toBe('inflight');

    expect(dependencies.deleteVector).not.toHaveBeenCalled();
  });

  it('returns inflight while another import lease is active', async () => {
    const processing = {
      request_id: 'stable-memory-id', entity_type: 'user' as const, entity_id: 'user-123',
      item_json: JSON.stringify(exportedMemory), status: 'processing' as const, lease_token: 8,
    };
    const db = durableImportDb(processing, { claim: null });

    await expect(processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory', requestId: 'stable-memory-id',
    })).resolves.toBe('inflight');

    expect(dependencies.embedText).not.toHaveBeenCalled();
  });

  it('does not report completion after its processing lease is replaced', async () => {
    const db = durableImportDb(undefined, { completionChanges: 0 });
    dependencies.embedText.mockResolvedValue([0.1]);
    dependencies.upsertVectors.mockResolvedValue({ mutationId: 'mutation-1' });

    await expect(processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory', requestId: 'stable-memory-id',
    })).resolves.toBe('inflight');

    const publicationSql = db.statements.map(({ sql }) => sql).join('\n');
    expect(publicationSql.match(/status = 'processing' AND lease_token = \?/gi)).toHaveLength(6);
  });

  it('rejects a legacy queue body that conflicts with its canonical ledger row', async () => {
    const db = durableImportDb();

    await expect(processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory', requestId: 'stable-memory-id',
      entityType: 'agent', entityId: 'wrong-agent', item: exportedMemory,
    })).rejects.toThrow('conflicts with its durable request');

    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('rechecks the canonical ledger after losing a concurrent legacy insert race', async () => {
    const canonical = {
      request_id: 'stable-memory-id', entity_type: 'user' as const, entity_id: 'canonical-user',
      item_json: JSON.stringify(exportedMemory), status: 'queued' as const, lease_token: 0,
    };
    const db = durableImportDb(canonical, { existingRows: [null, canonical] });

    await expect(processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory', requestId: 'stable-memory-id',
      entityType: 'agent', entityId: 'conflicting-agent', item: exportedMemory,
    })).rejects.toThrow('conflicts with its durable request');

    expect(db.statements.filter(({ sql }) => /SELECT/i.test(sql) && /FROM mem0_import_requests/i.test(sql))).toHaveLength(2);
    expect(dependencies.embedText).not.toHaveBeenCalled();
  });

  it('marks a corrupt persisted import item failed instead of retrying it forever', async () => {
    const db = durableImportDb({
      request_id: 'stable-memory-id', entity_type: 'user', entity_id: 'user-123',
      item_json: '{not-json', status: 'processing', lease_token: 7,
    });

    await expect(processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory', requestId: 'stable-memory-id',
    })).rejects.toThrow('Invalid persisted Mem0 import item');

    expect(db.statements.map(({ sql }) => sql).join('\n')).toMatch(/status = 'failed'/i);
    expect(dependencies.embedText).not.toHaveBeenCalled();
  });

  it.each([
    ['exact', undefined],
    ['semantic', [0.8, 0.2]],
  ])('completes an %s storage duplicate without a new embedding, vector, or history row', async (_kind, embedding) => {
    const db = durableImportDb();
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'content-hash',
      exactScopeKey: 'scope-key',
      duplicate: duplicateMemory(),
      ...(embedding === undefined ? {} : { embedding }),
    });

    await expect(processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory', requestId: 'stable-memory-id',
    })).resolves.toBe('processed');

    expect(dependencies.prepareMemoryWrite).toHaveBeenCalledWith(
      expect.objectContaining({ DB: db }),
      { userId: 'canonical-user', agentId: null },
      exportedMemory.memory,
    );
    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
    expect(db.statements.map(({ sql }) => sql).join('\n')).not.toMatch(/INSERT INTO (memories|memory_history)/i);
    expect(db.statements.map(({ sql }) => sql).join('\n')).toMatch(/status = 'completed'/i);
  });

  it('cleans a possible orphan request vector on retry before completing against another canonical row', async () => {
    const db = durableImportDb({
      request_id: 'stable-memory-id', entity_type: 'user', entity_id: 'canonical-user',
      item_json: JSON.stringify(exportedMemory), status: 'processing', lease_token: 7,
      attempt_count: 2,
    });
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'content-hash', exactScopeKey: 'scope-key', duplicate: duplicateMemory(),
    });

    await expect(processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory', requestId: 'stable-memory-id',
    })).resolves.toBe('processed');

    expect(dependencies.deleteVector).toHaveBeenCalledWith(env.VECTORIZE, 'stable-memory-id');
    const markerArm = db.statements.find(({ sql }) => /SET cleanup_vector_id = \?/i.test(sql));
    const markerClear = db.statements.find(({ sql }) => /SET cleanup_vector_id = NULL/i.test(sql));
    expect(markerArm?.bindings[0]).toBe('stable-memory-id');
    const completionIndex = db.statements.findIndex(({ sql }) => /SET status = 'completed'/i.test(sql));
    expect(db.statements.indexOf(markerClear!)).toBeLessThan(completionIndex);
  });

  it('consumes a persisted cleanup marker before exact preparation and completion', async () => {
    const db = durableImportDb({
      request_id: 'stable-memory-id', entity_type: 'user', entity_id: 'canonical-user',
      item_json: JSON.stringify(exportedMemory), status: 'processing', lease_token: 7,
      attempt_count: 2, cleanup_vector_id: 'stable-memory-id',
    });
    dependencies.deleteVector.mockImplementation(async () => {
      db.events.push('delete-pending');
    });
    dependencies.prepareMemoryWrite.mockImplementation(async () => {
      db.events.push('prepare');
      return { contentHash: 'content-hash', exactScopeKey: 'scope-key', duplicate: duplicateMemory() };
    });

    await processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory', requestId: 'stable-memory-id',
    });

    expect(db.events.slice(0, 2)).toEqual(['delete-pending', 'prepare']);
    expect(dependencies.deleteVector).toHaveBeenCalledOnce();
    expect(dependencies.deleteVector).toHaveBeenCalledWith(env.VECTORIZE, 'stable-memory-id');
  });

  it('preserves a cleanup marker on failure and consumes it on retry before completing', async () => {
    const db = durableImportDb({
      request_id: 'stable-memory-id', entity_type: 'user', entity_id: 'canonical-user',
      item_json: JSON.stringify(exportedMemory), status: 'processing', lease_token: 7,
      attempt_count: 2, cleanup_vector_id: 'stable-memory-id',
    });
    dependencies.deleteVector
      .mockRejectedValueOnce(new Error('Vector cleanup unavailable'))
      .mockResolvedValueOnce(undefined);
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'content-hash', exactScopeKey: 'scope-key', duplicate: duplicateMemory(),
    });

    await expect(processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory', requestId: 'stable-memory-id',
    })).rejects.toThrow('Vector cleanup unavailable');
    expect(db.statements.map(({ sql }) => sql).join('\n')).toMatch(/status = 'failed'/i);
    expect(db.statements.filter(({ sql }) => /SET cleanup_vector_id = NULL/i.test(sql)))
      .toHaveLength(0);

    await expect(processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory', requestId: 'stable-memory-id',
    })).resolves.toBe('processed');
    expect(dependencies.deleteVector).toHaveBeenCalledTimes(2);
    expect(db.statements.map(({ sql }) => sql).join('\n')).toMatch(/status = 'completed'/i);
  });

  it('reuses a distinct semantic preparation embedding and writes content identity metadata', async () => {
    const db = durableImportDb();
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'prepared-content-hash', exactScopeKey: 'scope-key', embedding: [0.7, 0.3],
    });
    dependencies.upsertVectors.mockResolvedValue(undefined);

    await processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory', requestId: 'stable-memory-id',
    });

    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).toHaveBeenCalledWith(env.VECTORIZE, [{
      id: 'stable-memory-id',
      values: [0.7, 0.3],
      metadata: expect.objectContaining({
        user_id: 'canonical-user',
        scope_key: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }]);
    const memoryInsert = db.statements.find(({ sql }) => /INSERT INTO memories/i.test(sql));
    expect(memoryInsert?.sql).toMatch(/content_hash/i);
    expect(memoryInsert?.bindings).toContain('prepared-content-hash');
  });

  it('does not complete a unique-index loser until its candidate vector is cleaned', async () => {
    const db = durableImportDb(undefined, { memoryInsertChanges: 0 });
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'content-hash', exactScopeKey: 'scope-key', embedding: [0.7, 0.3],
    });
    dependencies.findActiveExactMemory.mockResolvedValue(duplicateMemory());
    dependencies.upsertVectors.mockResolvedValue(undefined);
    dependencies.deleteVector.mockRejectedValue(new Error('Vector cleanup unavailable'));

    await expect(processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory', requestId: 'stable-memory-id',
    })).rejects.toThrow('Vector cleanup unavailable');

    expect(dependencies.findActiveExactMemory).toHaveBeenCalledWith(
      expect.objectContaining({ DB: db }),
      { userId: 'canonical-user', agentId: null },
      exportedMemory.memory,
      'content-hash',
      'stable-memory-id',
    );
    expect(db.statements.map(({ sql }) => sql).join('\n')).not.toMatch(/SET status = 'completed'/i);
    expect(db.statements.map(({ sql }) => sql).join('\n')).toMatch(/status = 'failed'/i);
  });

  it('does not delete a vector when the cleanup marker cannot be fenced to its lease', async () => {
    const db = durableImportDb({
      request_id: 'stable-memory-id', entity_type: 'user', entity_id: 'canonical-user',
      item_json: JSON.stringify(exportedMemory), status: 'processing', lease_token: 7,
      attempt_count: 2,
    }, { cleanupMarkerChanges: 0 });
    dependencies.prepareMemoryWrite.mockResolvedValue({
      contentHash: 'content-hash', exactScopeKey: 'scope-key', duplicate: duplicateMemory(),
    });

    await expect(processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory', requestId: 'stable-memory-id',
    })).rejects.toThrow(/cleanup became pending/i);

    expect(dependencies.deleteVector).not.toHaveBeenCalled();
    expect(db.statements.map(({ sql }) => sql).join('\n')).not.toMatch(/SET status = 'completed'/i);
  });

  it('directly embeds and stores the exact imported text with source timestamps', async () => {
    const itemWithDistinctTimestamps = {
      ...exportedMemory,
      updated_at: '2024-02-03T04:05:06.000Z',
    };
    const db = durableImportDb({
      request_id: 'stable-memory-id', entity_type: 'user', entity_id: 'user-123',
      item_json: JSON.stringify(itemWithDistinctTimestamps), status: 'processing', lease_token: 7,
    });
    dependencies.embedText.mockResolvedValue([0.1, 0.2]);
    dependencies.upsertVectors.mockResolvedValue(undefined);
    const job = {
      type: 'import-mem0-memory' as const,
      requestId: 'stable-memory-id',
      userId: 'user-123',
      item: itemWithDistinctTimestamps,
    };

    await processMem0ImportJob({ ...env, DB: db } as unknown as Env, job);

    expect(dependencies.embedText).toHaveBeenCalledWith(expect.objectContaining({ DB: db }), itemWithDistinctTimestamps.memory);
    expect(dependencies.upsertVectors).toHaveBeenCalledWith(env.VECTORIZE, [expect.objectContaining({
      id: 'stable-memory-id',
      metadata: expect.objectContaining({
        user_id: 'user-123',
        source: 'mem0-import',
        source_created_at: itemWithDistinctTimestamps.created_at,
        source_updated_at: itemWithDistinctTimestamps.updated_at,
      }),
    })]);
    const publicationBindings = db.statements
      .filter(({ sql }) => /INSERT INTO (memories|memory_history)/i.test(sql))
      .flatMap(({ bindings }) => bindings);
    expect(publicationBindings).toEqual(expect.arrayContaining([
      'stable-memory-id', 'stable-memory-id:import', itemWithDistinctTimestamps.memory,
      Math.floor(Date.parse(itemWithDistinctTimestamps.created_at) / 1000),
      Math.floor(Date.parse(itemWithDistinctTimestamps.updated_at) / 1000),
    ]));
    expect(db.batch).toHaveBeenCalledOnce();
  });

  it('stores an agent import without a user ID and indexes it as an agent', async () => {
    const db = durableImportDb({
      request_id: 'agent-memory-id', entity_type: 'agent', entity_id: 'hermes',
      item_json: JSON.stringify(exportedMemory), status: 'processing', lease_token: 7,
    });
    dependencies.embedText.mockResolvedValue([0.1, 0.2]);
    dependencies.upsertVectors.mockResolvedValue(undefined);

    await processMem0ImportJob({ ...env, DB: db } as unknown as Env, {
      type: 'import-mem0-memory',
      requestId: 'agent-memory-id',
    });

    const memoryInsert = db.statements.find(({ sql }) => /INSERT INTO memories/i.test(sql));
    expect(memoryInsert?.bindings.slice(0, 3)).toEqual(['agent-memory-id', null, 'hermes']);
    expect(dependencies.upsertVectors).toHaveBeenCalledWith(env.VECTORIZE, [expect.objectContaining({
      metadata: expect.objectContaining({ agent_id: 'hermes' }),
    })]);
  });

  it.each([
    {
      label: 'missing semantic deduplication configuration',
      error: new Error('Missing semantic deduplication configuration: DEDUP_LLM_API_BASE_URL'),
      detail: 'Missing semantic deduplication configuration: DEDUP_LLM_API_BASE_URL',
    },
    {
      label: 'invalid semantic model output',
      error: new Error('Invalid semantic duplicate selection: expected a candidate reference'),
      detail: 'Invalid semantic duplicate selection: expected a candidate reference',
    },
    {
      label: 'semantic provider HTTP failure',
      error: Object.assign(
        new Error('Provider HTTP 400: invalid structured response; key=dedup-test-secret'),
        { status: 400 },
      ),
      detail: 'Provider HTTP 400: invalid structured response',
    },
  ])('retries import preparation after $label without exposing credentials', async ({ error, detail }) => {
    const db = durableImportDb();
    dependencies.prepareMemoryWrite.mockRejectedValue(error);
    const delivery = {
      body: { type: 'import-mem0-memory' as const, requestId: 'stable-memory-id' },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handleMemoryQueue(
      { messages: [delivery] } as unknown as MessageBatch<Env['MEMORY_JOBS'] extends Queue<infer Job> ? Job : never>,
      { ...env, DB: db, DEDUP_LLM_API_KEY: 'dedup-test-secret' } as unknown as Env,
    );

    expect(delivery.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(delivery.ack).not.toHaveBeenCalled();
    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
    const failure = db.statements.find(({ sql }) => /SET status = 'failed'/i.test(sql));
    expect(failure?.bindings[0]).toContain(`Mem0 import preparation failed: ${detail}`);
    expect(failure?.bindings[0]).not.toContain('dedup-test-secret');
  });

  it('routes an import queue job through direct import processing and acknowledges it', async () => {
    const db = durableImportDb({
      request_id: 'queue-id', entity_type: 'user', entity_id: 'user-123',
      item_json: JSON.stringify(exportedMemory), status: 'processing', lease_token: 7,
    });
    dependencies.embedText.mockResolvedValue([0.1]);
    dependencies.upsertVectors.mockResolvedValue(undefined);
    const message = {
      body: { type: 'import-mem0-memory', requestId: 'queue-id' },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await handleMemoryQueue({ messages: [message] } as unknown as MessageBatch<Env['MEMORY_JOBS'] extends Queue<infer Job> ? Job : never>, { ...env, DB: db } as unknown as Env);

    expect(dependencies.embedText).toHaveBeenCalledWith(expect.objectContaining({ DB: db }), exportedMemory.memory);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });
});

describe('Mem0 agent reclassification', () => {
  const job = {
    type: 'reclassify-mem0-agent' as const,
    id: 'source-memory',
    sourceUserId: 'legacy-agent-user',
    agentId: 'agent-1',
    content: '  Exact raw memory.  ',
    metadataJson: JSON.stringify({ source: 'mem0', ignoredNull: null, agent_id: 'spoofed' }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.findActiveExactMemory.mockResolvedValue(undefined);
    dependencies.embedText.mockResolvedValue([0.4, 0.6]);
    dependencies.upsertVectors.mockResolvedValue(undefined);
    dependencies.deleteVector.mockResolvedValue(undefined);
  });

  it('backfills a null content hash and reindexes the moved row in its agent-only scope', async () => {
    const db = reclassificationDb({
      userId: null,
      agentId: 'agent-1',
      runId: 'run-1',
      actorId: 'actor-1',
      metadataJson: job.metadataJson,
    });
    const digest = await contentHash(job.content);

    await processMem0AgentReclassificationJob({ ...env, DB: db } as unknown as Env, job);

    expect(dependencies.findActiveExactMemory).toHaveBeenCalledWith(
      expect.objectContaining({ DB: db }),
      { userId: null, agentId: 'agent-1' },
      job.content,
      digest,
      job.id,
    );
    const update = db.statements.find(({ sql }) => /SET user_id = NULL, agent_id = \?/i.test(sql));
    expect(update?.sql).toMatch(/content_hash\s*=\s*COALESCE\(content_hash, \?\)/i);
    expect(update?.bindings).toEqual(expect.arrayContaining([
      'agent-1', digest, 'source-memory', 'legacy-agent-user',
    ]));
    expect(dependencies.embedText).toHaveBeenCalledWith(expect.objectContaining({ DB: db }), job.content);
    expect(dependencies.upsertVectors).toHaveBeenCalledWith(env.VECTORIZE, [{
      id: 'source-memory',
      values: [0.4, 0.6],
      metadata: {
        source: 'mem0',
        agent_id: 'agent-1',
        run_id: 'run-1',
        actor_id: 'actor-1',
        scope_key: await scopeKey({ userId: null, agentId: 'agent-1' }),
        content_hash: digest,
        memory_vector_schema: '1',
        vector_state_hash: await vectorStateHash({
          userId: null, agentId: 'agent-1', runId: 'run-1', actorId: 'actor-1',
          metadataJson: job.metadataJson, contentHash: digest,
        }),
      },
    }]);
    expect(dependencies.deleteVector).not.toHaveBeenCalled();
  });

  it('keeps the older exact target canonical and atomically rewires the source graph before deleting its vector', async () => {
    const db = reclassificationDb();
    const canonicalTarget = {
      id: 'older-target',
      userId: null,
      agentId: 'agent-1',
      runId: null,
      actorId: null,
      content: job.content,
      metadataJson: '{"canonical":true}',
      hash: 'target-hash',
      contentHash: null,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    };
    dependencies.findActiveExactMemory.mockResolvedValue(canonicalTarget);
    const digest = await contentHash(job.content);

    await processMem0AgentReclassificationJob({ ...env, DB: db } as unknown as Env, job);
    await processMem0AgentReclassificationJob({ ...env, DB: db } as unknown as Env, job);

    expect(dependencies.findActiveExactMemory).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ DB: db }),
      { userId: null, agentId: 'agent-1' },
      job.content,
      digest,
      job.id,
    );
    expect(db.batch).toHaveBeenCalledOnce();
    const [firstBatch] = db.batch.mock.calls[0];
    expect(firstBatch).toHaveLength(3);
    const copyLinks = db.statements.find(({ sql }) => /INSERT OR IGNORE INTO memory_entity_links/i.test(sql))!;
    const rewireRelationships = db.statements.find(({ sql }) => /UPDATE relationships/i.test(sql))!;
    const softDeleteSource = db.statements.find(({ sql }) => /SET deleted_at = unixepoch\(\)/i.test(sql))!;
    expect(copyLinks.sql).toMatch(/INSERT OR IGNORE INTO memory_entity_links[\s\S]*SELECT \?, links\.entity_id, links\.created_at[\s\S]*WHERE links\.memory_id = \?/i);
    expect(copyLinks.bindings.slice(0, 2)).toEqual(['older-target', 'source-memory']);
    expect(copyLinks.bindings).toEqual(expect.arrayContaining([
      'source-memory', 'legacy-agent-user', 'source-hash', 'older-target', 'target-hash',
    ]));
    expect(rewireRelationships.sql).toMatch(/UPDATE relationships\s+SET evidence_memory_id = \?\s+WHERE evidence_memory_id = \?/i);
    expect(rewireRelationships.bindings.slice(0, 2)).toEqual(['older-target', 'source-memory']);
    expect(softDeleteSource.sql).toMatch(/UPDATE memories\s+SET deleted_at = unixepoch\(\)\s+WHERE id = \?[\s\S]*guarded\.deleted_at IS NULL/i);
    expect(softDeleteSource.bindings[0]).toBe('source-memory');
    expect(softDeleteSource.bindings).toContain('older-target');
    expect(dependencies.deleteVector).toHaveBeenCalledTimes(2);
    expect(dependencies.deleteVector).toHaveBeenNthCalledWith(1, env.VECTORIZE, 'source-memory');
    expect(dependencies.embedText).not.toHaveBeenCalled();
    expect(dependencies.upsertVectors).not.toHaveBeenCalled();
  });
});
