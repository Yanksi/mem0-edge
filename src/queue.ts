import type { Env, MemoryJob } from './env';
import { isMem0ImportJob, processMem0ImportJob } from './import/service';
import { processMemoryJob, TransientMemoryJobError } from './memory/service';
import { AddMemoryRequestSchema } from './memory/types';

function isMemoryJob(value: unknown): value is MemoryJob {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Partial<MemoryJob>;
  return job.type === 'extract-and-store'
    && typeof job.requestId === 'string'
    && job.requestId.trim().length > 0
    && AddMemoryRequestSchema.safeParse(job.body).success;
}

export async function handleMemoryQueue(batch: MessageBatch<MemoryJob>, env: Env): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    if (isMem0ImportJob(message.body)) {
      try {
        await processMem0ImportJob(env, message.body);
        message.ack();
      } catch (error) {
        if (isTransientQueueError(error)) {
          message.retry();
          return;
        }
        message.ack();
      }
      return;
    }

    if (!isMemoryJob(message.body)) {
      message.ack();
      return;
    }

    try {
      const result = await processMemoryJob(env, message.body);
      if (result === 'inflight') {
        message.retry();
        return;
      }
      message.ack();
    } catch (error) {
      if (error instanceof TransientMemoryJobError) {
        message.retry();
        return;
      }
      message.ack();
    }
  }));
}

function isTransientQueueError(error: unknown): boolean {
  if (error instanceof TransientMemoryJobError) return true;
  if (typeof error !== 'object' || error === null || typeof (error as { status?: unknown }).status !== 'number') {
    return true;
  }

  const status = (error as { status: number }).status;
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}
