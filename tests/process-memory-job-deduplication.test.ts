/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as workerEnv, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, MemoryJob } from '../src/env';

const dependencies = vi.hoisted(() => ({
  embedText: vi.fn(),
  searchDeduplicationCandidates: vi.fn(),
}));

vi.mock('../src/llm', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/llm')>(),
  embedText: dependencies.embedText,
}));
vi.mock('../src/vectorize', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/vectorize')>(),
  searchDeduplicationCandidates: dependencies.searchDeduplicationCandidates,
}));

import { processMemoryJob, TransientMemoryJobError } from '../src/memory/service';

const env = workerEnv as unknown as Env;
const configuredEnv = (overrides: Partial<Env> = {}) => ({
  ...env,
  DEDUP_LLM_API_BASE_URL: 'https://dedup.example/v1',
  DEDUP_LLM_MODEL: 'dedup-model',
  DEDUP_LLM_API_KEY: 'dedup-key',
  DEDUP_SIMILARITY_THRESHOLD: '0.85',
  DEDUP_CANDIDATE_LIMIT: '8',
  ...overrides,
}) as Env;

const job: MemoryJob = {
  type: 'extract-and-store',
  requestId: 'request-123',
  body: {
    request_id: 'request-123',
    user_id: 'user-123',
    metadata: {},
    infer: false,
    async: true,
    messages: [{ role: 'user', content: 'The user resides in Zurich.' }],
  },
};

beforeEach(async () => {
  vi.clearAllMocks();
  dependencies.embedText.mockResolvedValue([0.1, 0.2]);
  dependencies.searchDeduplicationCandidates.mockResolvedValue([
    { id: 'candidate-1', score: 0.99 },
  ]);

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
      deleted_at INTEGER
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE memory_requests (
      user_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      agent_id TEXT,
      run_id TEXT,
      status TEXT NOT NULL,
      result_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      lease_token INTEGER NOT NULL DEFAULT 0,
      candidates_json TEXT,
      cleanup_vector_ids_json TEXT,
      PRIMARY KEY (user_id, idempotency_key)
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE service_settings (
      id INTEGER PRIMARY KEY,
      semantic_dedup_enabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `).run();
  await env.DB.prepare(
    'INSERT INTO service_settings (id, semantic_dedup_enabled) VALUES (1, 1)',
  ).run();
  await env.DB.prepare(`
    INSERT INTO memories (
      id, user_id, agent_id, run_id, actor_id, content, metadata_json, hash,
      content_hash, created_at, updated_at, deleted_at
    ) VALUES (?, ?, NULL, NULL, NULL, ?, '{}', ?, ?, ?, ?, NULL)
  `).bind(
    'candidate-1',
    'user-123',
    'The user lives in Zurich.',
    'candidate-request',
    'candidate-content-hash',
    1_784_028_800,
    1_784_028_800,
  ).run();
  await env.DB.prepare(`
    INSERT INTO memory_requests (
      user_id, idempotency_key, agent_id, run_id, status, result_json,
      error_message, created_at, updated_at, completed_at, lease_token,
      candidates_json, cleanup_vector_ids_json
    ) VALUES (?, ?, NULL, NULL, 'queued', NULL, NULL, ?, ?, NULL, 0, ?, NULL)
  `).bind(
    'user-123',
    'request-123',
    '2026-07-16T12:00:00.000Z',
    '2026-07-16T12:00:00.000Z',
    JSON.stringify([{ memory: 'The user resides in Zurich.', entities: [], relationships: [] }]),
  ).run();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

describe('processMemoryJob semantic deduplication failures', () => {
  it('marks malformed structured output failed and exposes a transient Queue error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'not json' } }],
    }), { status: 200 })));

    await expectRetryableFailure(
      configuredEnv(),
      'Semantic deduplication response contained an invalid result',
    );
  });

  it('marks missing dedicated configuration failed and exposes a transient Queue error', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expectRetryableFailure(
      configuredEnv({ DEDUP_LLM_API_KEY: undefined }),
      'Missing semantic deduplication configuration: DEDUP_LLM_API_KEY',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets explicit semantic retryability override a provider HTTP 400 status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('invalid request', { status: 400, statusText: 'Bad Request' }),
    ));

    await expectRetryableFailure(
      configuredEnv(),
      'Semantic deduplication request failed (400 Bad Request)',
    );
  });
});

async function expectRetryableFailure(testEnv: Env, expectedMessage: string): Promise<void> {
  const failure = await processMemoryJob(testEnv, job).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(TransientMemoryJobError);
  expect(failure).toMatchObject({
    message: expectedMessage,
    cause: { retryable: true },
  });
  await expect(env.DB.prepare(`
    SELECT status, error_message, lease_token
    FROM memory_requests
    WHERE user_id = ? AND idempotency_key = ?
  `).bind('user-123', 'request-123').first()).resolves.toEqual({
    status: 'failed',
    error_message: expectedMessage,
    lease_token: 1,
  });
}
