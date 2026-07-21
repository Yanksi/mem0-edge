import type { Env, MemoryJob } from './env';
import { isMem0ImportJob, isReclassifyMem0AgentJob, processMem0AgentReclassificationJob, processMem0ImportJob } from './import/service';
import { processMemoryJob, TransientMemoryJobError } from './memory/service';
import { isUpdateMemoryJob, processMemoryUpdateMutation } from './memory/update-mutations';
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
  for (const message of batch.messages) await handleMemoryMessage(message, env);
}

async function handleMemoryMessage(message: Message<MemoryJob>, env: Env): Promise<void> {
  if (isUpdateMemoryJob(message.body)) {
    try {
      await processMemoryUpdateMutation(env, message.body.mutationId);
      message.ack();
    } catch (error) {
      if (isTransientQueueError(error)) return retryWithBackoff(message);
      message.ack();
    }
    return;
  }

  if (isMem0ImportJob(message.body)) {
    try {
      const result = await processMem0ImportJob(env, message.body);
      if (result === 'inflight') return retryWithBackoff(message);
      message.ack();
    } catch (error) {
      if (isTransientQueueError(error)) return retryWithBackoff(message);
      message.ack();
    }
    return;
  }

  if (isReclassifyMem0AgentJob(message.body)) {
    try {
      await processMem0AgentReclassificationJob(env, message.body);
      message.ack();
    } catch (error) {
      if (isTransientQueueError(error)) return retryWithBackoff(message);
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
    if (result === 'inflight') return retryWithBackoff(message);
    message.ack();
  } catch (error) {
    if (error instanceof TransientMemoryJobError) return retryWithBackoff(message);
    message.ack();
  }
}

function retryWithBackoff(message: Message<MemoryJob>): void {
  const attempt = Math.max(1, Number.isFinite(message.attempts) ? message.attempts : 1);
  message.retry({ delaySeconds: Math.min(300, 15 * (2 ** (attempt - 1))) });
}

function isTransientQueueError(error: unknown): boolean {
  if (error instanceof TransientMemoryJobError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; status?: unknown; retryable?: unknown; message?: unknown; cause?: unknown };
  const message = errorMessages(candidate).join(' ');
  if (candidate.code === 40041 || /\b40041\b|too many requests|vector_upsert_error/i.test(message)) return true;
  if (candidate.retryable === true) return true;
  if (typeof candidate.status !== 'number') {
    return /\b(d1|database|llm|openai|embed(?:ding)?|vector|network|timeout|temporar(?:y|ily)|unavailable)\b/i.test(message);
  }

  const status = candidate.status;
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function errorMessages(error: { message?: unknown; cause?: unknown }): string[] {
  const messages = typeof error.message === 'string' ? [error.message] : [];
  if (typeof error.cause === 'object' && error.cause !== null) {
    messages.push(...errorMessages(error.cause as { message?: unknown; cause?: unknown }));
  }
  return messages;
}
