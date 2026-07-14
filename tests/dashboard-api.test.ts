import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';

const dashboardService = vi.hoisted(() => ({
  listDashboardUsers: vi.fn(),
  setDashboardUserAlias: vi.fn(),
  listDashboardMemories: vi.fn(),
}));
const graphService = vi.hoisted(() => ({
  listEntities: vi.fn(),
  listRelationships: vi.fn(),
}));
const memoryService = vi.hoisted(() => ({
  searchMemories: vi.fn(),
}));
const importService = vi.hoisted(() => ({
  enqueueMem0Import: vi.fn(),
}));

vi.mock('../src/dashboard/service', () => dashboardService);
vi.mock('../src/graph/service', () => graphService);
vi.mock('../src/memory/service', () => memoryService);
vi.mock('../src/import/service', () => importService);

import worker from '../src/index';

const env = { DASHBOARD_PASSWORD: 'dashboard-secret' } as Env;

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://example.com${path}`, init);
}

async function dashboardCookie(): Promise<string> {
  const response = await worker.fetch(request('/dashboard/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=dashboard-secret',
  }), env);
  return response.headers.get('Set-Cookie')!.split(';', 1)[0];
}

describe('dashboard operator API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires a signed dashboard session', async () => {
    const response = await worker.fetch(request('/dashboard/api/users'), env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(dashboardService.listDashboardUsers).not.toHaveBeenCalled();
  });

  it('discovers users through the dashboard service', async () => {
    dashboardService.listDashboardUsers.mockResolvedValue([
      { user_id: 'discord:42', alias: 'Shuhao', memory_count: 3 },
    ]);

    const response = await worker.fetch(request('/dashboard/api/users', {
      headers: { Cookie: await dashboardCookie() },
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [{ user_id: 'discord:42', alias: 'Shuhao', memory_count: 3 }],
    });
    expect(dashboardService.listDashboardUsers).toHaveBeenCalledWith(env);
  });

  it('persists and clears aliases through the authenticated endpoint', async () => {
    const headers = { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' };
    const setAlias = await worker.fetch(request('/dashboard/api/users/discord%3A42/alias', {
      method: 'PUT', headers, body: JSON.stringify({ alias: 'Shuhao' }),
    }), env);
    const clearAlias = await worker.fetch(request('/dashboard/api/users/discord%3A42/alias', {
      method: 'PUT', headers, body: JSON.stringify({ alias: '  ' }),
    }), env);

    expect(setAlias.status).toBe(200);
    expect(clearAlias.status).toBe(200);
    expect(dashboardService.setDashboardUserAlias).toHaveBeenNthCalledWith(1, env, 'discord:42', 'Shuhao');
    expect(dashboardService.setDashboardUserAlias).toHaveBeenNthCalledWith(2, env, 'discord:42', '  ');
  });

  it('returns paginated memories for the selected user', async () => {
    dashboardService.listDashboardMemories.mockResolvedValue({ results: [{ id: 'memory-1' }], next_offset: 50 });

    const response = await worker.fetch(request('/dashboard/api/memories?user_id=discord%3A42&offset=50', {
      headers: { Cookie: await dashboardCookie() },
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [{ id: 'memory-1' }], next_offset: 50 });
    expect(dashboardService.listDashboardMemories).toHaveBeenCalledWith(env, 'discord:42', 50);
  });

  it('searches and loads a graph for the selected user', async () => {
    memoryService.searchMemories.mockResolvedValue([{ id: 'memory-1' }]);
    graphService.listEntities.mockResolvedValue([{ id: 'entity-1' }]);
    graphService.listRelationships.mockResolvedValue([{ id: 'relationship-1' }]);
    const cookie = await dashboardCookie();

    const search = await worker.fetch(request('/dashboard/api/search', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'discord:42', query: 'city' }),
    }), env);
    const graph = await worker.fetch(request('/dashboard/api/graph?user_id=discord%3A42', {
      headers: { Cookie: cookie },
    }), env);

    await expect(search.json()).resolves.toEqual({ results: [{ id: 'memory-1' }] });
    await expect(graph.json()).resolves.toEqual({
      entities: [{ id: 'entity-1' }],
      relationships: [{ id: 'relationship-1' }],
    });
    expect(memoryService.searchMemories).toHaveBeenCalledWith(env, {
      user_id: 'discord:42', query: 'city', limit: 10, filters: {},
    });
    expect(graphService.listEntities).toHaveBeenCalledWith(env, 'discord:42');
    expect(graphService.listRelationships).toHaveBeenCalledWith(env, 'discord:42');
  });

  it('accepts a signed Mem0 import and queues every exported memory', async () => {
    importService.enqueueMem0Import.mockResolvedValue(2);
    const exportPayload = {
      memories: [
        { memory: 'User lives in Zurich.', created_at: '2024-01-01T00:00:00.000Z', updated_at: null },
        { memory: 'User likes espresso.', created_at: null, updated_at: '2024-02-01T00:00:00.000Z' },
      ],
    };

    const response = await worker.fetch(request('/dashboard/api/imports/mem0', {
      method: 'POST',
      headers: { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'discord:42', export: exportPayload }),
    }), env);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ queued: 2 });
    expect(importService.enqueueMem0Import).toHaveBeenCalledWith(env, 'discord:42', exportPayload);
  });

  it('rejects malformed Mem0 imports before queueing', async () => {
    const response = await worker.fetch(request('/dashboard/api/imports/mem0', {
      method: 'POST',
      headers: { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'discord:42', export: { memories: [{ memory: '', created_at: 'not-a-date', updated_at: null }] } }),
    }), env);

    expect(response.status).toBe(400);
    expect(importService.enqueueMem0Import).not.toHaveBeenCalled();
  });
});
