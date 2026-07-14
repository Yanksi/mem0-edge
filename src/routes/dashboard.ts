import { Hono } from 'hono';
import { checkDashboardPassword } from '../auth';
import { renderDashboard, renderDashboardLogin } from '../dashboard/page';
import { listDashboardMemories, listDashboardUsers, setDashboardUserAlias } from '../dashboard/service';
import type { Env } from '../env';
import { listEntities, listRelationships } from '../graph/service';
import { enqueueMem0Import } from '../import/service';
import { DashboardMem0ImportRequest } from '../import/types';
import { searchMemories } from '../memory/service';

export const dashboardRoutes = new Hono<{ Bindings: Env }>();

const SESSION_COOKIE_NAME = '__Host-dashboard-session';
const SESSION_TTL_SECONDS = 15 * 60;
const encoder = new TextEncoder();

dashboardRoutes.get('/', async (context) => {
  const password = context.req.header('x-dashboard-password') ?? '';
  const hasSession = await hasValidDashboardSession(context.req.header('Cookie'), context.env.DASHBOARD_PASSWORD);
  if (!hasSession && !checkDashboardPassword(password, context.env)) return context.html(renderDashboardLogin(), 401);
  return context.html(renderDashboard());
});

dashboardRoutes.post('/login', async (context) => {
  const form = await context.req.raw.formData().catch(() => null);
  const password = form?.get('password');
  if (typeof password !== 'string' || !checkDashboardPassword(password, context.env)) {
    return context.html(renderDashboardLogin(), 401);
  }

  context.header('Set-Cookie', await createDashboardSessionCookie(context.env.DASHBOARD_PASSWORD));
  return context.redirect('/dashboard', 303);
});

dashboardRoutes.post('/logout', (context) => {
  context.header('Set-Cookie', `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`);
  return context.redirect('/dashboard', 303);
});

dashboardRoutes.use('/api/*', async (context, next) => {
  if (!await hasValidDashboardSession(context.req.header('Cookie'), context.env.DASHBOARD_PASSWORD)) {
    return context.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});

dashboardRoutes.get('/api/users', async (context) => {
  return context.json({ results: await listDashboardUsers(context.env) });
});

dashboardRoutes.put('/api/users/:userId/alias', async (context) => {
  const body = await context.req.json<{ alias?: unknown }>().catch(() => null);
  if (body === null || typeof body.alias !== 'string') return context.json({ error: 'Validation failed' }, 400);
  await setDashboardUserAlias(context.env, context.req.param('userId'), body.alias);
  return context.json({ ok: true });
});

dashboardRoutes.get('/api/memories', async (context) => {
  const userId = context.req.query('user_id');
  if (userId === undefined || userId.trim() === '') return context.json({ error: 'Validation failed' }, 400);
  const requestedOffset = Number(context.req.query('offset') ?? '0');
  const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
  return context.json(await listDashboardMemories(context.env, userId, offset));
});

dashboardRoutes.post('/api/search', async (context) => {
  const body = await context.req.json<{ user_id?: unknown; query?: unknown }>().catch(() => null);
  if (body === null || typeof body.user_id !== 'string' || body.user_id.trim() === '' || typeof body.query !== 'string') {
    return context.json({ error: 'Validation failed' }, 400);
  }
  return context.json({ results: await searchMemories(context.env, {
    user_id: body.user_id,
    query: body.query,
    limit: 10,
    filters: {},
  }) });
});

dashboardRoutes.post('/api/imports/mem0', async (context) => {
  const body = await context.req.json<unknown>().catch(() => null);
  const parsed = DashboardMem0ImportRequest.safeParse(body);
  if (!parsed.success) return context.json({ error: 'Validation failed' }, 400);

  const queued = await enqueueMem0Import(context.env, parsed.data.user_id, parsed.data.export);
  return context.json({ queued }, 202);
});

dashboardRoutes.get('/api/graph', async (context) => {
  const userId = context.req.query('user_id');
  if (userId === undefined || userId.trim() === '') return context.json({ error: 'Validation failed' }, 400);
  const [entities, relationships] = await Promise.all([
    listEntities(context.env, userId),
    listRelationships(context.env, userId),
  ]);
  return context.json({ entities, relationships });
});

async function createDashboardSessionCookie(password: string): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const signature = await signSessionExpiry(expiresAt, password);
  return `${SESSION_COOKIE_NAME}=${expiresAt}.${signature}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

async function hasValidDashboardSession(cookieHeader: string | undefined, password: string): Promise<boolean> {
  const value = readCookie(cookieHeader, SESSION_COOKIE_NAME);
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
