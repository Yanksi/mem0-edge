import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { memories } from '../src/db/schema';
import {
  contentHash,
  memoryVectorMetadata,
  ownerPredicate,
  scopeKey,
  vectorStateHash,
  type MemoryOwnerScope,
} from '../src/memory/identity';

describe('memory identity', () => {
  it('hashes the exact final content as lowercase SHA-256', async () => {
    await expect(contentHash(' Zurich ')).resolves.toBe(
      'ac969750a69dddad842d0782b0db9c43b0f22caae53cfb80d619fbc7b99c24eb',
    );
    await expect(contentHash('Zurich')).resolves.toBe(
      '1e73b1647343b286269d517e6f07e6e07ccef10cd7b785e4e14e42237263614b',
    );
    await expect(contentHash(' Zurich ')).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it('distinguishes user-only, agent-only, and paired owner scopes', async () => {
    const keys = await Promise.all([
      scopeKey({ userId: 'user-1', agentId: null }),
      scopeKey({ userId: null, agentId: 'agent-1' }),
      scopeKey({ userId: 'user-1', agentId: 'agent-1' }),
      scopeKey({ userId: 'user-1', agentId: 'agent-2' }),
    ]);

    expect(new Set(keys).size).toBe(4);
    expect(keys).toEqual(keys.map((key) => expect.stringMatching(/^[a-f0-9]{64}$/)));
  });

  it.each([
    [{ userId: 'user-1', agentId: null }, ['user-1'], '"user_id" = ? and "memories"."agent_id" is null'],
    [{ userId: null, agentId: 'agent-1' }, ['agent-1'], '"user_id" is null and "memories"."agent_id" = ?'],
    [{ userId: 'user-1', agentId: 'agent-1' }, ['user-1', 'agent-1'], '"user_id" = ? and "memories"."agent_id" = ?'],
    [{ userId: null, agentId: null }, [], '"user_id" is null and "memories"."agent_id" is null'],
  ] as const)('matches both owner positions for scope %o', (scope, params, whereSql) => {
    const query = createDb({} as D1Database)
      .select({ id: memories.id })
      .from(memories)
      .where(ownerPredicate(scope))
      .toSQL();

    expect(query.sql).toContain(whereSql);
    expect(query.params).toEqual(params);
  });

  it('keeps scalar metadata and overwrites identity fields with non-null row values', async () => {
    const row = {
      userId: 'user-1',
      agentId: 'agent-1',
      runId: 'run-1',
      actorId: null,
      contentHash: 'content-digest',
      metadataJson: JSON.stringify({
        label: 'travel',
        score: 0.75,
        pinned: false,
        ignoredNull: null,
        ignoredArray: ['nested'],
        ignoredObject: { nested: true },
        user_id: 'spoofed-user',
        scope_key: 'spoofed-scope',
        content_hash: 'spoofed-content-digest',
        memory_vector_schema: 'spoofed-schema',
        vector_state_hash: 'spoofed-state',
      }),
    };

    await expect(memoryVectorMetadata(row)).resolves.toEqual({
      label: 'travel',
      score: 0.75,
      pinned: false,
      user_id: 'user-1',
      agent_id: 'agent-1',
      run_id: 'run-1',
      scope_key: await scopeKey(row),
      content_hash: 'content-digest',
      memory_vector_schema: '1',
      vector_state_hash: await vectorStateHash(row),
    });
  });

  it('hashes the exact full vector source tuple and changes for metadata, run, or actor drift', async () => {
    const row = {
      userId: 'user-1',
      agentId: 'agent-1',
      runId: 'run-1',
      actorId: 'actor-1',
      metadataJson: '{"b":2,"a":1}',
      contentHash: 'content-digest',
    };

    await expect(vectorStateHash(row)).resolves.toBe(
      await sha256Tuple([
        row.userId,
        row.agentId,
        row.runId,
        row.actorId,
        row.metadataJson,
        row.contentHash,
      ]),
    );
    await expect(Promise.all([
      vectorStateHash(row),
      vectorStateHash({ ...row, metadataJson: '{"a":1,"b":2}' }),
      vectorStateHash({ ...row, runId: 'run-2' }),
      vectorStateHash({ ...row, actorId: 'actor-2' }),
    ])).resolves.toSatisfy((hashes: string[]) => new Set(hashes).size === 4);
  });

  it.each(['not-json', '[]', 'null'])('safely ignores non-object metadata JSON %s', async (metadataJson) => {
    const scope: MemoryOwnerScope = { userId: null, agentId: 'agent-1' };

    await expect(memoryVectorMetadata({
      ...scope,
      runId: null,
      actorId: null,
      contentHash: 'content-digest',
      metadataJson,
    })).resolves.toEqual({
      agent_id: 'agent-1',
      scope_key: await scopeKey(scope),
      content_hash: 'content-digest',
      memory_vector_schema: '1',
      vector_state_hash: await vectorStateHash({
        ...scope,
        runId: null,
        actorId: null,
        contentHash: 'content-digest',
        metadataJson,
      }),
    });
  });

  it('removes reserved identity metadata when every authoritative owner column is null', async () => {
    const row = {
      userId: null,
      agentId: null,
      runId: null,
      actorId: null,
      contentHash: 'content-digest',
      metadataJson: JSON.stringify({
        label: 'kept',
        user_id: 'spoofed-user',
        agent_id: 'spoofed-agent',
        run_id: 'spoofed-run',
        actor_id: 'spoofed-actor',
        scope_key: 'spoofed-scope',
        content_hash: 'spoofed-content-digest',
        memory_vector_schema: 'spoofed-schema',
        vector_state_hash: 'spoofed-state',
      }),
    };

    await expect(memoryVectorMetadata(row)).resolves.toEqual({
      label: 'kept',
      scope_key: await scopeKey(row),
      content_hash: 'content-digest',
      memory_vector_schema: '1',
      vector_state_hash: await vectorStateHash(row),
    });
  });
});

async function sha256Tuple(tuple: unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(tuple));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
