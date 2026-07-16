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
  createInspectionArtifact,
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
  vectorStateHash,
  verifyMemoryState,
} from '../migrate-memory-deduplication.mjs';

const TEST_CONFIG = {
  accountId: 'account-1',
  databaseId: 'database-1',
  vectorizeIndexName: 'memory-index',
  mem0BaseUrl: 'https://mem0.example',
};

const TEST_WRANGLER_CONFIG = `
  [[d1_databases]]
  binding = "DB"
  database_id = "database-1"

  [[vectorize]]
  binding = "VECTORIZE"
  index_name = "memory-index"
`;

async function artifactSource(rows, config = TEST_CONFIG) {
  for (const row of rows) {
    if (!Object.hasOwn(row, 'run_id')) row.run_id = null;
    if (!Object.hasOwn(row, 'actor_id')) row.actor_id = null;
    if (!Object.hasOwn(row, 'metadata_json')) row.metadata_json = '{}';
  }
  return JSON.stringify(await createInspectionArtifact({
    rows: structuredClone(rows),
    config,
    createdAt: new Date('2026-07-16T12:00:00Z'),
  }));
}

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

test('vectorStateHash uses the exact maintenance D1 source tuple', async () => {
  const row = {
    user_id: 'user-1', agent_id: 'agent-1', run_id: 'run-1', actor_id: 'actor-1',
    metadata_json: '{"b":2,"a":1}', content_hash: 'content-digest',
  };
  assert.equal(await vectorStateHash(row), await sha256Hex(JSON.stringify([
    row.user_id, row.agent_id, row.run_id, row.actor_id, row.metadata_json, row.content_hash,
  ])));
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

async function createStatefulMaintenanceFake(failurePhase, {
  loserExternallyDeleted = false,
  forceIncompleteGraphAudit = false,
} = {}) {
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
  if (loserExternallyDeleted) {
    for (const row of rows) row.content_hash = await contentHash(row.content);
  }
  const artifact = await artifactSource(rows);
  if (loserExternallyDeleted) {
    rows.find(({ id }) => id === 'loser').deleted_at = 75;
  }
  const entityLinks = new Map([
    ['canonical', new Set()],
    ['loser', new Set(['entity-1'])],
  ]);
  const relationships = [{ id: 'relationship-1', evidence_memory_id: 'loser' }];
  const vectors = new Map(rows.map((row) => [
    row.id,
    { id: row.id, metadata: { scope_key: 'stale' } },
  ]));
  const stats = {
    hashCommits: 0,
    cleanupCommits: 0,
    vectorDeleteSubmissions: [],
    reindexSuccesses: [],
    indexInfoCalls: 0,
    graphAuditCalls: 0,
  };
  let pendingFailure = failurePhase;
  let loginCount = 0;
  let reindexAttemptCount = 0;
  let mutationCount = 0;
  let lastMutationId = '0';
  const nextMutationId = () => {
    mutationCount += 1;
    lastMutationId = String(mutationCount);
    return lastMutationId;
  };

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
        const exactPair = canonical?.deleted_at === null
          && loser !== undefined
          && loser.user_id === canonical.user_id
          && loser.agent_id === canonical.agent_id
          && loser.content_hash === canonical.content_hash
          && loser.content === canonical.content;
        const graphGuardRequiresActiveLoser = /loser\.deleted_at IS NULL/i.test(body.batch[0].sql);
        if (exactPair && (!graphGuardRequiresActiveLoser || loser.deleted_at === null)) {
          for (const entityId of entityLinks.get(loserId) ?? []) {
            entityLinks.get(canonicalId).add(entityId);
          }
          for (const relationship of relationships) {
            if (relationship.evidence_memory_id === loserId) relationship.evidence_memory_id = canonicalId;
          }
        }
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

      if (body.batch?.[0]?.sql.includes('relationship_evidence_count')) {
        stats.graphAuditCalls += 1;
        return jsonResponse({
          success: true,
          result: body.batch.map((statement) => {
            const [canonicalId, loserId] = statement.params;
            const relationshipEvidenceCount = relationships.filter(({ evidence_memory_id }) => (
              evidence_memory_id === loserId
            )).length;
            const missingCanonicalLinkCount = [...(entityLinks.get(loserId) ?? [])].filter((entityId) => (
              !entityLinks.get(canonicalId)?.has(entityId)
            )).length;
            return {
              success: true,
              results: [{
                canonical_id: canonicalId,
                loser_id: loserId,
                relationship_evidence_count: forceIncompleteGraphAudit ? 1 : relationshipEvidenceCount,
                missing_canonical_link_count: missingCanonicalLinkCount,
              }],
              meta: { changes: 0 },
            };
          }),
        });
      }

      throw new Error('unexpected D1 request');
    }

    if (url.endsWith('/delete_by_ids')) {
      const { ids } = JSON.parse(init.body);
      stats.vectorDeleteSubmissions.push([...ids]);
      for (const id of ids) vectors.delete(id);
      failOnce('after-vector-deletion-submission');
      return jsonResponse({ success: true, result: { mutationId: nextMutationId() } });
    }

    if (url.endsWith('/info')) {
      stats.indexInfoCalls += 1;
      return jsonResponse({ success: true, result: { processedUpToMutation: Number(lastMutationId) } });
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
      vectors.set(id, { id, metadata: {
        scope_key: await scopeKey(row),
        content_hash: row.content_hash,
        memory_vector_schema: '1',
        vector_state_hash: await vectorStateHash(row),
      } });
      stats.reindexSuccesses.push(id);
      return jsonResponse({ ok: true, mutation_id: nextMutationId() });
    }

    throw new Error(`unexpected request: ${url}`);
  };

  return { rows, vectors, entityLinks, relationships, stats, fetchImpl, artifact };
}

function statefulMaintenanceOptions(fake, logs, errors) {
  return {
    env: {
      CLOUDFLARE_API_TOKEN: 'cloudflare-secret',
      CLOUDFLARE_ACCOUNT_ID: 'account-1',
      DASHBOARD_PASSWORD: 'dashboard-secret',
      MEM0_BASE_URL: 'https://mem0.example',
    },
    readFileImpl: async (path) => path === 'wrangler.toml' ? TEST_WRANGLER_CONFIG : fake.artifact,
    fetchImpl: fake.fetchImpl,
    logger: {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    },
  };
}

test('parseArguments accepts only the documented commands and confirmation flag', () => {
  assert.deepEqual(parseArguments(['inspect']), { command: 'inspect', confirm: false });
  assert.deepEqual(parseArguments(['apply', '--confirm', 'backups/inspection.json']), {
    command: 'apply', confirm: true, artifactPath: 'backups/inspection.json',
  });
  assert.deepEqual(parseArguments(['verify']), { command: 'verify', confirm: false });
  assert.throws(() => parseArguments([]), new RegExp(USAGE.replaceAll('\n', '\\s+')));
  assert.throws(() => parseArguments(['remove']), /unknown command: remove/);
  assert.throws(() => parseArguments(['verify', '--confirm']), /unexpected arguments/);
  assert.throws(() => parseArguments(['apply', '--confirm']), /inspection artifact path/);
});

test('inspection artifacts have a deterministic schema and reject malformed, corrupt, or mismatched targets', async () => {
  const { createInspectionArtifact, validateInspectionArtifact } = await import('../migrate-memory-deduplication.mjs');
  assert.equal(typeof createInspectionArtifact, 'function');
  assert.equal(typeof validateInspectionArtifact, 'function');
  const config = {
    accountId: 'account-1',
    databaseId: 'database-1',
    vectorizeIndexName: 'memory-index',
    mem0BaseUrl: 'https://mem0.example',
  };
  const rows = [{
    id: 'memory-1', user_id: 'user-1', agent_id: null,
    run_id: 'run-1', actor_id: 'actor-1', metadata_json: '{"label":"exact"}', content: 'exact',
    content_hash: null, created_at: 1, deleted_at: null,
  }];
  const createdAt = new Date('2026-07-16T12:34:56.000Z');
  const first = await createInspectionArtifact({ rows, config, createdAt });
  const second = await createInspectionArtifact({ rows: structuredClone(rows), config: { ...config }, createdAt });
  assert.deepEqual(first, second);
  assert.equal(first.artifact_schema, 'memory-deduplication-inspection/v2');
  assert.deepEqual(first.target, {
    account_id: 'account-1',
    database_id: 'database-1',
    vectorize_index_name: 'memory-index',
    mem0_base_url: 'https://mem0.example',
  });
  assert.deepEqual(first.mappings, []);
  assert.equal(first.rows[0].run_id, 'run-1');
  assert.equal(first.rows[0].actor_id, 'actor-1');
  assert.equal(first.rows[0].metadata_json, '{"label":"exact"}');
  assert.match(first.integrity.fingerprint, /^[0-9a-f]{64}$/);
  await assert.doesNotReject(validateInspectionArtifact(JSON.stringify(first), config));
  await assert.rejects(validateInspectionArtifact('{not-json', config), /invalid JSON/);

  const corrupt = structuredClone(first);
  corrupt.rows[0].content = 'changed';
  await assert.rejects(validateInspectionArtifact(JSON.stringify(corrupt), config), /integrity fingerprint mismatch/);
  await assert.rejects(
    createInspectionArtifact({ rows: [{ ...rows[0], metadata_json: undefined }], config, createdAt }),
    /inspection artifact rows are invalid/,
  );
  await assert.rejects(validateInspectionArtifact(JSON.stringify(first), {
    ...config,
    databaseId: 'other-database',
  }), /target does not match current configuration/);
});

test('artifact state validation accepts only inspected or artifact-reachable partial states', async () => {
  const { createInspectionArtifact, validateApplyState } = await import('../migrate-memory-deduplication.mjs');
  assert.equal(typeof validateApplyState, 'function');
  const config = {
    accountId: 'account-1', databaseId: 'database-1',
    vectorizeIndexName: 'memory-index', mem0BaseUrl: 'https://mem0.example',
  };
  const rows = [
    { id: 'canonical', user_id: 'u', agent_id: null, run_id: 'r1', actor_id: 'a1', metadata_json: '{"v":1}', content: 'same', content_hash: null, created_at: 1, deleted_at: null },
    { id: 'loser', user_id: 'u', agent_id: null, run_id: 'r2', actor_id: 'a2', metadata_json: '{"v":2}', content: 'same', content_hash: null, created_at: 2, deleted_at: null },
    { id: 'other', user_id: null, agent_id: 'a', run_id: null, actor_id: null, metadata_json: '{}', content: 'other', content_hash: null, created_at: 3, deleted_at: null },
  ];
  const artifact = await createInspectionArtifact({ rows, config, createdAt: new Date('2026-07-16T12:00:00Z') });
  assert.deepEqual(artifact.mappings, [{ canonicalId: 'canonical', loserId: 'loser' }]);
  await assert.doesNotReject(validateApplyState(artifact, structuredClone(rows)));

  const hashed = structuredClone(rows);
  for (const update of artifact.report.pending_hash_updates) {
    hashed.find(({ id }) => id === update.id).content_hash = update.contentHash;
  }
  await assert.doesNotReject(validateApplyState(artifact, hashed));
  const resumed = structuredClone(hashed);
  resumed.find(({ id }) => id === 'loser').deleted_at = 100;
  await assert.doesNotReject(validateApplyState(artifact, resumed));

  await assert.rejects(validateApplyState(artifact, [...rows, { ...rows[0], id: 'new' }]), /new memory new/);
  await assert.rejects(validateApplyState(artifact, rows.slice(1)), /missing memory canonical/);
  await assert.rejects(validateApplyState(artifact, rows.map((row) => (
    row.id === 'canonical' ? { ...row, user_id: 'changed-owner' } : row
  ))), /memory canonical changed user_id/);
  await assert.rejects(validateApplyState(artifact, rows.map((row) => (
    row.id === 'canonical' ? { ...row, content: 'changed content' } : row
  ))), /memory canonical changed content/);
  for (const [field, value] of [
    ['run_id', 'changed-run'],
    ['actor_id', 'changed-actor'],
    ['metadata_json', '{"v":"changed"}'],
  ]) {
    await assert.rejects(validateApplyState(artifact, rows.map((row) => (
      row.id === 'canonical' ? { ...row, [field]: value } : row
    ))), new RegExp(`memory canonical changed ${field}`));
  }
  await assert.rejects(validateApplyState(artifact, rows.map((row) => (
    row.id === 'other' ? { ...row, deleted_at: 100 } : row
  ))), /memory other has an unplanned deletion transition/);
  await assert.rejects(validateApplyState(artifact, rows.map((row) => (
    row.id === 'other' ? { ...row, content_hash: 'unknown' } : row
  ))), /memory other has an unplanned content_hash/);
});

test('apply rejects an artifact target mismatch before D1, Dashboard, or Vectorize access', async () => {
  const { createInspectionArtifact } = await import('../migrate-memory-deduplication.mjs');
  const artifact = await createInspectionArtifact({
    rows: [],
    config: {
      accountId: 'account-1', databaseId: 'wrong-database',
      vectorizeIndexName: 'memory-index', mem0BaseUrl: 'https://mem0.example',
    },
    createdAt: new Date('2026-07-16T12:00:00Z'),
  });
  const calls = [];
  const errors = [];
  const exitCode = await main(['apply', '--confirm', 'backups/inspection.json'], {
    env: {
      CLOUDFLARE_API_TOKEN: 'cloudflare-secret', CLOUDFLARE_ACCOUNT_ID: 'account-1',
      DASHBOARD_PASSWORD: 'dashboard-secret', MEM0_BASE_URL: 'https://mem0.example',
    },
    readFileImpl: async (path) => path === 'wrangler.toml' ? `
      [[d1_databases]]
      binding = "DB"
      database_id = "database-1"
      [[vectorize]]
      binding = "VECTORIZE"
      index_name = "memory-index"
    ` : JSON.stringify(artifact),
    fetchImpl: async (...args) => { calls.push(args); throw new Error('network must not be used'); },
    logger: { log: assert.fail, error: (message) => errors.push(message) },
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(errors, ['inspection artifact target does not match current configuration']);
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

test('Cloudflare client validates Vectorize mutation and index-info envelopes', async () => {
  const responses = [
    { mutationId: '42' },
    { processedUpToMutation: 42 },
    { mutationId: '' },
    { processedUpToMutation: null },
  ];
  const client = createCloudflareClient({
    token: 'token',
    fetchImpl: async () => jsonResponse({ success: true, result: responses.shift() }),
  });

  assert.deepEqual(await client.deleteVectors('account', 'index', ['id']), { mutationId: '42' });
  assert.deepEqual(await client.getVectorIndexInfo('account', 'index'), { processedUpToMutation: 42 });
  await assert.rejects(client.deleteVectors('account', 'index', ['id']), /invalid mutation result/);
  await assert.rejects(client.getVectorIndexInfo('account', 'index'), /invalid index info/);
});

test('waitForVectorMutation polls until equality and fails on its bounded timeout', async () => {
  const { waitForVectorMutation } = await import('../migrate-memory-deduplication.mjs');
  assert.equal(typeof waitForVectorMutation, 'function');

  const observations = [40, 42];
  let clock = 0;
  const result = await waitForVectorMutation({
    mutationId: '42',
    getIndexInfo: async () => ({ processedUpToMutation: observations.shift() }),
    timeoutMs: 10,
    pollIntervalMs: 1,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  });
  assert.deepEqual(result, { mutationId: '42', polls: 2 });

  clock = 0;
  let timeoutPolls = 0;
  await assert.rejects(waitForVectorMutation({
    mutationId: 'never',
    getIndexInfo: async () => {
      timeoutPolls += 1;
      return { processedUpToMutation: 'old' };
    },
    timeoutMs: 2,
    pollIntervalMs: 10,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  }), /timed out waiting for Vectorize mutation never/);
  assert.equal(clock, 2);
  assert.equal(timeoutPolls, 1);
});

test('pendingReindexRows batches active vector reads and skips only fully converged rows', async () => {
  const { pendingReindexRows, vectorStateHash } = await import('../migrate-memory-deduplication.mjs');
  assert.equal(typeof pendingReindexRows, 'function');
  assert.equal(typeof vectorStateHash, 'function');
  const rows = await Promise.all([
    ['ready', 'ready', 'run-1', 'actor-1', '{"label":"ready"}'],
    ['missing', 'missing', null, null, '{}'],
    ['wrong-hash', 'hash', null, null, '{}'],
    ['wrong-schema', 'schema', null, null, '{}'],
    ['wrong-scope', 'scope', null, null, '{}'],
    ['wrong-metadata', 'same-content', 'run-1', 'actor-1', '{"label":"new"}'],
    ['wrong-run', 'same-content', 'run-new', 'actor-1', '{"label":"same"}'],
    ['wrong-actor', 'same-content', 'run-1', 'actor-new', '{"label":"same"}'],
  ].map(async ([id, content, run_id, actor_id, metadata_json]) => ({
    id,
    user_id: 'user-1',
    agent_id: null,
    run_id,
    actor_id,
    metadata_json,
    content,
    content_hash: await contentHash(content),
    created_at: 1,
    deleted_at: null,
  })));
  const calls = [];
  const vectors = new Map(await Promise.all(rows.map(async (row) => [row.id, {
    id: row.id,
    metadata: {
      scope_key: await scopeKey(row),
      content_hash: row.content_hash,
      memory_vector_schema: '1',
      vector_state_hash: await vectorStateHash(row),
    },
  }])));
  vectors.delete('missing');
  vectors.get('wrong-hash').metadata.content_hash = 'stale';
  vectors.get('wrong-schema').metadata.memory_vector_schema = '0';
  vectors.get('wrong-scope').metadata.scope_key = 'stale';
  vectors.get('wrong-metadata').metadata.vector_state_hash = await vectorStateHash({
    ...rows.find(({ id }) => id === 'wrong-metadata'), metadata_json: '{"label":"old"}',
  });
  vectors.get('wrong-run').metadata.vector_state_hash = await vectorStateHash({
    ...rows.find(({ id }) => id === 'wrong-run'), run_id: 'run-old',
  });
  vectors.get('wrong-actor').metadata.vector_state_hash = await vectorStateHash({
    ...rows.find(({ id }) => id === 'wrong-actor'), actor_id: 'actor-old',
  });

  const pending = await pendingReindexRows({
    rows,
    vectorBatchSize: 2,
    getVectors: async (ids) => {
      calls.push(ids);
      return ids.flatMap((id) => vectors.has(id) ? [vectors.get(id)] : []);
    },
  });

  assert.deepEqual(calls, [
    ['ready', 'missing'], ['wrong-hash', 'wrong-schema'], ['wrong-scope', 'wrong-metadata'],
    ['wrong-run', 'wrong-actor'],
  ]);
  assert.deepEqual(pending.map(({ id }) => id), [
    'missing', 'wrong-hash', 'wrong-schema', 'wrong-scope',
    'wrong-metadata', 'wrong-run', 'wrong-actor',
  ]);
});

test('pendingReindexRows respects the Vectorize get-by-ids limit by default', async () => {
  const { pendingReindexRows, vectorStateHash } = await import('../migrate-memory-deduplication.mjs');
  const rows = await Promise.all(Array.from({ length: 41 }, async (_, index) => {
    const content = `memory-${index}`;
    return {
      id: `memory-${index}`,
      user_id: 'user-1',
      agent_id: null,
      run_id: null,
      actor_id: null,
      metadata_json: '{}',
      content,
      content_hash: await contentHash(content),
      created_at: index,
      deleted_at: null,
    };
  }));
  const calls = [];

  const pending = await pendingReindexRows({
    rows,
    getVectors: async (ids) => {
      calls.push(ids);
      return Promise.all(ids.map(async (id) => {
        const row = rows.find((candidate) => candidate.id === id);
        return {
          id,
          metadata: {
            scope_key: await scopeKey(row),
            content_hash: row.content_hash,
            memory_vector_schema: '1',
            vector_state_hash: await vectorStateHash(row),
          },
        };
      }));
    },
  });

  assert.deepEqual(calls.map((ids) => ids.length), [20, 20, 1]);
  assert.deepEqual(pending, []);
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
  assert.match(calls[0].sql, /run_id, actor_id, metadata_json/i);
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
            run_id: null,
            actor_id: null,
            metadata_json: '{}',
            content: 'safe content',
            content_hash: await contentHash('safe content'),
            created_at: 1,
            deleted_at: null,
          },
          {
            id: 'memory-2',
            user_id: 'user-1',
            agent_id: null,
            run_id: null,
            actor_id: null,
            metadata_json: '{}',
            content: 'safe content',
            content_hash: await contentHash('safe content'),
            created_at: 2,
            deleted_at: null,
          },
          {
            id: 'ownerless',
            user_id: null,
            agent_id: null,
            run_id: null,
            actor_id: null,
            metadata_json: '{}',
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
  const rows = [{
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
  }];
  const inspection = await artifactSource(rows);
  const exitCode = await main(['apply', '--confirm', 'backups/inspection.json'], {
    env: {
      CLOUDFLARE_API_TOKEN: 'cloudflare-secret',
      CLOUDFLARE_ACCOUNT_ID: 'account-1',
      DASHBOARD_PASSWORD: 'dashboard-secret',
      MEM0_BASE_URL: 'https://mem0.example',
    },
    readFileImpl: async (path) => path === 'wrangler.toml' ? TEST_WRANGLER_CONFIG : inspection,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        success: true,
        result: successfulD1Result(rows),
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
  const inspection = await artifactSource([row]);
  const exitCode = await main(['apply', '--confirm', 'backups/inspection.json'], {
    env: {
      CLOUDFLARE_API_TOKEN: 'cloudflare-secret',
      CLOUDFLARE_ACCOUNT_ID: 'account-1',
      DASHBOARD_PASSWORD: 'dashboard-secret',
      MEM0_BASE_URL: 'https://mem0.example',
    },
    readFileImpl: async (path) => path === 'wrangler.toml' ? TEST_WRANGLER_CONFIG : inspection,
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

  assert.equal(await main(['apply', '--confirm', 'backups/inspection.json'], options), 0);
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

test('an all-deleted apply waits on the final delete mutation without a Dashboard upsert', async () => {
  const row = {
    id: 'deleted-only', user_id: 'retired-user', agent_id: null,
    content: 'retired', content_hash: await contentHash('retired'),
    created_at: 1, deleted_at: 10,
  };
  const inspection = await artifactSource([row]);
  const calls = [];
  const logs = [];
  const exitCode = await main(['apply', '--confirm', 'backups/inspection.json'], {
    env: {
      CLOUDFLARE_API_TOKEN: 'cloudflare-secret', CLOUDFLARE_ACCOUNT_ID: 'account-1',
      DASHBOARD_PASSWORD: 'dashboard-secret', MEM0_BASE_URL: 'https://mem0.example',
    },
    readFileImpl: async (path) => path === 'wrangler.toml' ? TEST_WRANGLER_CONFIG : inspection,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('/d1/database/')) {
        return jsonResponse({ success: true, result: successfulD1Result([row]) });
      }
      if (url.endsWith('/dashboard/login')) {
        return new Response(null, { status: 303, headers: { 'Set-Cookie': 'session=signed; Path=/' } });
      }
      if (url.endsWith('/delete_by_ids')) {
        return jsonResponse({ success: true, result: { mutationId: '7' } });
      }
      if (url.endsWith('/info')) {
        return jsonResponse({ success: true, result: { processedUpToMutation: 7 } });
      }
      throw new Error(`unexpected request: ${url}`);
    },
    logger: { log: (message) => logs.push(message), error: assert.fail },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.filter((url) => url.endsWith('/info')).length, 1);
  assert.equal(calls.some((url) => url.includes('/reindex')), false);
  const report = JSON.parse(logs[0]).report;
  assert.equal(report.active_memories_reindexed, 0);
  assert.equal(report.last_vector_mutation_id, '7');
  assert.equal(report.vector_mutation_barrier_polls, 1);
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

      assert.equal(await main(['apply', '--confirm', 'backups/inspection.json'], options), 1);
      assert.match(errors.at(-1), new RegExp(`injected ${failurePhase}`));
      assert.equal(await main(['apply', '--confirm', 'backups/inspection.json'], options), 0);
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
      assert.ok(fake.stats.indexInfoCalls >= 1);

      const verifyLog = JSON.parse(logs.at(-1));
      assert.equal(verifyLog.command, 'verify');
      assert.equal(verifyLog.ok, true);
      assert.equal(verifyLog.report.unexpected_deleted_vector_count, 0);
      if (failurePhase === 'during-partial-reindex') {
        assert.deepEqual(fake.stats.reindexSuccesses, ['canonical', 'other']);
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
  assert.doesNotMatch(sent.batch[0].sql, /loser\.deleted_at IS NULL/i);
  assert.doesNotMatch(sent.batch[1].sql, /loser\.deleted_at IS NULL/i);
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

test('apply repairs graph references for a planned loser soft-deleted after inspect', async () => {
  const fake = await createStatefulMaintenanceFake(undefined, { loserExternallyDeleted: true });
  const logs = [];
  const errors = [];

  assert.equal(await main(
    ['apply', '--confirm', 'backups/inspection.json'],
    statefulMaintenanceOptions(fake, logs, errors),
  ), 0);
  assert.equal(fake.relationships[0].evidence_memory_id, 'canonical');
  assert.deepEqual([...fake.entityLinks.get('canonical')], ['entity-1']);
  assert.equal(fake.stats.graphAuditCalls, 1);
  assert.deepEqual(errors, []);
});

test('apply fails before vectors when planned mapping graph convergence is incomplete', async () => {
  const fake = await createStatefulMaintenanceFake(undefined, { forceIncompleteGraphAudit: true });
  const logs = [];
  const errors = [];

  assert.equal(await main(
    ['apply', '--confirm', 'backups/inspection.json'],
    statefulMaintenanceOptions(fake, logs, errors),
  ), 1);
  assert.match(errors[0], /graph convergence is incomplete.*loser/i);
  assert.deepEqual(fake.stats.vectorDeleteSubmissions, []);
  assert.deepEqual(fake.stats.reindexSuccesses, []);
  assert.deepEqual(logs, []);
});

test('deleteVectorIds uses bounded batches and preserves call order', async () => {
  const calls = [];
  const result = await deleteVectorIds({
    ids: ['a', 'b', 'c', 'd', 'e'],
    batchSize: 2,
    deleteVectors: async (ids) => {
      calls.push(ids);
      return { mutationId: `mutation-${calls.length}` };
    },
  });

  assert.deepEqual(calls, [['a', 'b'], ['c', 'd'], ['e']]);
  assert.deepEqual(result, { ids: 5, batches: 3, lastMutationId: 'mutation-3' });
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
    return jsonResponse({ ok: true, mutation_id: `mutation-${calls.length}` });
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
  assert.deepEqual(result, { reindexed: 4, lastMutationId: 'mutation-5' });
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
    return jsonResponse({ ok: true, mutation_id: `mutation-${calls.length}` });
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
  assert.deepEqual(result, { reindexed: 3, lastMutationId: 'mutation-5' });
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
        if (id === 'canonical') return [{ id, metadata: {
          scope_key: canonicalScope,
          content_hash: rows[0].content_hash,
          memory_vector_schema: '1',
        } }];
        if (id === 'duplicate') return [{ id, metadata: {
          scope_key: duplicateScope,
          content_hash: 'stale',
          memory_vector_schema: '0',
        } }];
        return [{ id, metadata: { scope_key: 'wrong', content_hash: rows[3].content_hash, memory_vector_schema: '1' } }];
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
  assert.deepEqual(result.report.wrong_content_hash_ids, ['duplicate']);
  assert.deepEqual(result.report.wrong_vector_schema_ids, ['duplicate']);
  assert.equal(result.report.unexpected_deleted_vector_count, 1);
  assert.deepEqual(result.report.unexpected_deleted_vector_ids, ['deleted-null']);
  assert.match(result.report.operator_note, /Vectorize mutations are asynchronous/);
  assert.match(result.report.operator_note, /deleted vectors may remain visible briefly/i);
});

test('verifyMemoryState succeeds when hashes, exact groups, vectors, and scope metadata are complete', async () => {
  const { vectorStateHash } = await import('../migrate-memory-deduplication.mjs');
  const row = {
    id: 'ready',
    user_id: 'u',
    agent_id: 'a',
    run_id: 'run-1',
    actor_id: 'actor-1',
    metadata_json: '{"label":"ready"}',
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
        ? [{ id: row.id, metadata: {
          scope_key: await scopeKey(row),
          content_hash: row.content_hash,
          memory_vector_schema: '1',
          vector_state_hash: await vectorStateHash(row),
        } }]
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
  assert.equal(result.report.wrong_content_hash_count, 0);
  assert.equal(result.report.wrong_vector_schema_count, 0);
  assert.equal(result.report.wrong_vector_state_hash_count, 0);
  assert.equal(result.report.unexpected_deleted_vector_count, 0);
  assert.deepEqual(result.report.unexpected_deleted_vector_ids, []);
});

test('verifyMemoryState rejects a stale full vector source hash and reports its memory ID', async () => {
  const { vectorStateHash } = await import('../migrate-memory-deduplication.mjs');
  const row = {
    id: 'stale-metadata', user_id: 'u', agent_id: null, run_id: 'run-new', actor_id: 'actor-new',
    metadata_json: '{"label":"new"}', content: 'unchanged', content_hash: await contentHash('unchanged'),
    created_at: 1, deleted_at: null,
  };
  const staleSource = { ...row, run_id: 'run-old', actor_id: 'actor-old', metadata_json: '{"label":"old"}' };
  const result = await verifyMemoryState({
    rows: [row],
    getVectors: async () => [{ id: row.id, metadata: {
      scope_key: await scopeKey(row),
      content_hash: row.content_hash,
      memory_vector_schema: '1',
      vector_state_hash: await vectorStateHash(staleSource),
    } }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.report.wrong_vector_state_hash_count, 1);
  assert.deepEqual(result.report.wrong_vector_state_hash_ids, ['stale-metadata']);
});
