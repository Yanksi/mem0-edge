import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';

const dashboardService = vi.hoisted(() => ({
  listDashboardUsers: vi.fn(),
  setDashboardUserAlias: vi.fn(),
  listDashboardMemories: vi.fn(),
  getDashboardSettings: vi.fn(),
  setDashboardSettings: vi.fn(),
  reindexDashboardMemory: vi.fn(),
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
  enqueueMem0AgentReclassification: vi.fn(),
}));

vi.mock('../src/dashboard/service', () => dashboardService);
vi.mock('../src/graph/service', () => graphService);
vi.mock('../src/memory/service', () => memoryService);
vi.mock('../src/import/service', () => importService);

import worker from '../src/index';
import { DedupLlmConfigurationError } from '../src/settings/service';

const env = { DASHBOARD_PASSWORD: 'dashboard-secret', VECTORIZE: {} as VectorizeIndex } as Env;
const readOnlyEnv = { ...env, DASHBOARD_READ_ONLY: 'true' } as Env;

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://example.com${path}`, init);
}

async function dashboardCookie(targetEnv: Env = env): Promise<string> {
  const response = await worker.fetch(request('/dashboard/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=dashboard-secret',
  }), targetEnv);
  return response.headers.get('Set-Cookie')!.split(';', 1)[0];
}

describe('dashboard operator API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks authenticated dashboard mutations in the remote read-only preview before parsing request bodies', async () => {
    const headers = { Cookie: await dashboardCookie(readOnlyEnv), 'Content-Type': 'application/json' };
    const responses = await Promise.all([
      worker.fetch(request('/dashboard/api/users/discord%3A42/alias', { method: 'PUT', headers, body: 'not-json' }), readOnlyEnv),
      worker.fetch(request('/dashboard/api/settings', { method: 'PUT', headers, body: 'not-json' }), readOnlyEnv),
      worker.fetch(request('/dashboard/api/imports/mem0', { method: 'POST', headers, body: 'not-json' }), readOnlyEnv),
      worker.fetch(request('/dashboard/api/entities/reclassify-agent', { method: 'POST', headers, body: 'not-json' }), readOnlyEnv),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'Dashboard is read-only in this preview' });
    }
    expect(dashboardService.setDashboardUserAlias).not.toHaveBeenCalled();
    expect(dashboardService.setDashboardSettings).not.toHaveBeenCalled();
    expect(importService.enqueueMem0Import).not.toHaveBeenCalled();
    expect(importService.enqueueMem0AgentReclassification).not.toHaveBeenCalled();
  });

  it('requires a signed dashboard session', async () => {
    const response = await worker.fetch(request('/dashboard/api/users'), env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(dashboardService.listDashboardUsers).not.toHaveBeenCalled();
  });

  it('requires a signed dashboard session for settings endpoints', async () => {
    const getResponse = await worker.fetch(request('/dashboard/api/settings'), env);
    const putResponse = await worker.fetch(request('/dashboard/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ semantic_dedup_enabled: true }),
    }), env);

    expect(getResponse.status).toBe(401);
    expect(putResponse.status).toBe(401);
    expect(dashboardService.getDashboardSettings).not.toHaveBeenCalled();
    expect(dashboardService.setDashboardSettings).not.toHaveBeenCalled();
  });

  it('returns only the current semantic deduplication setting', async () => {
    dashboardService.getDashboardSettings.mockResolvedValue({
      semantic_dedup_enabled: true,
      model: 'must-not-leak',
      threshold: 0.8,
    });

    const response = await worker.fetch(request('/dashboard/api/settings', {
      headers: { Cookie: await dashboardCookie() },
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ semantic_dedup_enabled: true });
    expect(dashboardService.getDashboardSettings).toHaveBeenCalledWith(env);
  });

  it('accepts only a JSON boolean semantic_dedup_enabled setting', async () => {
    const headers = { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' };
    const bodies = [
      'not-json',
      '{}',
      'true',
      JSON.stringify({ semantic_dedup_enabled: 'true' }),
      JSON.stringify({ semantic_dedup_enabled: true, model: 'secret' }),
    ];

    for (const body of bodies) {
      const response = await worker.fetch(request('/dashboard/api/settings', { method: 'PUT', headers, body }), env);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Validation failed' });
    }
    expect(dashboardService.setDashboardSettings).not.toHaveBeenCalled();
  });

  it('updates and returns only the semantic deduplication setting', async () => {
    dashboardService.setDashboardSettings.mockResolvedValue({ semantic_dedup_enabled: true, model: 'must-not-leak' });

    const response = await worker.fetch(request('/dashboard/api/settings', {
      method: 'PUT',
      headers: { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ semantic_dedup_enabled: true }),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ semantic_dedup_enabled: true });
    expect(dashboardService.setDashboardSettings).toHaveBeenCalledWith(env, true);
  });

  it('maps missing semantic deduplication configuration to a conflict', async () => {
    dashboardService.setDashboardSettings.mockRejectedValue(new DedupLlmConfigurationError(['DEDUP_LLM_API_KEY']));

    const response = await worker.fetch(request('/dashboard/api/settings', {
      method: 'PUT',
      headers: { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ semantic_dedup_enabled: true }),
    }), env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Semantic deduplication is not configured' });
  });

  it('allows disabling semantic deduplication when dedicated configuration is absent', async () => {
    dashboardService.setDashboardSettings.mockResolvedValue({ semantic_dedup_enabled: false });

    const response = await worker.fetch(request('/dashboard/api/settings', {
      method: 'PUT',
      headers: { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ semantic_dedup_enabled: false }),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ semantic_dedup_enabled: false });
    expect(dashboardService.setDashboardSettings).toHaveBeenCalledWith(env, false);
  });

  it('propagates unexpected settings service errors', async () => {
    dashboardService.setDashboardSettings.mockRejectedValue(new Error('D1 unavailable'));

    const response = await worker.fetch(request('/dashboard/api/settings', {
      method: 'PUT',
      headers: { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ semantic_dedup_enabled: false }),
    }), env);

    expect(response.status).toBe(500);
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
    expect(dashboardService.listDashboardMemories).toHaveBeenCalledWith(env, 'user', 'discord:42', 50);
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
      body: JSON.stringify({ entity_type: 'user', entity_id: 'discord:42', export: exportPayload }),
    }), env);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ queued: 2 });
    expect(importService.enqueueMem0Import).toHaveBeenCalledWith(env, { entityType: 'user', entityId: 'discord:42' }, exportPayload);
  });

  it('accepts an agent-scoped Mem0 import', async () => {
    importService.enqueueMem0Import.mockResolvedValue(1);
    const exportPayload = { memories: [{ memory: 'Hermes is an agent.' }] };

    const response = await worker.fetch(request('/dashboard/api/imports/mem0', {
      method: 'POST',
      headers: { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_type: 'agent', entity_id: 'hermes', export: exportPayload }),
    }), env);

    expect(response.status).toBe(202);
    expect(importService.enqueueMem0Import).toHaveBeenCalledWith(env, {
      entityType: 'agent', entityId: 'hermes',
    }, exportPayload);
  });

  it('reindexes one authenticated agent memory without changing its scope', async () => {
    dashboardService.reindexDashboardMemory.mockResolvedValue(true);

    const response = await worker.fetch(request('/dashboard/api/memories/memory-1/reindex', {
      method: 'POST',
      headers: { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_type: 'agent', entity_id: 'hermes' }),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(dashboardService.reindexDashboardMemory).toHaveBeenCalledWith(env, 'agent', 'hermes', 'memory-1');
  });

  it('queues an authenticated agent reclassification from query parameters', async () => {
    importService.enqueueMem0AgentReclassification.mockResolvedValue(129);

    const response = await worker.fetch(request('/dashboard/api/entities/reclassify-agent?source_user_id=hermes&agent_id=hermes', {
      method: 'POST', headers: { Cookie: await dashboardCookie() },
    }), env);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ queued: 129 });
    expect(importService.enqueueMem0AgentReclassification).toHaveBeenCalledWith(env, 'hermes', 'hermes');
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
