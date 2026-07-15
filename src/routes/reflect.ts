import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { apiAuth } from '../auth';
import type { Env } from '../env';
import { GraphLlmConfigurationError, UpstreamServiceError } from '../llm';
import { reflectMemories } from '../reflect/service';
import { ReflectRequestSchema } from '../reflect/types';

export const reflectRoutes = new Hono<{ Bindings: Env }>();

reflectRoutes.use('*', apiAuth);

reflectRoutes.post('/', async (context) => {
  let request: ReturnType<typeof ReflectRequestSchema.parse>;
  try {
    request = ReflectRequestSchema.parse(await context.req.json());
  } catch {
    return context.json({ error: 'Validation failed' }, 400);
  }

  const requestId = nanoid();
  const startedAt = Date.now();
  let event = 'reflect.completed';
  try {
    return context.json(await reflectMemories(context.env, request, requestId));
  } catch (error) {
    event = 'reflect.failed';
    console.error(JSON.stringify({
      event: 'reflect.error',
      request_id: requestId,
      user_id: request.user_id,
      agent_id: request.agent_id,
      error_name: error instanceof Error ? error.name : 'UnknownError',
      error_message: error instanceof Error ? error.message : String(error),
    }));
    if (error instanceof GraphLlmConfigurationError) {
      return context.json({ error: 'Graph reflection is not configured' }, 503);
    }
    if (error instanceof UpstreamServiceError) {
      return context.json({ error: 'Graph reflection provider request failed' }, 502);
    }
    throw error;
  } finally {
    console.log(JSON.stringify({
      event,
      request_id: requestId,
      user_id: request.user_id,
      agent_id: request.agent_id,
      latency_ms: Date.now() - startedAt,
    }));
  }
});
