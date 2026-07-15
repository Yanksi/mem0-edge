import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';

const dependencies = vi.hoisted(() => ({
  embedText: vi.fn(),
  upsertVectors: vi.fn(),
}));

vi.mock('../src/llm', () => ({ embedText: dependencies.embedText }));
vi.mock('../src/vectorize', () => ({ upsertVectors: dependencies.upsertVectors }));

import { handleMemoryQueue } from '../src/queue';
import worker from '../src/index';
import {
  dispatchPendingMem0Imports,
  enqueueMem0Import,
  processMem0ImportJob,
  RawMemoryMigrationExport,
} from '../src/import/service';

const env = {
  MEMORY_JOBS: { send: vi.fn(), sendBatch: vi.fn() },
  VECTORIZE: {} as VectorizeIndex,
} as unknown as Env;

const exportedMemory = {
  memory: '  User prefers espresso.  ',
  created_at: '2024-01-02T03:04:05.000Z',
  updated_at: null,
};

function durableImportDb(canonical = {
  request_id: 'stable-memory-id',
  entity_type: 'user',
  entity_id: 'canonical-user',
  item_json: JSON.stringify(exportedMemory),
  status: 'processing',
  lease_token: 7,
}, options: {
  claim?: typeof canonical | null;
  completionChanges?: number;
  existingRows?: Array<typeof canonical | null>;
  dispatchRows?: Array<{ request_id: string; publish_token: number }>;
} = {}) {
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
        if (/UPDATE mem0_import_requests/i.test(sql) && /RETURNING/i.test(sql)) return options.claim === undefined ? canonical : options.claim;
        if (/SELECT/i.test(sql) && /FROM mem0_import_requests/i.test(sql)) {
          if (options.existingRows !== undefined && existingRead < options.existingRows.length) {
            return options.existingRows[existingRead++];
          }
          return canonical;
        }
        return null;
      }),
      all: vi.fn(async () => ({
        success: true,
        results: /publish_token = publish_token \+ 1/i.test(sql) ? (options.dispatchRows ?? []) : [],
        meta: { changes: options.dispatchRows?.length ?? 0 },
      })),
      run: vi.fn(async () => ({ success: true, results: [], meta: { changes: 1 } })),
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

describe('Mem0 migration imports', () => {
  beforeEach(() => vi.clearAllMocks());

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
    expect(publicationSql.match(/status = 'processing' AND lease_token = \?/gi)).toHaveLength(3);
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
