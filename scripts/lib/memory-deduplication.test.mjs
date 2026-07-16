import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  contentHash,
  duplicateMappings,
  pendingHashUpdates,
  scopeKey,
  sha256Hex,
} from './memory-deduplication.mjs';
import {
  USAGE,
  applyHashUpdates,
  cleanupDuplicate,
  createCloudflareClient,
  deleteVectorIds,
  listCloudflareAccounts,
  loginDashboard,
  main,
  normalizeBaseUrl,
  pageAllMemories,
  parseArguments,
  parseWranglerConfig,
  reindexActiveMemories,
  resolveAccountId,
  validateEnvironment,
  verifyMemoryState,
} from '../migrate-memory-deduplication.mjs';

test('sha256Hex returns a lowercase SHA-256 digest', async () => {
  assert.equal(
    await sha256Hex('Hello'),
    '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
  );
});

test('contentHash preserves raw whitespace and case', async () => {
  const variants = ['Memory', 'memory', ' Memory', 'Memory ', 'Memory\n'];
  const digests = await Promise.all(variants.map(contentHash));

  assert.equal(new Set(digests).size, variants.length);
  assert.equal(digests[0], await sha256Hex('Memory'));
});

test('scopeKey distinguishes every null and value owner combination', async () => {
  const owners = [
    { user_id: null, agent_id: null },
    { user_id: 'owner', agent_id: null },
    { user_id: null, agent_id: 'owner' },
    { user_id: 'owner', agent_id: 'owner' },
  ];

  const actual = await Promise.all(owners.map(scopeKey));
  const expected = await Promise.all(owners.map((row) => (
    sha256Hex(JSON.stringify([row.user_id, row.agent_id]))
  )));

  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, owners.length);
});

test('duplicateMappings separates owner scopes and ignores deleted rows', () => {
  const base = { content: 'same', content_hash: 'digest', created_at: 1, deleted_at: null };
  const rows = [
    { ...base, id: 'none-a', user_id: null, agent_id: null },
    { ...base, id: 'none-b', user_id: null, agent_id: null, created_at: 2 },
    { ...base, id: 'user-a', user_id: 'owner', agent_id: null },
    { ...base, id: 'user-b', user_id: 'owner', agent_id: null, created_at: 2 },
    { ...base, id: 'agent-a', user_id: null, agent_id: 'owner' },
    { ...base, id: 'agent-b', user_id: null, agent_id: 'owner', created_at: 2 },
    { ...base, id: 'pair-a', user_id: 'owner', agent_id: 'owner' },
    { ...base, id: 'pair-b', user_id: 'owner', agent_id: 'owner', created_at: 2 },
    { ...base, id: 'deleted', user_id: 'owner', agent_id: null, created_at: 0, deleted_at: 10 },
  ];

  assert.deepEqual(duplicateMappings(rows), [
    { canonicalId: 'none-a', loserId: 'none-b' },
    { canonicalId: 'user-a', loserId: 'user-b' },
    { canonicalId: 'agent-a', loserId: 'agent-b' },
    { canonicalId: 'pair-a', loserId: 'pair-b' },
  ]);
});

test('duplicateMappings guards hash collisions with exact raw content', () => {
  const rows = [
    { id: 'a', user_id: 'u', agent_id: null, content: 'Raw', content_hash: 'collision', created_at: 1, deleted_at: null },
    { id: 'b', user_id: 'u', agent_id: null, content: 'raw', content_hash: 'collision', created_at: 2, deleted_at: null },
    { id: 'c', user_id: 'u', agent_id: null, content: 'Raw', content_hash: 'collision', created_at: 3, deleted_at: null },
  ];

  assert.deepEqual(duplicateMappings(rows), [{ canonicalId: 'a', loserId: 'c' }]);
});

test('duplicateMappings chooses created_at then id and maps every loser to the canonical row', () => {
  const rows = ['z', 'b', 'a'].map((id) => ({
    id,
    user_id: 'u',
    agent_id: 'a',
    content: 'same',
    content_hash: 'digest',
    created_at: id === 'z' ? 2 : 1,
    deleted_at: null,
  }));

  assert.deepEqual(duplicateMappings(rows), [
    { canonicalId: 'a', loserId: 'b' },
    { canonicalId: 'a', loserId: 'z' },
  ]);
});

test('duplicateMappings uses exact ascending ID order instead of locale collation', () => {
  const rows = ['a', 'A'].map((id) => ({
    id,
    user_id: 'u',
    agent_id: null,
    content: 'same',
    content_hash: 'digest',
    created_at: 1,
    deleted_at: null,
  }));

  assert.deepEqual(duplicateMappings(rows), [
    { canonicalId: 'A', loserId: 'a' },
  ]);
});

test('pendingHashUpdates hashes exact content for active and deleted rows and is idempotent', async () => {
  const rows = [
    { id: 'raw', content: ' Keep CASE and space ', content_hash: null, deleted_at: null },
    { id: 'deleted', content: 'Deleted content', content_hash: 'wrong', deleted_at: 100 },
    {
      id: 'correct',
      content: 'Already correct',
      content_hash: await contentHash('Already correct'),
      deleted_at: null,
    },
  ];

  const updates = await pendingHashUpdates(rows);
  assert.deepEqual(updates, [
    { id: 'raw', contentHash: await contentHash(' Keep CASE and space ') },
    { id: 'deleted', contentHash: await contentHash('Deleted content') },
  ]);

  const updatedRows = rows.map((row) => {
    const update = updates.find(({ id }) => id === row.id);
    return update === undefined ? row : { ...row, content_hash: update.contentHash };
  });
  assert.deepEqual(await pendingHashUpdates(updatedRows), []);
});

test('a deleted null hash is backfilled before verify can succeed', async () => {
  const row = {
    id: 'deleted-null-hash',
    user_id: 'retired-user',
    agent_id: null,
    content: 'retired content',
    content_hash: null,
    created_at: 1,
    deleted_at: 50,
  };
  const getVectors = async () => [];
  const before = await verifyMemoryState({ rows: [row], getVectors });
  assert.equal(before.ok, false);
  assert.equal(before.report.hash_issue_count, 1);
  assert.deepEqual(before.report.null_hash_ids, ['deleted-null-hash']);

  const updates = await pendingHashUpdates([row]);
  assert.deepEqual(updates, [{
    id: 'deleted-null-hash',
    contentHash: await contentHash(row.content),
  }]);
  await applyHashUpdates({
    rows: [row],
    updates,
    queryD1: async (body) => {
      assert.deepEqual(body.batch[0].params, [
        updates[0].contentHash,
        row.id,
        row.content,
        updates[0].contentHash,
      ]);
      row.content_hash = body.batch[0].params[0];
      return successfulD1Result([], 1);
    },
  });

  const after = await verifyMemoryState({ rows: [row], getVectors });
  assert.equal(after.ok, true);
  assert.equal(after.report.hash_issue_count, 0);
  assert.deepEqual(after.report.null_hash_ids, []);
});

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function successfulD1Result(results = [], changes = 0) {
  return [{ success: true, results, meta: { changes } }];
}

async function createStatefulMaintenanceFake(failurePhase) {
  const rows = [
    {
      id: 'canonical',
      user_id: 'user-1',
      agent_id: null,
      content: 'same',
      content_hash: null,
      created_at: 1,
      deleted_at: null,
    },
    {
      id: 'loser',
      user_id: 'user-1',
      agent_id: null,
      content: 'same',
      content_hash: null,
      created_at: 2,
      deleted_at: null,
    },
    {
      id: 'other',
      user_id: null,
      agent_id: 'agent-1',
      content: 'other',
      content_hash: null,
      created_at: 3,
      deleted_at: null,
    },
    {
      id: 'unrelated-deleted',
      user_id: 'retired-user',
      agent_id: null,
      content: 'retired',
      content_hash: await contentHash('retired'),
      created_at: 4,
      deleted_at: 50,
    },
  ];
  const vectors = new Map(rows.map((row) => [
    row.id,
    { id: row.id, metadata: { scope_key: 'stale' } },
  ]));
  const stats = {
    hashCommits: 0,
    cleanupCommits: 0,
    vectorDeleteSubmissions: [],
    reindexSuccesses: [],
  };
  let pendingFailure = failurePhase;
  let loginCount = 0;
  let reindexAttemptCount = 0;

  const failOnce = (phase) => {
    if (pendingFailure !== phase) return;
    pendingFailure = undefined;
    throw new Error(`injected ${phase}`);
  };

  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/d1/database/')) {
      const body = JSON.parse(init.body);
      if (body.sql !== undefined) {
        return jsonResponse({ success: true, result: successfulD1Result(rows) });
      }

      if (body.batch?.[0]?.sql.includes('SET content_hash')) {
        for (const statement of body.batch) {
          const [hash, id, content] = statement.params;
          const row = rows.find((candidate) => candidate.id === id);
          if (row?.content === content && row.content_hash !== hash) row.content_hash = hash;
        }
        stats.hashCommits += 1;
        failOnce('after-hash-commit');
        return jsonResponse({
          success: true,
          result: body.batch.map(() => ({ success: true, results: [], meta: { changes: 1 } })),
        });
      }

      if (body.batch?.[2]?.sql.includes('SET deleted_at = unixepoch()')) {
        const [loserId, canonicalId] = body.batch[2].params;
        const loser = rows.find((row) => row.id === loserId);
        const canonical = rows.find((row) => row.id === canonicalId);
        const decisive = loser?.deleted_at === null
          && canonical?.deleted_at === null
          && loser.user_id === canonical.user_id
          && loser.agent_id === canonical.agent_id
          && loser.content_hash === canonical.content_hash
          && loser.content === canonical.content;
        if (decisive) {
          loser.deleted_at = 100;
          stats.cleanupCommits += 1;
        }
        failOnce('after-d1-cleanup');
        return jsonResponse({
          success: true,
          result: [
            { success: true, results: [], meta: { changes: 0 } },
            { success: true, results: [], meta: { changes: 0 } },
            {
              success: true,
              results: decisive ? [{ id: loserId }] : [],
              meta: { changes: decisive ? 1 : 0 },
            },
          ],
        });
      }

      throw new Error('unexpected D1 request');
    }

    if (url.endsWith('/delete_by_ids')) {
      const { ids } = JSON.parse(init.body);
      stats.vectorDeleteSubmissions.push([...ids]);
      for (const id of ids) vectors.delete(id);
      failOnce('after-vector-deletion-submission');
      return jsonResponse({ success: true, result: { mutationId: 'mutation-1' } });
    }

    if (url.endsWith('/get_by_ids')) {
      const { ids } = JSON.parse(init.body);
      return jsonResponse({
        success: true,
        result: ids.flatMap((id) => vectors.has(id) ? [vectors.get(id)] : []),
      });
    }

    if (url.endsWith('/dashboard/login')) {
      loginCount += 1;
      return new Response(null, {
        status: 303,
        headers: { 'Set-Cookie': `session=session-${loginCount}; Path=/; HttpOnly; Secure` },
      });
    }

    const reindexMatch = url.match(/\/dashboard\/api\/memories\/([^/]+)\/reindex$/);
    if (reindexMatch !== null) {
      reindexAttemptCount += 1;
      if (pendingFailure === 'during-partial-reindex' && reindexAttemptCount === 2) {
        failOnce('during-partial-reindex');
      }
      const id = decodeURIComponent(reindexMatch[1]);
      const row = rows.find((candidate) => candidate.id === id);
      assert.ok(row);
      vectors.set(id, { id, metadata: { scope_key: await scopeKey(row) } });
      stats.reindexSuccesses.push(id);
      return jsonResponse({ ok: true });
    }

    throw new Error(`unexpected request: ${url}`);
  };

  return { rows, vectors, stats, fetchImpl };
}

function statefulMaintenanceOptions(fake, logs, errors) {
  return {
    env: {
      CLOUDFLARE_API_TOKEN: 'cloudflare-secret',
      CLOUDFLARE_ACCOUNT_ID: 'account-1',
      DASHBOARD_PASSWORD: 'dashboard-secret',
      MEM0_BASE_URL: 'https://mem0.example',
    },
    readFileImpl: async () => `
      [[d1_databases]]
      binding = "DB"
      database_id = "database-1"

      [[vectorize]]
      binding = "VECTORIZE"
      index_name = "memory-index"
    `,
    fetchImpl: fake.fetchImpl,
    logger: {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    },
  };
}

test('parseArguments accepts only the documented commands and confirmation flag', () => {
  assert.deepEqual(parseArguments(['inspect']), { command: 'inspect', confirm: false });
  assert.deepEqual(parseArguments(['apply', '--confirm']), { command: 'apply', confirm: true });
  assert.deepEqual(parseArguments(['verify']), { command: 'verify', confirm: false });
  assert.throws(() => parseArguments([]), new RegExp(USAGE.replaceAll('\n', '\\s+')));
  assert.throws(() => parseArguments(['remove']), /unknown command: remove/);
  assert.throws(() => parseArguments(['verify', '--confirm']), /unexpected arguments/);
});

test('the executable rejects apply without confirmation before environment access or network', () => {
  const script = fileURLToPath(new URL('../migrate-memory-deduplication.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, 'apply'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
    env: {},
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'apply requires --confirm');
});

test('the npm maintenance launcher reaches the confirmation guard without an env file', () => {
  const cwd = fileURLToPath(new URL('../..', import.meta.url));
  const packageJson = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  assert.equal(packageJson.engines.node, '>=22.9.0');

  const command = process.platform === 'win32'
    ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run maintenance:dedup -- apply']]
    : ['npm', ['run', 'maintenance:dedup', '--', 'apply']];
  const result = spawnSync(command[0], command[1], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });

  assert.notEqual(result.status, 0);
  const stderrLines = result.stderr.split(/\r?\n/).filter((line) => line !== '');
  assert.equal(stderrLines.at(-1), 'apply requires --confirm');
});

test('main returns nonzero for unconfirmed apply without reading config or fetching', async () => {
  const errors = [];
  let touchedRuntime = false;
  const exitCode = await main(['apply'], {
    env: {},
    readFileImpl: async () => {
      touchedRuntime = true;
      throw new Error('config should not be read');
    },
    fetchImpl: async () => {
      touchedRuntime = true;
      throw new Error('network should not be used');
    },
    logger: {
      log: assert.fail,
      error: (message) => errors.push(message),
    },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(errors, ['apply requires --confirm']);
  assert.equal(touchedRuntime, false);
});

test('parseWranglerConfig targets DB and exact VECTORIZE bindings', () => {
  const source = `
    [[d1_databases]]
    binding = "ARCHIVE_DB"
    database_id = "wrong-db"

    [[d1_databases]]
    binding = "DB"
    database_id = "right-db"

    [[vectorize]]
    binding = "ENTITY_VECTORIZE"
    index_name = "wrong-index"

    [[vectorize]]
    binding = "VECTORIZE"
    index_name = "right-index"
  `;

  assert.deepEqual(parseWranglerConfig(source), {
    databaseId: 'right-db',
    vectorizeIndexName: 'right-index',
  });
  assert.throws(
    () => parseWranglerConfig('[[vectorize]]\nbinding="ENTITY_VECTORIZE"\nindex_name="entities"'),
    /missing d1_databases binding "DB" database_id/,
  );
});

test('normalizeBaseUrl strips trailing slashes and rejects non-HTTP URLs', () => {
  assert.equal(normalizeBaseUrl('https://mem0.example///'), 'https://mem0.example');
  assert.equal(normalizeBaseUrl('http://localhost:8787/root/'), 'http://localhost:8787/root');
  assert.throws(() => normalizeBaseUrl('file:///tmp/mem0'), /must use http or https/);
});

test('validateEnvironment names missing variables without exposing values', () => {
  assert.throws(
    () => validateEnvironment({ CLOUDFLARE_API_TOKEN: 'present' }),
    /missing required environment variables: DASHBOARD_PASSWORD, MEM0_BASE_URL/,
  );
  assert.deepEqual(validateEnvironment({
    CLOUDFLARE_API_TOKEN: 'token',
    DASHBOARD_PASSWORD: 'password',
    MEM0_BASE_URL: 'https://mem0.example/',
  }), {
    token: 'token',
    dashboardPassword: 'password',
    mem0BaseUrl: 'https://mem0.example',
    accountId: undefined,
  });
});

test('Cloudflare client uses bearer auth, official Vectorize ID envelopes, and validates responses', async () => {
  const calls = [];
  const client = createCloudflareClient({
    token: 'secret-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/delete_by_ids')) {
        return jsonResponse({ success: true, result: { mutationId: 'mutation-1' } });
      }
      return jsonResponse({ success: true, result: [{ id: 'vector-1', metadata: {} }] });
    },
  });

  const vectors = await client.getVectors('account', 'main/index', ['vector-1']);
  const deletion = await client.deleteVectors('account', 'main/index', ['vector-1']);
  assert.deepEqual(vectors, [{ id: 'vector-1', metadata: {} }]);
  assert.deepEqual(deletion, { mutationId: 'mutation-1' });
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/account/vectorize/v2/indexes/main%2Findex/get_by_ids');
  assert.equal(calls[1].url, 'https://api.cloudflare.com/client/v4/accounts/account/vectorize/v2/indexes/main%2Findex/delete_by_ids');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-token');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer secret-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ids: ['vector-1'] });
  assert.deepEqual(JSON.parse(calls[1].init.body), { ids: ['vector-1'] });

  const failingClient = createCloudflareClient({
    token: 'secret-token',
    fetchImpl: async () => jsonResponse({
      success: false,
      errors: [{ code: 9999, message: 'rejected secret-token' }],
    }),
  });
  await assert.rejects(
    failingClient.getVectors('account', 'index', ['id']),
    (error) => error.message.includes('Cloudflare API reported failure')
      && error.message.includes('[redacted]')
      && !error.message.includes('secret-token'),
  );
});

test('Cloudflare D1 client rejects an unsuccessful nested query result', async () => {
  const client = createCloudflareClient({
    token: 'token',
    fetchImpl: async () => jsonResponse({
      success: true,
      result: [{ success: false, error: 'query failed' }],
    }),
  });

  await assert.rejects(
    client.queryD1('account', 'database', { sql: 'SELECT 1', params: [] }),
    /D1 query result 1 reported failure/,
  );
});

test('listCloudflareAccounts pages at the API maximum and account discovery is unambiguous', async () => {
  const calls = [];
  const firstPage = Array.from({ length: 50 }, (_, index) => ({ id: `account-${index}` }));
  const client = {
    async listAccounts(page, perPage) {
      calls.push({ page, perPage });
      return page === 1
        ? { accounts: firstPage, resultInfo: { total_pages: 2 } }
        : { accounts: [{ id: 'account-50' }], resultInfo: { total_pages: 2 } };
    },
  };

  assert.equal((await listCloudflareAccounts(client)).length, 51);
  assert.deepEqual(calls, [{ page: 1, perPage: 50 }, { page: 2, perPage: 50 }]);
  assert.equal(await resolveAccountId('explicit', { listAccounts: assert.fail }), 'explicit');
  await assert.rejects(resolveAccountId(undefined, client), /set CLOUDFLARE_ACCOUNT_ID explicitly/);
  assert.equal(await resolveAccountId(undefined, {
    listAccounts: async () => ({ accounts: [{ id: 'only' }], resultInfo: { total_pages: 1 } }),
  }), 'only');
});

test('pageAllMemories uses deterministic keyset pagination including deleted rows', async () => {
  const calls = [];
  const pages = [
    [
      { id: 'a', created_at: 1, deleted_at: null },
      { id: 'b', created_at: 1, deleted_at: 9 },
    ],
    [{ id: 'c', created_at: 2, deleted_at: null }],
  ];
  const rows = await pageAllMemories(async (body) => {
    calls.push(body);
    return successfulD1Result(pages.shift());
  }, 2);

  assert.deepEqual(rows.map(({ id }) => id), ['a', 'b', 'c']);
  assert.match(calls[0].sql, /ORDER BY created_at ASC, id ASC\s+LIMIT \?/i);
  assert.doesNotMatch(calls[0].sql, /deleted_at IS NULL/i);
  assert.deepEqual(calls[0].params, [2]);
  assert.match(calls[1].sql, /created_at > \? OR \(created_at = \? AND id > \?\)/i);
  assert.deepEqual(calls[1].params, [1, 1, 'b', 2]);
});

test('inspect is read-only and writes a deterministic backup without configured secrets', async () => {
  const fetchCalls = [];
  const writes = [];
  const logs = [];
  const exitCode = await main(['inspect'], {
    env: {
      CLOUDFLARE_API_TOKEN: 'cloudflare-secret',
      CLOUDFLARE_ACCOUNT_ID: 'account-1',
      DASHBOARD_PASSWORD: 'dashboard-secret',
      MEM0_BASE_URL: 'https://mem0.example',
    },
    readFileImpl: async () => `
      [[d1_databases]]
      binding = "DB"
      database_id = "database-1"

      [[vectorize]]
      binding = "VECTORIZE"
      index_name = "memory-index"
    `,
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return jsonResponse({
        success: true,
        result: successfulD1Result([
          {
            id: 'memory-1',
            user_id: 'user-1',
            agent_id: null,
            content: 'safe content',
            content_hash: await contentHash('safe content'),
            created_at: 1,
            deleted_at: null,
          },
          {
            id: 'memory-2',
            user_id: 'user-1',
            agent_id: null,
            content: 'safe content',
            content_hash: await contentHash('safe content'),
            created_at: 2,
            deleted_at: null,
          },
          {
            id: 'ownerless',
            user_id: null,
            agent_id: null,
            content: 'cannot reindex',
            content_hash: await contentHash('cannot reindex'),
            created_at: 3,
            deleted_at: null,
          },
        ]),
      });
    },
    mkdirImpl: async () => undefined,
    writeFileImpl: async (...args) => writes.push(args),
    now: () => new Date('2026-07-16T12:34:56.000Z'),
    logger: { log: (message) => logs.push(message), error: assert.fail },
  });

  assert.equal(exitCode, 0);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /\/d1\/database\/database-1\/query$/);
  assert.match(JSON.parse(fetchCalls[0].init.body).sql, /ORDER BY created_at ASC, id ASC/i);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], join('backups', 'memory-deduplication-2026-07-16T12-34-56.000Z.json'));
  assert.deepEqual(writes[0][2], { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  assert.doesNotMatch(writes[0][1], /cloudflare-secret|dashboard-secret/);
  const backup = JSON.parse(writes[0][1]);
  assert.deepEqual(backup.report.active_duplicate_loser_ids, ['memory-2']);
  assert.equal(backup.report.active_duplicate_loser_count, 1);
  assert.deepEqual(backup.report.unreindexable_active_memory_ids, ['ownerless']);
  assert.equal(backup.report.unreindexable_active_memory_count, 1);
  assert.match(logs[0], /"command": "inspect"/);
  assert.doesNotMatch(logs[0], /cloudflare-secret|dashboard-secret/);
});

test('inspect never retries or overwrites an existing backup path', async () => {
  let writeAttempts = 0;
  const errors = [];
  const exitCode = await main(['inspect'], {
    env: {
      CLOUDFLARE_API_TOKEN: 'cloudflare-secret',
      CLOUDFLARE_ACCOUNT_ID: 'account-1',
      DASHBOARD_PASSWORD: 'dashboard-secret',
      MEM0_BASE_URL: 'https://mem0.example',
    },
    readFileImpl: async () => `
      [[d1_databases]]
      binding = "DB"
      database_id = "database-1"

      [[vectorize]]
      binding = "VECTORIZE"
      index_name = "memory-index"
    `,
    fetchImpl: async () => jsonResponse({
      success: true,
      result: successfulD1Result([]),
    }),
    mkdirImpl: async () => undefined,
    writeFileImpl: async () => {
      writeAttempts += 1;
      const error = new Error('backup already exists');
      error.code = 'EEXIST';
      throw error;
    },
    now: () => new Date('2026-07-16T12:34:56.000Z'),
    logger: { log: assert.fail, error: (message) => errors.push(message) },
  });

  assert.equal(exitCode, 1);
  assert.equal(writeAttempts, 1);
  assert.deepEqual(errors, ['backup already exists']);
});

test('apply preflight rejects unreindexable active memories before auth or mutation', async () => {
  const calls = [];
  const errors = [];
  const exitCode = await main(['apply', '--confirm'], {
    env: {
      CLOUDFLARE_API_TOKEN: 'cloudflare-secret',
      CLOUDFLARE_ACCOUNT_ID: 'account-1',
      DASHBOARD_PASSWORD: 'dashboard-secret',
      MEM0_BASE_URL: 'https://mem0.example',
    },
    readFileImpl: async () => `
      [[d1_databases]]
      binding = "DB"
      database_id = "database-1"

      [[vectorize]]
      binding = "VECTORIZE"
      index_name = "memory-index"
    `,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        success: true,
        result: successfulD1Result([{
          id: 'ownerless',
          user_id: null,
          agent_id: null,
          content: 'cannot reindex',
          content_hash: null,
          created_at: 1,
          deleted_at: null,
        }, {
          id: 'whitespace-owner',
          user_id: '   ',
          agent_id: null,
          content: 'also cannot reindex',
          content_hash: null,
          created_at: 2,
          deleted_at: null,
        }]),
      });
    },
    logger: { log: assert.fail, error: (message) => errors.push(message) },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(errors, [
    'apply preflight found 2 unreindexable active memories: ownerless, whitespace-owner',
  ]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/d1\/database\/database-1\/query$/);
  assert.equal(JSON.parse(calls[0].init.body).batch, undefined);
});

test('apply authenticates Dashboard before the first D1 or Vectorize mutation', async () => {
  const row = {
    id: 'ready',
    user_id: 'user-1',
    agent_id: null,
    content: 'ready',
    content_hash: await contentHash('ready'),
    created_at: 1,
    deleted_at: null,
  };
  const calls = [];
  const errors = [];
  const exitCode = await main(['apply', '--confirm'], {
    env: {
      CLOUDFLARE_API_TOKEN: 'cloudflare-secret',
      CLOUDFLARE_ACCOUNT_ID: 'account-1',
      DASHBOARD_PASSWORD: 'dashboard-secret',
      MEM0_BASE_URL: 'https://mem0.example',
    },
    readFileImpl: async () => `
      [[d1_databases]]
      binding = "DB"
      database_id = "database-1"

      [[vectorize]]
      binding = "VECTORIZE"
      index_name = "memory-index"
    `,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/dashboard/login')) return jsonResponse({ error: 'Unauthorized' }, 401);
      return jsonResponse({ success: true, result: successfulD1Result([row]) });
    },
    logger: { log: assert.fail, error: (message) => errors.push(message) },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(errors, ['Dashboard login failed: HTTP 401']);
  assert.deepEqual(calls.map(({ url }) => url), [
    'https://api.cloudflare.com/client/v4/accounts/account-1/d1/database/database-1/query',
    'https://mem0.example/dashboard/login',
  ]);
  assert.equal(JSON.parse(calls[0].init.body).batch, undefined);
});

test('confirmed apply removes an unrelated deleted vector without mutating its D1 row', async () => {
  const fake = await createStatefulMaintenanceFake(undefined);
  const logs = [];
  const errors = [];
  const options = statefulMaintenanceOptions(fake, logs, errors);
  const deletedRow = fake.rows.find(({ id }) => id === 'unrelated-deleted');
  const deletedRowBefore = structuredClone(deletedRow);

  assert.equal(await main(['apply', '--confirm'], options), 0);
  assert.equal(await main(['verify'], options), 0);
  assert.deepEqual(deletedRow, deletedRowBefore);
  assert.equal(fake.vectors.has('unrelated-deleted'), false);
  assert.deepEqual(fake.stats.vectorDeleteSubmissions, [[
    'loser',
    'unrelated-deleted',
  ]]);

  const applyLog = JSON.parse(logs[0]);
  assert.equal(applyLog.report.deleted_vector_ids_submitted, 2);
  const verifyLog = JSON.parse(logs.at(-1));
  assert.equal(verifyLog.ok, true);
  assert.equal(verifyLog.report.hash_issue_count, 0);
  assert.deepEqual(verifyLog.report.null_hash_ids, []);
  assert.equal(verifyLog.report.unexpected_deleted_vector_count, 0);
  assert.deepEqual(errors, []);
});

test('confirmed apply resumes after every committed phase and converges idempotently', async (t) => {
  const scenarios = [
    'after-hash-commit',
    'after-d1-cleanup',
    'after-vector-deletion-submission',
    'during-partial-reindex',
  ];

  for (const failurePhase of scenarios) {
    await t.test(failurePhase, async () => {
      const fake = await createStatefulMaintenanceFake(failurePhase);
      const logs = [];
      const errors = [];
      const options = statefulMaintenanceOptions(fake, logs, errors);

      assert.equal(await main(['apply', '--confirm'], options), 1);
      assert.match(errors.at(-1), new RegExp(`injected ${failurePhase}`));
      assert.equal(await main(['apply', '--confirm'], options), 0);
      assert.equal(await main(['verify'], options), 0);

      const canonical = fake.rows.find(({ id }) => id === 'canonical');
      const loser = fake.rows.find(({ id }) => id === 'loser');
      const other = fake.rows.find(({ id }) => id === 'other');
      const unrelatedDeleted = fake.rows.find(({ id }) => id === 'unrelated-deleted');
      assert.equal(canonical.content_hash, await contentHash(canonical.content));
      assert.equal(loser.content_hash, await contentHash(loser.content));
      assert.equal(other.content_hash, await contentHash(other.content));
      assert.equal(unrelatedDeleted.content_hash, await contentHash(unrelatedDeleted.content));
      assert.equal(unrelatedDeleted.deleted_at, 50);
      assert.equal(loser.deleted_at, 100);
      assert.deepEqual([...fake.vectors.keys()].sort(), ['canonical', 'other']);
      assert.equal(fake.vectors.get('canonical').metadata.scope_key, await scopeKey(canonical));
      assert.equal(fake.vectors.get('other').metadata.scope_key, await scopeKey(other));
      assert.equal(fake.stats.hashCommits, 1);
      assert.equal(fake.stats.cleanupCommits, 1);
      assert.ok(fake.stats.vectorDeleteSubmissions.length >= 1);
      assert.ok(fake.stats.vectorDeleteSubmissions.length <= 2);
      assert.ok(fake.stats.vectorDeleteSubmissions.every((ids) => (
        ids.length === 2
          && ids[0] === 'loser'
          && ids[1] === 'unrelated-deleted'
      )));

      const verifyLog = JSON.parse(logs.at(-1));
      assert.equal(verifyLog.command, 'verify');
      assert.equal(verifyLog.ok, true);
      assert.equal(verifyLog.report.unexpected_deleted_vector_count, 0);
      if (failurePhase === 'during-partial-reindex') {
        assert.deepEqual(fake.stats.reindexSuccesses, ['canonical', 'canonical', 'other']);
      }
    });
  }
});

test('applyHashUpdates sends bounded parameterized D1 batches with raw content only in params', async () => {
  const calls = [];
  const dangerousContent = "quote' ; DROP TABLE memories; --";
  const rows = [
    { id: 'one', content: dangerousContent },
    { id: 'two', content: 'two' },
    { id: 'three', content: 'three' },
  ];
  const updates = rows.map((row) => ({ id: row.id, contentHash: `hash-${row.id}` }));

  const result = await applyHashUpdates({
    rows,
    updates,
    batchSize: 2,
    queryD1: async (body) => {
      calls.push(body);
      return body.batch.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
    },
  });

  assert.deepEqual(result, { attempted: 3, batches: 2 });
  assert.equal(calls[0].batch.length, 2);
  assert.doesNotMatch(calls[0].batch[0].sql, /DROP TABLE|hash-one|one/);
  assert.deepEqual(calls[0].batch[0].params, ['hash-one', 'one', dangerousContent, 'hash-one']);
});

test('cleanupDuplicate uses one guarded D1 batch and reports only a decisive soft delete', async () => {
  let sent;
  const decisive = await cleanupDuplicate({
    mapping: { canonicalId: 'canonical-danger', loserId: 'loser-danger' },
    queryD1: async (body) => {
      sent = body;
      return [
        { success: true, results: [] },
        { success: true, results: [] },
        { success: true, results: [{ id: 'loser-danger' }] },
      ];
    },
  });

  assert.equal(decisive, true);
  assert.equal(sent.batch.length, 3);
  assert.match(sent.batch[0].sql, /INSERT OR IGNORE INTO memory_entity_links/i);
  assert.match(sent.batch[1].sql, /UPDATE relationships\s+SET evidence_memory_id = \?/i);
  assert.match(sent.batch[2].sql, /SET deleted_at = unixepoch\(\)/i);
  for (const statement of sent.batch) {
    assert.doesNotMatch(statement.sql, /canonical-danger|loser-danger/);
  }
  assert.deepEqual(sent.batch[2].params, ['loser-danger', 'canonical-danger']);

  assert.equal(await cleanupDuplicate({
    mapping: { canonicalId: 'canonical', loserId: 'loser' },
    queryD1: async () => [
      { success: true, results: [] },
      { success: true, results: [] },
      { success: true, results: [] },
    ],
  }), false);
});

test('deleteVectorIds uses bounded batches and preserves call order', async () => {
  const calls = [];
  const result = await deleteVectorIds({
    ids: ['a', 'b', 'c', 'd', 'e'],
    batchSize: 2,
    deleteVectors: async (ids) => calls.push(ids),
  });

  assert.deepEqual(calls, [['a', 'b'], ['c', 'd'], ['e']]);
  assert.deepEqual(result, { ids: 5, batches: 3 });
});

test('Dashboard login captures the session cookie and reindex preserves each active owner scope', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/dashboard/login')) {
      return new Response(null, {
        status: 303,
        headers: { 'Set-Cookie': '__Host-dashboard-session=signed; Path=/; HttpOnly; Secure' },
      });
    }
    return jsonResponse({ ok: true });
  };

  const cookie = await loginDashboard({
    baseUrl: 'https://mem0.example/',
    password: 'dashboard-secret',
    fetchImpl,
  });
  const session = { cookie };
  const result = await reindexActiveMemories({
    baseUrl: 'https://mem0.example',
    session,
    password: 'dashboard-secret',
    fetchImpl,
    rows: [
      { id: 'user', user_id: 'u', agent_id: null, deleted_at: null },
      { id: 'agent', user_id: null, agent_id: 'a', deleted_at: null },
      { id: 'paired', user_id: 'u', agent_id: 'a', deleted_at: null },
      { id: 'agent-fallback', user_id: '   ', agent_id: 'a2', deleted_at: null },
      { id: 'deleted', user_id: 'u', agent_id: null, deleted_at: 1 },
    ],
  });

  assert.equal(cookie, '__Host-dashboard-session=signed');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.body, 'password=dashboard-secret');
  assert.deepEqual(calls.slice(1).map(({ url, init }) => ({
    url,
    cookie: init.headers.Cookie,
    body: JSON.parse(init.body),
  })), [
    {
      url: 'https://mem0.example/dashboard/api/memories/user/reindex',
      cookie,
      body: { entity_type: 'user', entity_id: 'u' },
    },
    {
      url: 'https://mem0.example/dashboard/api/memories/agent/reindex',
      cookie,
      body: { entity_type: 'agent', entity_id: 'a' },
    },
    {
      url: 'https://mem0.example/dashboard/api/memories/paired/reindex',
      cookie,
      body: { entity_type: 'user', entity_id: 'u' },
    },
    {
      url: 'https://mem0.example/dashboard/api/memories/agent-fallback/reindex',
      cookie,
      body: { entity_type: 'agent', entity_id: 'a2' },
    },
  ]);
  assert.deepEqual(result, { reindexed: 4 });
});

test('reindexActiveMemories fails clearly for an active ownerless memory before fetch', async () => {
  let fetched = false;
  await assert.rejects(reindexActiveMemories({
    baseUrl: 'https://mem0.example',
    session: { cookie: 'session=signed' },
    password: 'dashboard-secret',
    fetchImpl: async () => {
      fetched = true;
      return jsonResponse({ ok: true });
    },
    rows: [{ id: 'ownerless', user_id: null, agent_id: null, deleted_at: null }],
  }), /active memory ownerless has no Dashboard-reindexable owner/);
  assert.equal(fetched, false);
});

test('reindexActiveMemories renews an expired session and retries only the current memory', async () => {
  const calls = [];
  const session = { cookie: '__Host-dashboard-session=old-session' };
  const fetchImpl = async (url, init) => {
    calls.push({ url, cookie: init.headers?.Cookie });
    if (url.endsWith('/dashboard/login')) {
      return new Response(null, {
        status: 303,
        headers: { 'Set-Cookie': '__Host-dashboard-session=new-session; Path=/; HttpOnly; Secure' },
      });
    }
    if (url.endsWith('/second/reindex') && init.headers.Cookie.includes('old-session')) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    return jsonResponse({ ok: true });
  };

  const result = await reindexActiveMemories({
    rows: [
      { id: 'first', user_id: 'u', agent_id: null, deleted_at: null },
      { id: 'second', user_id: 'u', agent_id: null, deleted_at: null },
      { id: 'third', user_id: 'u', agent_id: null, deleted_at: null },
    ],
    baseUrl: 'https://mem0.example',
    session,
    password: 'dashboard-secret',
    fetchImpl,
  });

  assert.deepEqual(calls.map(({ url }) => url), [
    'https://mem0.example/dashboard/api/memories/first/reindex',
    'https://mem0.example/dashboard/api/memories/second/reindex',
    'https://mem0.example/dashboard/login',
    'https://mem0.example/dashboard/api/memories/second/reindex',
    'https://mem0.example/dashboard/api/memories/third/reindex',
  ]);
  assert.equal(calls[0].cookie, '__Host-dashboard-session=old-session');
  assert.equal(calls[3].cookie, '__Host-dashboard-session=new-session');
  assert.equal(calls[4].cookie, '__Host-dashboard-session=new-session');
  assert.equal(session.cookie, '__Host-dashboard-session=new-session');
  assert.deepEqual(result, { reindexed: 3 });
});

test('reindexActiveMemories stops after a renewed session also receives 401', async () => {
  const calls = [];
  const session = { cookie: '__Host-dashboard-session=old-session' };
  const fetchImpl = async (url, init) => {
    calls.push({ url, cookie: init.headers?.Cookie });
    if (url.endsWith('/dashboard/login')) {
      return new Response(null, {
        status: 303,
        headers: { 'Set-Cookie': '__Host-dashboard-session=new-session; Path=/; HttpOnly; Secure' },
      });
    }
    return jsonResponse({ error: 'Unauthorized' }, 401);
  };

  await assert.rejects(reindexActiveMemories({
    rows: [{ id: 'current', user_id: 'u', agent_id: null, deleted_at: null }],
    baseUrl: 'https://mem0.example',
    session,
    password: 'dashboard-secret',
    fetchImpl,
  }), /Dashboard reindex failed for memory current: HTTP 401/);

  assert.deepEqual(calls.map(({ url }) => url), [
    'https://mem0.example/dashboard/api/memories/current/reindex',
    'https://mem0.example/dashboard/login',
    'https://mem0.example/dashboard/api/memories/current/reindex',
  ]);
});

test('reindexActiveMemories redacts old and renewed sessions from transport errors', async () => {
  const oldCookie = '__Host-dashboard-session=old-secret-session';
  const newCookie = '__Host-dashboard-session=new-secret-session';
  const session = { cookie: oldCookie };
  let reindexAttempts = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/dashboard/login')) {
      return new Response(null, {
        status: 303,
        headers: { 'Set-Cookie': `${newCookie}; Path=/; HttpOnly; Secure` },
      });
    }
    reindexAttempts += 1;
    if (reindexAttempts === 1) return jsonResponse({ error: 'Unauthorized' }, 401);
    throw new Error(`transport exposed ${oldCookie} ${newCookie} dashboard-secret`);
  };

  await assert.rejects(reindexActiveMemories({
    rows: [{ id: 'current', user_id: 'u', agent_id: null, deleted_at: null }],
    baseUrl: 'https://mem0.example',
    session,
    password: 'dashboard-secret',
    fetchImpl,
  }), (error) => error.message.includes('[redacted]')
    && !error.message.includes(oldCookie)
    && !error.message.includes(newCookie)
    && !error.message.includes('dashboard-secret'));
});

test('verifyMemoryState batches active and deleted vector reads and reports every failure category', async () => {
  const rows = [
    { id: 'canonical', user_id: 'u', agent_id: null, content: 'same', content_hash: await contentHash('same'), created_at: 1, deleted_at: null },
    { id: 'duplicate', user_id: 'u', agent_id: null, content: 'same', content_hash: await contentHash('same'), created_at: 2, deleted_at: null },
    { id: 'missing', user_id: null, agent_id: 'a', content: 'missing', content_hash: null, created_at: 3, deleted_at: null },
    { id: 'wrong-scope', user_id: 'u2', agent_id: 'a2', content: 'scope', content_hash: await contentHash('scope'), created_at: 4, deleted_at: null },
    { id: 'deleted-null', user_id: 'u', agent_id: null, content: 'old', content_hash: null, created_at: 5, deleted_at: 9 },
  ];
  const calls = [];
  const canonicalScope = await scopeKey(rows[0]);
  const duplicateScope = await scopeKey(rows[1]);
  const result = await verifyMemoryState({
    rows,
    vectorBatchSize: 2,
    getVectors: async (ids) => {
      calls.push(ids);
      return ids.flatMap((id) => {
        if (id === 'missing') return [];
        if (id === 'canonical') return [{ id, metadata: { scope_key: canonicalScope } }];
        if (id === 'duplicate') return [{ id, metadata: { scope_key: duplicateScope } }];
        return [{ id, metadata: { scope_key: 'wrong' } }];
      });
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [['canonical', 'duplicate'], ['missing', 'wrong-scope'], ['deleted-null']]);
  assert.deepEqual(result.report.null_hash_ids, ['missing', 'deleted-null']);
  assert.deepEqual(result.report.mismatched_hash_ids, []);
  assert.deepEqual(result.report.active_duplicate_mappings, [
    { canonicalId: 'canonical', loserId: 'duplicate' },
  ]);
  assert.equal(result.report.active_duplicate_group_count, 1);
  assert.equal(result.report.active_duplicate_mapping_count, 1);
  assert.deepEqual(result.report.missing_active_vector_ids, ['missing']);
  assert.deepEqual(result.report.wrong_scope_key_ids, ['wrong-scope']);
  assert.equal(result.report.unexpected_deleted_vector_count, 1);
  assert.deepEqual(result.report.unexpected_deleted_vector_ids, ['deleted-null']);
  assert.match(result.report.operator_note, /Vectorize mutations are asynchronous/);
  assert.match(result.report.operator_note, /deleted vectors may remain visible briefly/i);
});

test('verifyMemoryState succeeds when hashes, exact groups, vectors, and scope metadata are complete', async () => {
  const row = {
    id: 'ready',
    user_id: 'u',
    agent_id: 'a',
    content: 'ready',
    content_hash: await contentHash('ready'),
    created_at: 1,
    deleted_at: null,
  };
  const deletedRow = { ...row, id: 'deleted', deleted_at: 10 };
  const calls = [];
  const result = await verifyMemoryState({
    rows: [row, deletedRow],
    getVectors: async (ids) => {
      calls.push(ids);
      return ids.includes(row.id)
        ? [{ id: row.id, metadata: { scope_key: await scopeKey(row) } }]
        : [];
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['ready'], ['deleted']]);
  assert.equal(result.report.hash_issue_count, 0);
  assert.equal(result.report.active_duplicate_group_count, 0);
  assert.equal(result.report.active_duplicate_mapping_count, 0);
  assert.equal(result.report.missing_active_vector_count, 0);
  assert.equal(result.report.wrong_scope_key_count, 0);
  assert.equal(result.report.unexpected_deleted_vector_count, 0);
  assert.deepEqual(result.report.unexpected_deleted_vector_ids, []);
});
