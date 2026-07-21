import { Hono } from 'hono';
import { z, ZodError } from 'zod';
import { apiAuth } from '../auth';
import type { Env } from '../env';
import {
  addMemory,
  deleteMemory,
  getMemoryById,
  getMemoryOwnerById,
  MemoryContentConflictError,
  MemoryMutationConflictError,
  DurableMemoryMutationError,
  searchMemories,
  updateMemory,
} from '../memory/service';
import { AddMemoryRequestSchema, HermesSearchRequestSchema } from '../memory/types';
import type { HermesSearchRequest, SearchMemoryRequest } from '../memory/types';
const HermesUpdateRequestSchema = z.object({ text: z.string().trim().min(1) });

export const hermesRoutes = new Hono<{ Bindings: Env }>();

hermesRoutes.use('*', apiAuth);

hermesRoutes.post('/memories', async (context) => {
  const request = await parseBody(context.req.raw, AddMemoryRequestSchema);
  if (request instanceof Response) return request;
  const result = await addMemory(context.env, request);
  return Array.isArray(result)
    ? context.json({ results: result })
    : context.json(result, 202);
});

hermesRoutes.post('/search', async (context) => {
  const request = await parseBody(context.req.raw, HermesSearchRequestSchema);
  if (request instanceof Response) return request;
  return context.json({
    results: await searchMemories(context.env, normalizeHermesSearch(request)),
  });
});

hermesRoutes.put('/memories/:id', async (context) => {
  const request = await parseBody(context.req.raw, HermesUpdateRequestSchema);
  if (request instanceof Response) return request;
  const memory = await getMemoryById(context.env, context.req.param('id'));
  if (memory === null) return notFound(context);
  if (memory.user_id === undefined) return context.json({ error: 'Memory is not user-scoped' }, 409);
  try {
    const updated = await updateMemory(context.env, memory.id, memory.user_id, { memory: request.text });
    return updated === null ? notFound(context) : context.json(updated);
  } catch (error) {
    if (error instanceof MemoryContentConflictError) {
      return context.json({ error: 'An active memory with this content already exists' }, 409);
    }
    if (error instanceof MemoryMutationConflictError) {
      return context.json({ error: 'Memory changed during update; retry with the latest version' }, 409);
    }
    if (error instanceof DurableMemoryMutationError) {
      context.header('Retry-After', '5');
      return context.json({ error: error.message, mutation_id: error.mutationId }, 503);
    }
    throw error;
  }
});

hermesRoutes.delete('/memories/:id', async (context) => {
  const memory = await getMemoryById(context.env, context.req.param('id'));
  const storedOwner = memory === null
    ? await getMemoryOwnerById(context.env, context.req.param('id'))
    : memory?.user_id;
  if (memory === null && storedOwner === undefined) return notFound(context);
  if (storedOwner === null || (memory !== null && memory !== undefined && memory.user_id === undefined)) {
    return context.json({ error: 'Memory is not user-scoped' }, 409);
  }
  if (storedOwner === undefined) return notFound(context);
  const deleted = await deleteMemory(context.env, context.req.param('id'), storedOwner);
  return deleted ? context.json({ deleted: true }) : notFound(context);
});

async function parseBody<T>(request: Request, schema: { parse(value: unknown): T }): Promise<T | Response> {
  try {
    return schema.parse(await request.json());
  } catch (error) {
    return Response.json({
      error: 'Validation failed',
      ...(error instanceof ZodError ? { details: error.issues } : {}),
    }, { status: 400 });
  }
}

export function normalizeHermesSearch(request: HermesSearchRequest): SearchMemoryRequest {
  const { user_id, agent_id, run_id, actor_id, ...filters } = request.filters;
  return {
    query: request.query,
    user_id,
    ...(agent_id === undefined ? {} : { agent_id }),
    ...(run_id === undefined ? {} : { run_id }),
    ...(actor_id === undefined ? {} : { actor_id }),
    limit: request.top_k,
    filters,
  };
}

function notFound(context: { json: (body: { error: string }, status: 404) => Response }): Response {
  return context.json({ error: 'Memory not found' }, 404);
}
