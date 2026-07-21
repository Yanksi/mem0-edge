import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, MemoryJob } from '../src/env';

const service = vi.hoisted(() => {
  class TransientMemoryJobError extends Error {}
  return {
    processMemoryJob: vi.fn(),
    TransientMemoryJobError,
  };
});

const importService = vi.hoisted(() => ({
  isMem0ImportJob: vi.fn((value: unknown) => (
    typeof value === 'object' && value !== null && (value as { type?: string }).type === 'import-mem0-memory'
  )),
  isReclassifyMem0AgentJob: vi.fn(() => false),
  processMem0ImportJob: vi.fn(),
  processMem0AgentReclassificationJob: vi.fn(),
}));
const updateService = vi.hoisted(() => ({
  isUpdateMemoryJob: vi.fn((value: unknown) => (
    typeof value === 'object' && value !== null && (value as { type?: string }).type === 'update-memory'
  )),
  processMemoryUpdateMutation: vi.fn(),
  dispatchPendingMemoryUpdates: vi.fn(),
}));

vi.mock('../src/memory/service', () => service);
vi.mock('../src/import/service', () => importService);
vi.mock('../src/memory/update-mutations', () => updateService);

import { handleMemoryQueue } from '../src/queue';
import worker from '../src/index';

const env = {} as Env;
const validJob: MemoryJob = {
  type: 'extract-and-store',
  requestId: 'request-123',
  body: {
    request_id: 'request-123',
    user_id: 'user-123',
    messages: [{ role: 'user', content: 'Remember this.' }],
  },
};

function message(body: unknown, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function batch(...messages: ReturnType<typeof message>[]): MessageBatch<MemoryJob> {
  return { messages } as unknown as MessageBatch<MemoryJob>;
}

describe('handleMemoryQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.processMemoryJob.mockReset();
    importService.processMem0ImportJob.mockReset();
    updateService.processMemoryUpdateMutation.mockReset();
  });

  it('acknowledges a successfully processed job', async () => {
    const job = message(validJob);

    await handleMemoryQueue(batch(job), env);

    expect(service.processMemoryJob).toHaveBeenCalledWith(env, validJob);
    expect(job.ack).toHaveBeenCalledOnce();
    expect(job.retry).not.toHaveBeenCalled();
  });

  it('acknowledges malformed jobs without processing them', async () => {
    const job = message({ type: 'extract-and-store', requestId: '', body: {} });

    await handleMemoryQueue(batch(job), env);

    expect(service.processMemoryJob).not.toHaveBeenCalled();
    expect(job.ack).toHaveBeenCalledOnce();
    expect(job.retry).not.toHaveBeenCalled();
  });

  it('processes durable update jobs by mutation ID and acknowledges success', async () => {
    const job = message({ type: 'update-memory', mutationId: 'mutation-1' });

    await handleMemoryQueue(batch(job), env);

    expect(updateService.processMemoryUpdateMutation).toHaveBeenCalledWith(env, 'mutation-1');
    expect(job.ack).toHaveBeenCalledOnce();
  });

  it('retries transient durable update failures', async () => {
    const job = message({ type: 'update-memory', mutationId: 'mutation-1' }, 2);
    updateService.processMemoryUpdateMutation.mockRejectedValue(Object.assign(
      new Error('Vector service unavailable'), { retryable: true },
    ));

    await handleMemoryQueue(batch(job), env);

    expect(job.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(job.ack).not.toHaveBeenCalled();
  });

  it('retries transient processing failures without acknowledging the message', async () => {
    const job = message(validJob);
    service.processMemoryJob.mockRejectedValue(new service.TransientMemoryJobError('D1 unavailable'));

    await handleMemoryQueue(batch(job), env);

    expect(job.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(job.ack).not.toHaveBeenCalled();
  });

  it('retries an inflight processing lease without acknowledging the message', async () => {
    const job = message(validJob);
    service.processMemoryJob.mockResolvedValue('inflight');

    await handleMemoryQueue(batch(job), env);

    expect(job.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(job.ack).not.toHaveBeenCalled();
  });

  it('handles each message independently', async () => {
    const successful = message(validJob);
    const transient = message({ ...validJob, requestId: 'request-456' });
    const invalid = message({ type: 'wrong-type', requestId: 'request-789', body: validJob.body });
    service.processMemoryJob
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new service.TransientMemoryJobError('embedding unavailable'));

    await handleMemoryQueue(batch(successful, transient, invalid), env);

    expect(successful.ack).toHaveBeenCalledOnce();
    expect(successful.retry).not.toHaveBeenCalled();
    expect(transient.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(transient.ack).not.toHaveBeenCalled();
    expect(invalid.ack).toHaveBeenCalledOnce();
    expect(invalid.retry).not.toHaveBeenCalled();
  });

  it('processes messages sequentially inside one delivered batch', async () => {
    const first = message(validJob);
    const second = message({ ...validJob, requestId: 'request-456' });
    let active = 0;
    let maximumActive = 0;
    service.processMemoryJob.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return 'processed';
    });

    await handleMemoryQueue(batch(first, second), env);

    expect(maximumActive).toBe(1);
    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.ack).toHaveBeenCalledOnce();
  });

  it('retries Vectorize 40041 with exponential delay even when surfaced as HTTP 400', async () => {
    const job = message({ type: 'import-mem0-memory', requestId: 'import-1' }, 3);
    importService.processMem0ImportJob.mockRejectedValue(Object.assign(
      new Error('VECTOR_UPSERT_ERROR (code = 40041): Too Many Requests'),
      { status: 400, code: 40041 },
    ));

    await handleMemoryQueue(batch(job), env);

    expect(job.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(job.ack).not.toHaveBeenCalled();
  });

  it.each([
    Object.assign(new Error('Embedding request rate limited'), { status: 429 }),
    Object.assign(new Error('Vector service unavailable'), { status: 503 }),
    new Error('Network timeout while writing vector'),
  ])('retries other transient import infrastructure failures', async (error) => {
    const job = message({ type: 'import-mem0-memory', requestId: 'import-1' }, 2);
    importService.processMem0ImportJob.mockRejectedValue(error);

    await handleMemoryQueue(batch(job), env);

    expect(job.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(job.ack).not.toHaveBeenCalled();
  });

  it('retries an inflight import lease with capped backoff', async () => {
    const job = message({ type: 'import-mem0-memory', requestId: 'import-1' }, 8);
    importService.processMem0ImportJob.mockResolvedValue('inflight');

    await handleMemoryQueue(batch(job), env);

    expect(job.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
    expect(job.ack).not.toHaveBeenCalled();
  });

  it('acknowledges permanent import data errors and leaves their failure in D1', async () => {
    const job = message({ type: 'import-mem0-memory', requestId: 'import-1' });
    importService.processMem0ImportJob.mockRejectedValue(new Error('Invalid persisted Mem0 import item'));

    await handleMemoryQueue(batch(job), env);

    expect(job.ack).toHaveBeenCalledOnce();
    expect(job.retry).not.toHaveBeenCalled();
  });

  it('delegates the default worker queue handler to the queue processor', async () => {
    const job = message(validJob);

    await worker.queue?.(batch(job), env);

    expect(service.processMemoryJob).toHaveBeenCalledWith(env, validJob);
    expect(job.ack).toHaveBeenCalledOnce();
  });
});
