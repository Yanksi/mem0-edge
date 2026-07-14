import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';

const dashboardService = vi.hoisted(() => ({
  listDashboardUsers: vi.fn(),
  setDashboardUserAlias: vi.fn(),
  listDashboardMemories: vi.fn(),
  getDashboardDeduplicationSummary: vi.fn(),
  listDashboardDuplicateMemoryIds: vi.fn(),
  listDashboardSoftDeletedMemoryIds: vi.fn(),
  softDeleteDashboardMemories: vi.fn(),
}));
const vectorize = vi.hoisted(() => ({
  deleteVectors: vi.fn(),
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
vi.mock('../src/vectorize', () => vectorize);
vi.mock('../src/graph/service', () => graphService);
vi.mock('../src/memory/service', () => memoryService);
vi.mock('../src/import/service', () => importService);

import worker from '../src/index';

const env = { DASHBOARD_PASSWORD: 'dashboard-secret', VECTORIZE: {} as VectorizeIndex } as Env;

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

  it('requires a signed dashboard session for deduplication endpoints', async () => {
    const getResponse = await worker.fetch(request('/dashboard/api/deduplication?entity_type=agent&entity_id=hermes'), env);
    const postResponse = await worker.fetch(request('/dashboard/api/deduplication', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_type: 'agent', entity_id: 'hermes', confirm: true }),
    }), env);

    expect(getResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
    expect(dashboardService.getDashboardDeduplicationSummary).not.toHaveBeenCalled();
    expect(dashboardService.listDashboardDuplicateMemoryIds).not.toHaveBeenCalled();
  });

  it('returns deduplication summaries for agent and user scopes', async () => {
    dashboardService.getDashboardDeduplicationSummary
      .mockResolvedValueOnce({ duplicate_groups: 1, removable_memories: 2, previews: [{ memory: 'Agent memory', duplicate_count: 2 }] })
      .mockResolvedValueOnce({ duplicate_groups: 1, removable_memories: 1, previews: [{ memory: 'User memory', duplicate_count: 1 }] });
    const cookie = await dashboardCookie();

    const agentResponse = await worker.fetch(request('/dashboard/api/deduplication?entity_type=agent&entity_id=hermes', {
      headers: { Cookie: cookie },
    }), env);
    const userResponse = await worker.fetch(request('/dashboard/api/deduplication?entity_type=user&entity_id=discord%3A42', {
      headers: { Cookie: cookie },
    }), env);

    await expect(agentResponse.json()).resolves.toEqual({
      duplicate_groups: 1, removable_memories: 2, previews: [{ memory: 'Agent memory', duplicate_count: 2 }],
    });
    await expect(userResponse.json()).resolves.toEqual({
      duplicate_groups: 1, removable_memories: 1, previews: [{ memory: 'User memory', duplicate_count: 1 }],
    });
    expect(dashboardService.getDashboardDeduplicationSummary).toHaveBeenNthCalledWith(1, env, 'agent', 'hermes');
    expect(dashboardService.getDashboardDeduplicationSummary).toHaveBeenNthCalledWith(2, env, 'user', 'discord:42');
  });

  it('rejects invalid deduplication scopes and confirmations', async () => {
    const headers = { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' };
    const missingGetScope = await worker.fetch(request('/dashboard/api/deduplication?entity_type=agent', { headers }), env);
    const invalidGetScope = await worker.fetch(request('/dashboard/api/deduplication?entity_type=run&entity_id=run-1', { headers }), env);
    const missingPostScope = await worker.fetch(request('/dashboard/api/deduplication', {
      method: 'POST', headers, body: JSON.stringify({ entity_type: 'agent', confirm: true }),
    }), env);
    const invalidConfirmation = await worker.fetch(request('/dashboard/api/deduplication', {
      method: 'POST', headers, body: JSON.stringify({ entity_type: 'user', entity_id: 'discord:42', confirm: 'true' }),
    }), env);
    const missingConfirmation = await worker.fetch(request('/dashboard/api/deduplication', {
      method: 'POST', headers, body: JSON.stringify({ entity_type: 'user', entity_id: 'discord:42' }),
    }), env);

    expect(missingGetScope.status).toBe(400);
    expect(invalidGetScope.status).toBe(400);
    expect(missingPostScope.status).toBe(400);
    expect(invalidConfirmation.status).toBe(400);
    expect(missingConfirmation.status).toBe(400);
    expect(dashboardService.getDashboardDeduplicationSummary).not.toHaveBeenCalled();
    expect(dashboardService.listDashboardDuplicateMemoryIds).not.toHaveBeenCalled();
  });

  it('deletes D1-confirmed agent duplicate vectors and only returns the removal count', async () => {
    dashboardService.listDashboardDuplicateMemoryIds.mockResolvedValue(['stale-memory', 'memory-2']);
    dashboardService.softDeleteDashboardMemories.mockResolvedValue(['memory-2']);
    dashboardService.listDashboardSoftDeletedMemoryIds.mockResolvedValue(['memory-2', 'previously-deleted']);
    vectorize.deleteVectors.mockResolvedValue(undefined);

    const response = await worker.fetch(request('/dashboard/api/deduplication', {
      method: 'POST',
      headers: { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_type: 'agent', entity_id: 'hermes', confirm: true }),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ removed: 1 });
    expect(dashboardService.listDashboardDuplicateMemoryIds).toHaveBeenCalledWith(env, 'agent', 'hermes');
    expect(dashboardService.softDeleteDashboardMemories).toHaveBeenCalledWith(env, 'agent', 'hermes', ['stale-memory', 'memory-2']);
    expect(dashboardService.listDashboardSoftDeletedMemoryIds).toHaveBeenCalledWith(env, 'agent', 'hermes');
    expect(vectorize.deleteVectors).toHaveBeenCalledWith(env.VECTORIZE, ['memory-2', 'previously-deleted']);
    expect(dashboardService.listDashboardDuplicateMemoryIds.mock.invocationCallOrder[0])
      .toBeLessThan(dashboardService.softDeleteDashboardMemories.mock.invocationCallOrder[0]);
    expect(dashboardService.softDeleteDashboardMemories.mock.invocationCallOrder[0])
      .toBeLessThan(vectorize.deleteVectors.mock.invocationCallOrder[0]);
  });

  it('waits for D1 duplicate deletion before deleting vectors', async () => {
    let resolveMemoryDeletion: ((ids: string[]) => void) | undefined;
    dashboardService.listDashboardDuplicateMemoryIds.mockResolvedValue(['memory-2']);
    dashboardService.softDeleteDashboardMemories.mockImplementation(() => new Promise<string[]>((resolve) => {
      resolveMemoryDeletion = resolve;
    }));
    dashboardService.listDashboardSoftDeletedMemoryIds.mockResolvedValue([]);
    vectorize.deleteVectors.mockResolvedValue(undefined);

    const responsePromise = worker.fetch(request('/dashboard/api/deduplication', {
      method: 'POST',
      headers: { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_type: 'agent', entity_id: 'hermes', confirm: true }),
    }), env);

    await vi.waitFor(() => expect(dashboardService.softDeleteDashboardMemories).toHaveBeenCalledTimes(1));
    expect(vectorize.deleteVectors).not.toHaveBeenCalled();

    resolveMemoryDeletion!(['memory-2']);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(vectorize.deleteVectors).toHaveBeenCalledWith(env.VECTORIZE, ['memory-2']);
  });

  it('does not delete vectors when D1 confirms no duplicate deletions', async () => {
    dashboardService.listDashboardDuplicateMemoryIds.mockResolvedValue(['stale-memory']);
    dashboardService.softDeleteDashboardMemories.mockResolvedValue([]);
    dashboardService.listDashboardSoftDeletedMemoryIds.mockResolvedValue([]);

    const response = await worker.fetch(request('/dashboard/api/deduplication', {
      method: 'POST',
      headers: { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_type: 'agent', entity_id: 'hermes', confirm: true }),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ removed: 0 });
    expect(dashboardService.softDeleteDashboardMemories).toHaveBeenCalledWith(env, 'agent', 'hermes', ['stale-memory']);
    expect(vectorize.deleteVectors).not.toHaveBeenCalled();
  });

  it('checks soft-deleted IDs after a user scope has no duplicate candidates', async () => {
    dashboardService.listDashboardDuplicateMemoryIds.mockResolvedValue([]);
    dashboardService.softDeleteDashboardMemories.mockResolvedValue([]);
    dashboardService.listDashboardSoftDeletedMemoryIds.mockResolvedValue([]);

    const response = await worker.fetch(request('/dashboard/api/deduplication', {
      method: 'POST',
      headers: { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_type: 'user', entity_id: 'discord:42', confirm: true }),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ removed: 0 });
    expect(dashboardService.listDashboardDuplicateMemoryIds).toHaveBeenCalledWith(env, 'user', 'discord:42');
    expect(dashboardService.softDeleteDashboardMemories).toHaveBeenCalledWith(env, 'user', 'discord:42', []);
    expect(dashboardService.listDashboardSoftDeletedMemoryIds).toHaveBeenCalledWith(env, 'user', 'discord:42');
    expect(vectorize.deleteVectors).not.toHaveBeenCalled();
  });

  it('retries failed agent vector cleanup using scoped soft-deleted memory IDs', async () => {
    dashboardService.listDashboardDuplicateMemoryIds.mockResolvedValue([]);
    dashboardService.softDeleteDashboardMemories.mockResolvedValue([]);
    dashboardService.listDashboardSoftDeletedMemoryIds.mockResolvedValue(['retry-memory']);
    vectorize.deleteVectors.mockResolvedValue(undefined);

    const response = await worker.fetch(request('/dashboard/api/deduplication', {
      method: 'POST',
      headers: { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_type: 'agent', entity_id: 'hermes', confirm: true }),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ removed: 0 });
    expect(dashboardService.softDeleteDashboardMemories).toHaveBeenCalledWith(env, 'agent', 'hermes', []);
    expect(dashboardService.listDashboardSoftDeletedMemoryIds).toHaveBeenCalledWith(env, 'agent', 'hermes');
    expect(vectorize.deleteVectors).toHaveBeenCalledWith(env.VECTORIZE, ['retry-memory']);
  });

  it('recovers a failed vector cleanup without exposing internal IDs', async () => {
    dashboardService.listDashboardDuplicateMemoryIds
      .mockResolvedValueOnce(['retry-memory'])
      .mockResolvedValueOnce([]);
    dashboardService.softDeleteDashboardMemories
      .mockResolvedValueOnce(['retry-memory'])
      .mockResolvedValueOnce([]);
    dashboardService.listDashboardSoftDeletedMemoryIds
      .mockResolvedValueOnce(['retry-memory'])
      .mockResolvedValueOnce(['retry-memory']);
    vectorize.deleteVectors
      .mockRejectedValueOnce(new Error('Vectorize cleanup failed for retry-memory'))
      .mockResolvedValueOnce(undefined);
    const headers = { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' };
    const body = JSON.stringify({ entity_type: 'agent', entity_id: 'hermes', confirm: true });

    const failedResponse = await worker.fetch(request('/dashboard/api/deduplication', {
      method: 'POST', headers, body,
    }), env);

    expect(failedResponse.status).toBe(500);
    const failedBody = await failedResponse.text();
    expect(failedBody).not.toContain('retry-memory');
    expect(failedBody).not.toContain('Vectorize');
    expect(dashboardService.softDeleteDashboardMemories).toHaveBeenNthCalledWith(1, env, 'agent', 'hermes', ['retry-memory']);
    expect(dashboardService.listDashboardSoftDeletedMemoryIds).toHaveBeenNthCalledWith(1, env, 'agent', 'hermes');

    const recoveredResponse = await worker.fetch(request('/dashboard/api/deduplication', {
      method: 'POST', headers, body,
    }), env);

    expect(recoveredResponse.status).toBe(200);
    await expect(recoveredResponse.json()).resolves.toEqual({ removed: 0 });
    expect(dashboardService.softDeleteDashboardMemories).toHaveBeenNthCalledWith(2, env, 'agent', 'hermes', []);
    expect(dashboardService.listDashboardSoftDeletedMemoryIds).toHaveBeenNthCalledWith(2, env, 'agent', 'hermes');
    expect(vectorize.deleteVectors).toHaveBeenNthCalledWith(2, env.VECTORIZE, ['retry-memory']);
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
