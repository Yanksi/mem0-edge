import { Hono } from 'hono';
import { ZodError } from 'zod';
import { apiAuth } from '../auth';
import type { Env } from '../env';
import {
  addMemory,
  deleteMemory,
  getMemory,
  getMemoryById,
  getMemoryOwnerById,
  listMemories,
  MemoryContentConflictError,
  MemoryMutationConflictError,
  DurableMemoryMutationError,
  searchMemories,
  updateMemory,
} from '../memory/service';
import {
  AddMemoryRequestSchema,
  HermesSearchRequestSchema,
  SearchMemoryRequestSchema,
  UpdateMemoryRequestSchema,
} from '../memory/types';
import { normalizeHermesSearch } from './hermes';

export const memoriesRoutes = new Hono<{ Bindings: Env }>();

memoriesRoutes.use('*', apiAuth);

memoriesRoutes.post('/', async (context) => {
  const request = await parseBody(context.req.raw, AddMemoryRequestSchema);
  if (request instanceof Response) return request;
  const result = await addMemory(context.env, request);
  return Array.isArray(result)
    ? context.json({ results: result })
    : context.json(result, 202);
});

memoriesRoutes.post('/search', async (context) => {
  const request = await parseSearchBody(context.req.raw);
  if (request instanceof Response) return request;
  return context.json({ results: await searchMemories(context.env, request) });
});

memoriesRoutes.get('/', async (context) => {
  const userId = context.req.query('user_id');
  if (userId === undefined || userId.trim() === '') return validationError();
  const requestedLimit = Number(context.req.query('limit') ?? '100');
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 100) : 100;
  return context.json({ results: await listMemories(context.env, userId, limit) });
});

memoriesRoutes.get('/:id', async (context) => {
  const userId = requiredUserId(context.req.query('user_id'));
  if (userId instanceof Response) return userId;
  const memory = await getMemory(context.env, context.req.param('id'), userId);
  return memory === null ? notFound(context) : context.json(memory);
});

memoriesRoutes.patch('/:id', async (context) => {
  const userId = requiredUserId(context.req.query('user_id'));
  if (userId instanceof Response) return userId;
  const request = await parseBody(context.req.raw, UpdateMemoryRequestSchema);
  if (request instanceof Response) return request;
  try {
    const memory = await updateMemory(context.env, context.req.param('id'), userId, request);
    return memory === null ? notFound(context) : context.json(memory);
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

memoriesRoutes.delete('/:id', async (context) => {
  const requestedUserId = context.req.query('user_id');
  if (requestedUserId !== undefined && requestedUserId.trim() === '') return validationError();
  const memory = requestedUserId === undefined ? await getMemoryById(context.env, context.req.param('id')) : null;
  const storedOwner = requestedUserId === undefined && memory === null
    ? await getMemoryOwnerById(context.env, context.req.param('id'))
    : memory?.user_id;
  if (memory !== null && memory !== undefined && memory.user_id === undefined) return context.json({ error: 'Memory is not user-scoped' }, 409);
  if (memory === null && storedOwner === null) return context.json({ error: 'Memory is not user-scoped' }, 409);
  const userId = requestedUserId ?? storedOwner;
  if (userId === null) return context.json({ error: 'Memory is not user-scoped' }, 409);
  if (userId === undefined) return memory === null ? notFound(context) : validationError();
  const deleted = await deleteMemory(context.env, context.req.param('id'), userId);
  return deleted ? context.json({ deleted: true }) : notFound(context);
});

async function parseSearchBody(request: Request): Promise<import('../memory/types').SearchMemoryRequest | Response> {
  try {
    const body: unknown = await request.json();
    const native = SearchMemoryRequestSchema.safeParse(body);
    if (native.success) return native.data;
    const hermes = HermesSearchRequestSchema.safeParse(body);
    if (hermes.success) return normalizeHermesSearch(hermes.data);
    return validationError(native.error.issues);
  } catch {
    return validationError();
  }
}

async function parseBody<T>(request: Request, schema: { parse(value: unknown): T }): Promise<T | Response> {
  try {
    return schema.parse(await request.json());
  } catch (error) {
    return validationError(error instanceof ZodError ? error.issues : undefined);
  }
}

function validationError(details?: unknown): Response {
  return Response.json({ error: 'Validation failed', ...(details === undefined ? {} : { details }) }, { status: 400 });
}

function requiredUserId(userId: string | undefined): string | Response {
  return userId === undefined || userId.trim() === '' ? validationError() : userId;
}

function notFound(context: { json: (body: { error: string }, status: 404) => Response }): Response {
  return context.json({ error: 'Memory not found' }, 404);
}
