import { Hono } from 'hono';
import { checkDashboardPassword } from '../auth';
import { renderDashboard, renderDashboardLogin } from '../dashboard/page';
import {
  listDashboardMemories,
  getDashboardSettings,
  reindexDashboardMemory,
  listDashboardUsers,
  setDashboardUserAlias,
  setDashboardSettings,
} from '../dashboard/service';
import type { Env } from '../env';
import { listEntities, listRelationships } from '../graph/service';
import { enqueueMem0AgentReclassification, enqueueMem0Import } from '../import/service';
import { DashboardMem0ImportRequest } from '../import/types';
import { searchMemories } from '../memory/service';
import { DedupLlmConfigurationError } from '../settings/service';

type DashboardEntityType = 'user' | 'agent';

export const dashboardRoutes = new Hono<{ Bindings: Env }>();

const SECURE_SESSION_COOKIE_NAME = '__Host-dashboard-session';
const LOCAL_SESSION_COOKIE_NAME = 'dashboard-session';
const SESSION_TTL_SECONDS = 15 * 60;
const encoder = new TextEncoder();

dashboardRoutes.get('/', async (context) => {
  const password = context.req.header('x-dashboard-password') ?? '';
  const hasSession = await hasValidDashboardSession(context.req.header('Cookie'), context.env.DASHBOARD_PASSWORD, context.req.url);
  if (!hasSession && !checkDashboardPassword(password, context.env)) return context.html(renderDashboardLogin(), 401);
  return context.html(renderDashboard(context.env.DASHBOARD_READ_ONLY === 'true'));
});

dashboardRoutes.post('/login', async (context) => {
  const form = await context.req.raw.formData().catch(() => null);
  const password = form?.get('password');
  if (typeof password !== 'string' || !checkDashboardPassword(password, context.env)) {
    return context.html(renderDashboardLogin(), 401);
  }

  context.header('Set-Cookie', await createDashboardSessionCookie(context.env.DASHBOARD_PASSWORD, context.req.url));
  return context.redirect('/dashboard', 303);
});

dashboardRoutes.post('/logout', (context) => {
  const secure = isSecureDashboardRequest(context.req.url);
  context.header('Set-Cookie', `${dashboardSessionCookieName(secure)}=; Max-Age=0; Path=/; HttpOnly${secure ? '; Secure' : ''}; SameSite=Strict`);
  return context.redirect('/dashboard', 303);
});

dashboardRoutes.use('/api/*', async (context, next) => {
  if (!await hasValidDashboardSession(context.req.header('Cookie'), context.env.DASHBOARD_PASSWORD, context.req.url)) {
    return context.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});

dashboardRoutes.get('/api/users', async (context) => {
  return context.json({ results: await listDashboardUsers(context.env) });
});

dashboardRoutes.put('/api/users/:userId/alias', async (context) => {
  const readOnlyError = dashboardMutationReadOnlyError(context.env);
  if (readOnlyError !== undefined) return context.json(readOnlyError, 403);
  const body = await context.req.json<{ alias?: unknown }>().catch(() => null);
  if (body === null || typeof body.alias !== 'string') return context.json({ error: 'Validation failed' }, 400);
  await setDashboardUserAlias(context.env, context.req.param('userId'), body.alias);
  return context.json({ ok: true });
});

dashboardRoutes.get('/api/memories', async (context) => {
  const scope = dashboardScope(context.req.query('entity_type'), context.req.query('entity_id'), context.req.query('user_id'));
  if (scope === undefined) return context.json({ error: 'Validation failed' }, 400);
  const requestedOffset = Number(context.req.query('offset') ?? '0');
  const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
  return context.json(await listDashboardMemories(context.env, scope.entityType, scope.entityId, offset));
});

dashboardRoutes.get('/api/settings', async (context) => {
  const settings = await getDashboardSettings(context.env);
  return context.json({ semantic_dedup_enabled: settings.semantic_dedup_enabled });
});

dashboardRoutes.put('/api/settings', async (context) => {
  const readOnlyError = dashboardMutationReadOnlyError(context.env);
  if (readOnlyError !== undefined) return context.json(readOnlyError, 403);
  const body = await context.req.json<unknown>().catch(() => null);
  if (!isDashboardSettingsBody(body)) return context.json({ error: 'Validation failed' }, 400);

  try {
    const settings = await setDashboardSettings(context.env, body.semantic_dedup_enabled);
    return context.json({ semantic_dedup_enabled: settings.semantic_dedup_enabled });
  } catch (error) {
    if (error instanceof DedupLlmConfigurationError) {
      return context.json({ error: 'Semantic deduplication is not configured' }, 409);
    }
    throw error;
  }
});

dashboardRoutes.post('/api/memories/:id/reindex', async (context) => {
  const readOnlyError = dashboardMutationReadOnlyError(context.env);
  if (readOnlyError !== undefined) return context.json(readOnlyError, 403);
  const body = await context.req.json<{ entity_type?: unknown; entity_id?: unknown }>().catch(() => null);
  const scope = body === null ? undefined : dashboardScope(body.entity_type, body.entity_id, undefined);
  if (scope === undefined) return context.json({ error: 'Validation failed' }, 400);

  const reindexed = await reindexDashboardMemory(context.env, scope.entityType, scope.entityId, context.req.param('id'));
  return reindexed ? context.json({ ok: true }) : context.json({ error: 'Memory not found' }, 404);
});

dashboardRoutes.post('/api/search', async (context) => {
  const body = await context.req.json<{ entity_type?: unknown; entity_id?: unknown; user_id?: unknown; query?: unknown }>().catch(() => null);
  const scope = body === null ? undefined : dashboardScope(body.entity_type, body.entity_id, body.user_id);
  if (scope === undefined || typeof body?.query !== 'string') {
    return context.json({ error: 'Validation failed' }, 400);
  }
  return context.json({ results: await searchMemories(context.env, {
    ...(scope.entityType === 'user' ? { user_id: scope.entityId } : { agent_id: scope.entityId }),
    query: body.query,
    limit: 10,
    filters: {},
  }) });
});

dashboardRoutes.post('/api/imports/mem0', async (context) => {
  const readOnlyError = dashboardMutationReadOnlyError(context.env);
  if (readOnlyError !== undefined) return context.json(readOnlyError, 403);
  const body = await context.req.json<unknown>().catch(() => null);
  const parsed = DashboardMem0ImportRequest.safeParse(body);
  if (!parsed.success) return context.json({ error: 'Validation failed' }, 400);

  const queued = await enqueueMem0Import(context.env, {
    entityType: parsed.data.entity_type,
    entityId: parsed.data.entity_id,
  }, parsed.data.export);
  return context.json({ queued }, 202);
});

dashboardRoutes.post('/api/entities/reclassify-agent', async (context) => {
  const readOnlyError = dashboardMutationReadOnlyError(context.env);
  if (readOnlyError !== undefined) return context.json(readOnlyError, 403);
  const body = await context.req.json<{ source_user_id?: unknown; agent_id?: unknown }>().catch(() => null);
  const sourceUserId = typeof body?.source_user_id === 'string' ? body.source_user_id : context.req.query('source_user_id');
  const agentId = typeof body?.agent_id === 'string' ? body.agent_id : context.req.query('agent_id');
  if (sourceUserId === undefined || sourceUserId.trim() === '' || agentId === undefined || agentId.trim() === '') {
    return context.json({ error: 'Validation failed' }, 400);
  }
  const queued = await enqueueMem0AgentReclassification(context.env, sourceUserId, agentId);
  return context.json({ queued }, 202);
});

dashboardRoutes.get('/api/graph', async (context) => {
  const scope = dashboardScope(context.req.query('entity_type'), context.req.query('entity_id'), context.req.query('user_id'));
  if (scope === undefined || scope.entityType !== 'user') return context.json({ error: 'Memory graphs are available for user entities only' }, 400);
  const [entities, relationships] = await Promise.all([
    listEntities(context.env, scope.entityId),
    listRelationships(context.env, scope.entityId),
  ]);
  return context.json({ entities, relationships });
});

async function createDashboardSessionCookie(password: string, requestUrl: string): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const signature = await signSessionExpiry(expiresAt, password);
  const secure = isSecureDashboardRequest(requestUrl);
  return `${dashboardSessionCookieName(secure)}=${expiresAt}.${signature}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly${secure ? '; Secure' : ''}; SameSite=Strict`;
}

function dashboardScope(entityType: unknown, entityId: unknown, legacyUserId: unknown): { entityType: DashboardEntityType; entityId: string } | undefined {
  if ((entityType === 'user' || entityType === 'agent') && typeof entityId === 'string' && entityId.trim() !== '') {
    return { entityType, entityId };
  }
  if (typeof legacyUserId === 'string' && legacyUserId.trim() !== '') return { entityType: 'user', entityId: legacyUserId };
  return undefined;
}

function isDashboardSettingsBody(value: unknown): value is { semantic_dedup_enabled: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1
    && keys[0] === 'semantic_dedup_enabled'
    && typeof (value as Record<string, unknown>).semantic_dedup_enabled === 'boolean';
}

function dashboardMutationReadOnlyError(env: Env): { error: string } | undefined {
  return env.DASHBOARD_READ_ONLY === 'true'
    ? { error: 'Dashboard is read-only in this preview' }
    : undefined;
}

async function hasValidDashboardSession(cookieHeader: string | undefined, password: string, requestUrl: string): Promise<boolean> {
  const value = readCookie(cookieHeader, dashboardSessionCookieName(isSecureDashboardRequest(requestUrl)));
  const match = value?.match(/^(\d+)\.([A-Za-z0-9_-]+)$/);
  if (match === undefined || match === null || password === '') return false;

  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;

  try {
    const key = await dashboardSigningKey(password, ['verify']);
    return crypto.subtle.verify('HMAC', key, base64UrlDecode(match[2]), encoder.encode(`dashboard-session:${expiresAt}`));
  } catch {
    return false;
  }
}

function isSecureDashboardRequest(requestUrl: string): boolean {
  return new URL(requestUrl).protocol === 'https:';
}

function dashboardSessionCookieName(secure: boolean): string {
  return secure ? SECURE_SESSION_COOKIE_NAME : LOCAL_SESSION_COOKIE_NAME;
}

async function signSessionExpiry(expiresAt: number, password: string): Promise<string> {
  const key = await dashboardSigningKey(password, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`dashboard-session:${expiresAt}`));
  return base64UrlEncode(signature);
}

function dashboardSigningKey(password: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  return cookieHeader?.split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
}

function base64UrlEncode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecode(value: string): ArrayBuffer {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}
