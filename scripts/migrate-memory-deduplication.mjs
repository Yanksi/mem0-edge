import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  duplicateMappings,
  pendingHashUpdates,
  scopeKey,
  sha256Hex,
} from './lib/memory-deduplication.mjs';

const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_PAGE_SIZE = 50;
const MEMORY_PAGE_SIZE = 500;
const D1_BATCH_SIZE = 50;
const VECTOR_BATCH_SIZE = 100;
const VECTOR_READ_BATCH_SIZE = 20;
const VECTOR_MUTATION_TIMEOUT_MS = 2 * 60 * 1_000;
const VECTOR_MUTATION_POLL_INTERVAL_MS = 1_000;
const MEMORY_VECTOR_SCHEMA_VERSION = '1';
const INSPECTION_ARTIFACT_SCHEMA = 'memory-deduplication-inspection/v2';

export function vectorStateHash(row) {
  return sha256Hex(JSON.stringify([
    row.user_id,
    row.agent_id,
    row.run_id,
    row.actor_id,
    row.metadata_json,
    row.content_hash,
  ]));
}

export const USAGE = `Usage:
  node --env-file=.env scripts/migrate-memory-deduplication.mjs inspect
  node --env-file=.env scripts/migrate-memory-deduplication.mjs apply --confirm <inspection-artifact.json>
  node --env-file=.env scripts/migrate-memory-deduplication.mjs verify`;

class ApplyConfirmationError extends Error {}

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command === undefined) throw new Error(USAGE);
  if (!['inspect', 'apply', 'verify'].includes(command)) {
    throw new Error(`unknown command: ${command}\n${USAGE}`);
  }

  if (command === 'apply') {
    if (!rest.includes('--confirm')) throw new ApplyConfirmationError('apply requires --confirm');
    if (rest.length === 1 && rest[0] === '--confirm') {
      throw new Error(`apply requires an inspection artifact path\n${USAGE}`);
    }
    if (rest.length !== 2 || rest[0] !== '--confirm'
      || rest[1].trim() === '' || rest[1].startsWith('--')) {
      throw new Error(`unexpected arguments for apply\n${USAGE}`);
    }
    return { command, confirm: true, artifactPath: rest[1] };
  }

  if (rest.length !== 0) throw new Error(`unexpected arguments for ${command}\n${USAGE}`);
  return { command, confirm: false };
}

function tomlArrayTableBlocks(source, tableName) {
  const headers = [...source.matchAll(/^\s*\[\[([^\]]+)\]\]\s*(?:#.*)?$/gm)];
  return headers.flatMap((header, index) => {
    if (header[1].trim() !== tableName) return [];
    const start = header.index + header[0].length;
    const end = headers[index + 1]?.index ?? source.length;
    return [source.slice(start, end)];
  });
}

function tomlString(block, key) {
  const escapedKey = key.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*(?:#.*)?$`, 'm'));
  if (match === null) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new Error(`wrangler.toml: invalid quoted value for ${key}`);
  }
}

function boundTable(blocks, binding) {
  const matches = blocks.filter((block) => tomlString(block, 'binding') === binding);
  if (matches.length > 1) throw new Error(`wrangler.toml: multiple entries use binding "${binding}"`);
  return matches[0];
}

export function parseWranglerConfig(source) {
  const d1Block = boundTable(tomlArrayTableBlocks(source, 'd1_databases'), 'DB');
  const databaseId = d1Block === undefined ? undefined : tomlString(d1Block, 'database_id');
  if (databaseId === undefined || databaseId.trim() === '') {
    throw new Error('wrangler.toml: missing d1_databases binding "DB" database_id');
  }

  const vectorizeBlock = boundTable(tomlArrayTableBlocks(source, 'vectorize'), 'VECTORIZE');
  const vectorizeIndexName = vectorizeBlock === undefined
    ? undefined
    : tomlString(vectorizeBlock, 'index_name');
  if (vectorizeIndexName === undefined || vectorizeIndexName.trim() === '') {
    throw new Error('wrangler.toml: missing vectorize binding "VECTORIZE" index_name');
  }

  return { databaseId, vectorizeIndexName };
}

export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('MEM0_BASE_URL must be a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('MEM0_BASE_URL must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('MEM0_BASE_URL must not contain credentials');
  }
  url.search = '';
  url.hash = '';
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

export function validateEnvironment(env) {
  const required = ['CLOUDFLARE_API_TOKEN', 'DASHBOARD_PASSWORD', 'MEM0_BASE_URL'];
  const missing = required.filter((name) => typeof env[name] !== 'string' || env[name].trim() === '');
  if (missing.length > 0) {
    throw new Error(`missing required environment variables: ${missing.join(', ')}`);
  }
  return {
    token: env.CLOUDFLARE_API_TOKEN,
    dashboardPassword: env.DASHBOARD_PASSWORD,
    mem0BaseUrl: normalizeBaseUrl(env.MEM0_BASE_URL),
    accountId: typeof env.CLOUDFLARE_ACCOUNT_ID === 'string' && env.CLOUDFLARE_ACCOUNT_ID.trim() !== ''
      ? env.CLOUDFLARE_ACCOUNT_ID.trim()
      : undefined,
  };
}

function redact(value, secrets) {
  let safe = String(value);
  for (const secret of secrets) {
    if (secret !== '') safe = safe.replaceAll(secret, '[redacted]');
  }
  return safe;
}

function envelopeError(envelope, secrets) {
  const first = Array.isArray(envelope?.errors) ? envelope.errors[0] : undefined;
  if (first === undefined) return '';
  const code = first.code === undefined ? '' : ` ${first.code}`;
  const message = first.message === undefined ? '' : `: ${first.message}`;
  return redact(`${code}${message}`, secrets);
}

export function createCloudflareClient({
  token,
  fetchImpl,
  apiBaseUrl = CLOUDFLARE_API_BASE_URL,
}) {
  const baseUrl = apiBaseUrl.replace(/\/+$/, '');

  async function request(operation, path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(`${operation} failed: ${redact(error?.message ?? 'network error', [token])}`);
    }

    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new Error(`${operation} failed: HTTP ${response.status} returned invalid JSON`);
    }

    const detail = envelopeError(envelope, [token]);
    if (!response.ok) {
      throw new Error(`${operation} failed: HTTP ${response.status}${detail}`);
    }
    if (envelope === null || typeof envelope !== 'object' || envelope.success !== true) {
      throw new Error(`${operation} failed: Cloudflare API reported failure${detail}`);
    }
    return envelope;
  }

  return {
    async listAccounts(page, perPage) {
      const envelope = await request(
        'Cloudflare account discovery',
        `/accounts?page=${page}&per_page=${perPage}`,
      );
      if (!Array.isArray(envelope.result)) {
        throw new Error('Cloudflare account discovery failed: invalid result');
      }
      return { accounts: envelope.result, resultInfo: envelope.result_info };
    },

    async queryD1(accountId, databaseId, body) {
      const envelope = await request(
        'D1 query',
        `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
        { method: 'POST', body },
      );
      if (!Array.isArray(envelope.result)) throw new Error('D1 query failed: invalid result');
      envelope.result.forEach((result, index) => {
        if (result?.success !== true) {
          throw new Error(`D1 query result ${index + 1} reported failure`);
        }
      });
      return envelope.result;
    },

    async deleteVectors(accountId, indexName, ids) {
      const envelope = await request(
        'Vectorize delete_by_ids',
        `/accounts/${encodeURIComponent(accountId)}/vectorize/v2/indexes/${encodeURIComponent(indexName)}/delete_by_ids`,
        { method: 'POST', body: { ids } },
      );
      if (typeof envelope.result?.mutationId !== 'string' || envelope.result.mutationId === '') {
        throw new Error('Vectorize delete_by_ids failed: invalid mutation result');
      }
      return { mutationId: envelope.result.mutationId };
    },

    async getVectorIndexInfo(accountId, indexName) {
      const envelope = await request(
        'Vectorize index info',
        `/accounts/${encodeURIComponent(accountId)}/vectorize/v2/indexes/${encodeURIComponent(indexName)}/info`,
      );
      const processed = envelope.result?.processedUpToMutation;
      if (!((typeof processed === 'number' && Number.isFinite(processed))
        || (typeof processed === 'string' && processed !== ''))) {
        throw new Error('Vectorize index info failed: invalid index info');
      }
      return { processedUpToMutation: processed };
    },

    async getVectors(accountId, indexName, ids) {
      const envelope = await request(
        'Vectorize get_by_ids',
        `/accounts/${encodeURIComponent(accountId)}/vectorize/v2/indexes/${encodeURIComponent(indexName)}/get_by_ids`,
        { method: 'POST', body: { ids } },
      );
      if (!Array.isArray(envelope.result)) {
        throw new Error('Vectorize get_by_ids failed: invalid result');
      }
      return envelope.result;
    },
  };
}

export async function listCloudflareAccounts(client) {
  const accounts = [];
  for (let page = 1; page <= 1_000; page += 1) {
    const response = await client.listAccounts(page, ACCOUNT_PAGE_SIZE);
    accounts.push(...response.accounts);
    const totalPages = Number(response.resultInfo?.total_pages);
    if ((Number.isFinite(totalPages) && page >= totalPages) || response.accounts.length < ACCOUNT_PAGE_SIZE) {
      return accounts;
    }
  }
  throw new Error('Cloudflare account discovery exceeded 1000 pages');
}

export async function resolveAccountId(explicitAccountId, client) {
  if (explicitAccountId !== undefined) return explicitAccountId;
  const accounts = await listCloudflareAccounts(client);
  if (accounts.length !== 1 || typeof accounts[0]?.id !== 'string' || accounts[0].id === '') {
    throw new Error(`Cloudflare token can access ${accounts.length} accounts; set CLOUDFLARE_ACCOUNT_ID explicitly`);
  }
  return accounts[0].id;
}

function d1Rows(queryResults) {
  return queryResults.flatMap((result) => {
    if (result.results === undefined) return [];
    if (!Array.isArray(result.results)) throw new Error('D1 query failed: invalid rows');
    return result.results;
  });
}

export async function pageAllMemories(queryD1, pageSize = MEMORY_PAGE_SIZE) {
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error('memory page size must be positive');
  const rows = [];
  let cursor;

  while (true) {
    const body = cursor === undefined
      ? {
          sql: `
            SELECT id, user_id, agent_id, run_id, actor_id, metadata_json,
              content, content_hash, created_at, deleted_at
            FROM memories
            ORDER BY created_at ASC, id ASC
            LIMIT ?
          `,
          params: [pageSize],
        }
      : {
          sql: `
            SELECT id, user_id, agent_id, run_id, actor_id, metadata_json,
              content, content_hash, created_at, deleted_at
            FROM memories
            WHERE created_at > ? OR (created_at = ? AND id > ?)
            ORDER BY created_at ASC, id ASC
            LIMIT ?
          `,
          params: [cursor.created_at, cursor.created_at, cursor.id, pageSize],
        };
    const page = d1Rows(await queryD1(body));
    if (page.length > pageSize) throw new Error('D1 memory page exceeded requested limit');
    rows.push(...page);
    if (page.length < pageSize) return rows;

    const nextCursor = page.at(-1);
    if (typeof nextCursor?.id !== 'string' || nextCursor.created_at === undefined) {
      throw new Error('D1 memory page has an invalid pagination cursor');
    }
    if (cursor !== undefined
      && Number(nextCursor.created_at) === Number(cursor.created_at)
      && nextCursor.id === cursor.id) {
      throw new Error('D1 memory pagination cursor did not advance');
    }
    cursor = { id: nextCursor.id, created_at: nextCursor.created_at };
  }
}

function chunks(values, size) {
  if (!Number.isInteger(size) || size <= 0) throw new Error('batch size must be positive');
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

export async function applyHashUpdates({
  rows,
  updates,
  queryD1,
  batchSize = D1_BATCH_SIZE,
}) {
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const batches = chunks(updates, batchSize);

  for (const batch of batches) {
    await queryD1({
      batch: batch.map((update) => {
        const row = rowsById.get(update.id);
        if (row === undefined) throw new Error(`hash update row not found: ${update.id}`);
        return {
          sql: `
            UPDATE memories
            SET content_hash = ?
            WHERE id = ? AND content = ? AND content_hash IS NOT ?
          `,
          params: [update.contentHash, update.id, row.content, update.contentHash],
        };
      }),
    });
  }
  return { attempted: updates.length, batches: batches.length };
}

const EXACT_PAIR_GUARD = `
  EXISTS (
    SELECT 1
    FROM memories AS canonical
    JOIN memories AS loser
      ON canonical.user_id IS loser.user_id
      AND canonical.agent_id IS loser.agent_id
      AND canonical.content_hash IS loser.content_hash
      AND canonical.content = loser.content
    WHERE canonical.id = ?
      AND loser.id = ?
      AND canonical.deleted_at IS NULL
  )
`;

export async function cleanupDuplicate({ mapping, queryD1 }) {
  const { canonicalId, loserId } = mapping;
  const results = await queryD1({
    batch: [
      {
        sql: `
          INSERT OR IGNORE INTO memory_entity_links (memory_id, entity_id, created_at)
          SELECT ?, links.entity_id, links.created_at
          FROM memory_entity_links AS links
          WHERE links.memory_id = ?
            AND ${EXACT_PAIR_GUARD}
        `,
        params: [canonicalId, loserId, canonicalId, loserId],
      },
      {
        sql: `
          UPDATE relationships
          SET evidence_memory_id = ?
          WHERE evidence_memory_id = ?
            AND ${EXACT_PAIR_GUARD}
        `,
        params: [canonicalId, loserId, canonicalId, loserId],
      },
      {
        sql: `
          UPDATE memories AS loser
          SET deleted_at = unixepoch()
          WHERE loser.id = ?
            AND loser.deleted_at IS NULL
            AND EXISTS (
              SELECT 1
              FROM memories AS canonical
              WHERE canonical.id = ?
                AND canonical.deleted_at IS NULL
                AND canonical.user_id IS loser.user_id
                AND canonical.agent_id IS loser.agent_id
                AND canonical.content_hash IS loser.content_hash
                AND canonical.content = loser.content
            )
          RETURNING id
        `,
        params: [loserId, canonicalId],
      },
    ],
  });
  const deletedRows = results[2]?.results;
  return Array.isArray(deletedRows) && deletedRows.some((row) => row?.id === loserId);
}

export async function verifyGraphConvergence({
  mappings,
  queryD1,
  batchSize = D1_BATCH_SIZE,
}) {
  const incomplete = [];
  for (const batch of chunks(mappings, batchSize)) {
    const results = await queryD1({
      batch: batch.map(({ canonicalId, loserId }) => ({
        sql: `
          SELECT ? AS canonical_id, ? AS loser_id,
            (SELECT COUNT(*) FROM relationships
              WHERE evidence_memory_id = ?) AS relationship_evidence_count,
            (SELECT COUNT(*)
              FROM memory_entity_links AS loser_link
              WHERE loser_link.memory_id = ?
                AND NOT EXISTS (
                  SELECT 1
                  FROM memory_entity_links AS canonical_link
                  WHERE canonical_link.memory_id = ?
                    AND canonical_link.entity_id = loser_link.entity_id
                )) AS missing_canonical_link_count
        `,
        params: [canonicalId, loserId, loserId, loserId, canonicalId],
      })),
    });
    if (!Array.isArray(results) || results.length !== batch.length) {
      throw new Error('graph convergence audit returned invalid D1 results');
    }
    for (let index = 0; index < batch.length; index += 1) {
      const mapping = batch[index];
      const rows = results[index]?.results;
      const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
      const relationshipEvidenceCount = Number(row?.relationship_evidence_count);
      const missingCanonicalLinkCount = Number(row?.missing_canonical_link_count);
      if (row?.canonical_id !== mapping.canonicalId
        || row?.loser_id !== mapping.loserId
        || !Number.isInteger(relationshipEvidenceCount) || relationshipEvidenceCount < 0
        || !Number.isInteger(missingCanonicalLinkCount) || missingCanonicalLinkCount < 0) {
        throw new Error(`graph convergence audit returned invalid state for planned loser ${mapping.loserId}`);
      }
      if (relationshipEvidenceCount > 0 || missingCanonicalLinkCount > 0) {
        incomplete.push({
          ...mapping,
          relationshipEvidenceCount,
          missingCanonicalLinkCount,
        });
      }
    }
  }
  return { ok: incomplete.length === 0, incomplete };
}

export async function deleteVectorIds({
  ids,
  deleteVectors,
  batchSize = VECTOR_BATCH_SIZE,
}) {
  const uniqueIds = [...new Set(ids)];
  const batches = chunks(uniqueIds, batchSize);
  let lastMutationId = null;
  for (const batch of batches) {
    const result = await deleteVectors(batch);
    if (typeof result?.mutationId !== 'string' || result.mutationId === '') {
      throw new Error('Vectorize delete_by_ids returned an invalid mutation ID');
    }
    lastMutationId = result.mutationId;
  }
  return { ids: uniqueIds.length, batches: batches.length, lastMutationId };
}

export async function waitForVectorMutation({
  mutationId,
  getIndexInfo,
  timeoutMs = VECTOR_MUTATION_TIMEOUT_MS,
  pollIntervalMs = VECTOR_MUTATION_POLL_INTERVAL_MS,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
}) {
  if (typeof mutationId !== 'string' || mutationId === '') throw new Error('Vectorize mutation ID is invalid');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Vectorize mutation timeout is invalid');
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('Vectorize mutation poll interval is invalid');
  const startedAt = now();
  let polls = 0;
  while (true) {
    if (polls > 0 && now() - startedAt >= timeoutMs) {
      throw new Error(`timed out waiting for Vectorize mutation ${mutationId}`);
    }
    const info = await getIndexInfo();
    polls += 1;
    if (String(info?.processedUpToMutation) === mutationId) return { mutationId, polls };
    const remainingMs = timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) {
      throw new Error(`timed out waiting for Vectorize mutation ${mutationId}`);
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

export async function loginDashboard({ baseUrl, password, fetchImpl, secrets = [] }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  let response;
  try {
    response = await fetchImpl(`${normalizedBaseUrl}/dashboard/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password }).toString(),
      redirect: 'manual',
    });
  } catch (error) {
    throw new Error(`Dashboard login failed: ${redact(error?.message ?? 'network error', [password, ...secrets])}`);
  }
  if (response.status !== 303) throw new Error(`Dashboard login failed: HTTP ${response.status}`);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (cookie === undefined || !cookie.includes('=')) {
    throw new Error('Dashboard login failed: session cookie missing');
  }
  return cookie;
}

function dashboardScope(row) {
  if (typeof row.user_id === 'string' && row.user_id.trim() !== '') {
    return { entity_type: 'user', entity_id: row.user_id };
  }
  if (typeof row.agent_id === 'string' && row.agent_id.trim() !== '') {
    return { entity_type: 'agent', entity_id: row.agent_id };
  }
  throw new Error(`active memory ${row.id} has no Dashboard-reindexable owner`);
}

function unreindexableActiveMemoryIds(rows) {
  return rows
    .filter((row) => row.deleted_at === null)
    .filter((row) => {
      try {
        dashboardScope(row);
        return false;
      } catch {
        return true;
      }
    })
    .map((row) => row.id);
}

export async function reindexActiveMemories({ rows, baseUrl, session, password, fetchImpl }) {
  const activeRows = rows.filter((row) => row.deleted_at === null);
  const requests = activeRows.map((row) => ({ row, scope: dashboardScope(row) }));
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const secrets = new Set([password, session.cookie]);

  const requestReindex = async (row, scope) => {
    try {
      return await fetchImpl(
        `${normalizedBaseUrl}/dashboard/api/memories/${encodeURIComponent(row.id)}/reindex`,
        {
          method: 'POST',
          headers: { Cookie: session.cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify(scope),
        },
      );
    } catch (error) {
      throw new Error(
        `Dashboard reindex failed for memory ${row.id}: ${redact(error?.message ?? 'network error', secrets)}`,
      );
    }
  };

  let lastMutationId = null;
  for (const { row, scope } of requests) {
    let response = await requestReindex(row, scope);
    if (response.status === 401) {
      secrets.add(session.cookie);
      session.cookie = await loginDashboard({
        baseUrl: normalizedBaseUrl,
        password,
        fetchImpl,
        secrets,
      });
      secrets.add(session.cookie);
      response = await requestReindex(row, scope);
    }
    if (!response.ok) {
      throw new Error(`Dashboard reindex failed for memory ${row.id}: HTTP ${response.status}`);
    }
    const body = await response.json().catch(() => null);
    if (body?.ok !== true || typeof body.mutation_id !== 'string' || body.mutation_id === '') {
      throw new Error(`Dashboard reindex failed for memory ${row.id}: invalid response`);
    }
    lastMutationId = body.mutation_id;
  }
  return { reindexed: requests.length, lastMutationId };
}

async function vectorMapForRows({ rows, getVectors, vectorBatchSize }) {
  const vectors = [];
  for (const batch of chunks(rows.map((row) => row.id), vectorBatchSize)) {
    const result = await getVectors(batch);
    if (!Array.isArray(result)) throw new Error('Vectorize get_by_ids returned invalid vectors');
    vectors.push(...result);
  }
  return new Map(vectors.map((vector) => [vector.id, vector]));
}

async function vectorMatchesRow(vector, row) {
  return vector?.metadata?.scope_key === await scopeKey(row)
    && vector.metadata.content_hash === row.content_hash
    && vector.metadata.memory_vector_schema === MEMORY_VECTOR_SCHEMA_VERSION
    && vector.metadata.vector_state_hash === await vectorStateHash(row);
}

export async function pendingReindexRows({
  rows,
  getVectors,
  vectorBatchSize = VECTOR_READ_BATCH_SIZE,
}) {
  const activeRows = rows.filter((row) => row.deleted_at === null);
  const vectorsById = await vectorMapForRows({ rows: activeRows, getVectors, vectorBatchSize });
  const pending = [];
  for (const row of activeRows) {
    if (!await vectorMatchesRow(vectorsById.get(row.id), row)) pending.push(row);
  }
  return pending;
}

export async function verifyMemoryState({
  rows,
  getVectors,
  vectorBatchSize = VECTOR_READ_BATCH_SIZE,
}) {
  const hashUpdates = await pendingHashUpdates(rows);
  const updateIds = new Set(hashUpdates.map(({ id }) => id));
  const nullHashIds = rows.filter((row) => row.content_hash === null).map((row) => row.id);
  const mismatchedHashIds = rows
    .filter((row) => row.content_hash !== null && updateIds.has(row.id))
    .map((row) => row.id);
  const duplicates = duplicateMappings(rows);
  const duplicateGroupCount = new Set(duplicates.map(({ canonicalId }) => canonicalId)).size;
  const activeRows = rows.filter((row) => row.deleted_at === null);
  const deletedRows = rows.filter((row) => row.deleted_at !== null);
  const vectorsById = await vectorMapForRows({ rows: activeRows, getVectors, vectorBatchSize });
  const deletedVectors = [];
  for (const batch of chunks(deletedRows.map((row) => row.id), vectorBatchSize)) {
    const result = await getVectors(batch);
    if (!Array.isArray(result)) throw new Error('Vectorize get_by_ids returned invalid vectors');
    deletedVectors.push(...result);
  }
  const missingVectorIds = [];
  const wrongScopeKeyIds = [];
  const wrongContentHashIds = [];
  const wrongVectorSchemaIds = [];
  const wrongVectorStateHashIds = [];
  for (const row of activeRows) {
    const vector = vectorsById.get(row.id);
    if (vector === undefined) {
      missingVectorIds.push(row.id);
      continue;
    }
    if (vector.metadata?.scope_key !== await scopeKey(row)) wrongScopeKeyIds.push(row.id);
    if (vector.metadata?.content_hash !== row.content_hash) wrongContentHashIds.push(row.id);
    if (vector.metadata?.memory_vector_schema !== MEMORY_VECTOR_SCHEMA_VERSION) wrongVectorSchemaIds.push(row.id);
    if (vector.metadata?.vector_state_hash !== await vectorStateHash(row)) wrongVectorStateHashIds.push(row.id);
  }
  const returnedDeletedIds = new Set(deletedVectors.map((vector) => vector.id));
  const unexpectedDeletedVectorIds = deletedRows
    .filter((row) => returnedDeletedIds.has(row.id))
    .map((row) => row.id);

  const report = {
    row_count: rows.length,
    active_memory_count: activeRows.length,
    hash_issue_count: hashUpdates.length,
    null_hash_ids: nullHashIds,
    mismatched_hash_ids: mismatchedHashIds,
    active_duplicate_group_count: duplicateGroupCount,
    active_duplicate_mapping_count: duplicates.length,
    active_duplicate_mappings: duplicates,
    missing_active_vector_count: missingVectorIds.length,
    missing_active_vector_ids: missingVectorIds,
    wrong_scope_key_count: wrongScopeKeyIds.length,
    wrong_scope_key_ids: wrongScopeKeyIds,
    wrong_content_hash_count: wrongContentHashIds.length,
    wrong_content_hash_ids: wrongContentHashIds,
    wrong_vector_schema_count: wrongVectorSchemaIds.length,
    wrong_vector_schema_ids: wrongVectorSchemaIds,
    wrong_vector_state_hash_count: wrongVectorStateHashIds.length,
    wrong_vector_state_hash_ids: wrongVectorStateHashIds,
    unexpected_deleted_vector_count: unexpectedDeletedVectorIds.length,
    unexpected_deleted_vector_ids: unexpectedDeletedVectorIds,
    operator_note: 'Vectorize mutations are asynchronous; deleted vectors may remain visible briefly. If verification follows apply immediately and fails, wait briefly and rerun verify.',
  };
  return {
    ok: report.hash_issue_count === 0
      && report.active_duplicate_group_count === 0
      && report.missing_active_vector_count === 0
      && report.wrong_scope_key_count === 0
      && report.wrong_content_hash_count === 0
      && report.wrong_vector_schema_count === 0
      && report.wrong_vector_state_hash_count === 0
      && report.unexpected_deleted_vector_count === 0,
    report,
  };
}

async function inspectionPlan(rows) {
  const hashUpdates = await pendingHashUpdates(rows);
  const updatesById = new Map(hashUpdates.map((update) => [update.id, update.contentHash]));
  const plannedRows = rows.map((row) => ({
    ...row,
    content_hash: updatesById.get(row.id) ?? row.content_hash,
  }));
  const duplicates = duplicateMappings(plannedRows);
  const activeRows = rows.filter((row) => row.deleted_at === null);
  const duplicateLoserIds = duplicates.map(({ loserId }) => loserId);
  const unreindexableIds = unreindexableActiveMemoryIds(rows);
  return {
    row_count: rows.length,
    active_row_count: activeRows.length,
    deleted_row_count: rows.length - activeRows.length,
    pending_hash_update_count: hashUpdates.length,
    pending_hash_updates: hashUpdates,
    active_duplicate_mapping_count: duplicates.length,
    active_duplicate_mappings: duplicates,
    active_duplicate_loser_count: duplicateLoserIds.length,
    active_duplicate_loser_ids: duplicateLoserIds,
    unreindexable_active_memory_count: unreindexableIds.length,
    unreindexable_active_memory_ids: unreindexableIds,
    active_reindex_count: activeRows.length,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function artifactTarget(config) {
  return {
    account_id: config.accountId,
    database_id: config.databaseId,
    vectorize_index_name: config.vectorizeIndexName,
    mem0_base_url: config.mem0BaseUrl,
  };
}

function artifactPayload(artifact) {
  const payload = { ...artifact };
  delete payload.integrity;
  return payload;
}

export async function createInspectionArtifact({ rows, config, createdAt }) {
  validateArtifactRows(rows);
  const report = await inspectionPlan(rows);
  const payload = {
    artifact_schema: INSPECTION_ARTIFACT_SCHEMA,
    created_at: createdAt.toISOString(),
    target: artifactTarget(config),
    rows,
    mappings: report.active_duplicate_mappings,
    report,
  };
  return {
    ...payload,
    integrity: {
      algorithm: 'sha256',
      fingerprint: await sha256Hex(canonicalJson(payload)),
    },
  };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateArtifactRows(rows) {
  if (!Array.isArray(rows)) throw new Error('inspection artifact rows are invalid');
  const ids = new Set();
  for (const row of rows) {
    const valid = isRecord(row)
      && typeof row.id === 'string' && row.id !== ''
      && (row.user_id === null || typeof row.user_id === 'string')
      && (row.agent_id === null || typeof row.agent_id === 'string')
      && (row.run_id === null || typeof row.run_id === 'string')
      && (row.actor_id === null || typeof row.actor_id === 'string')
      && typeof row.metadata_json === 'string'
      && typeof row.content === 'string'
      && (row.content_hash === null || typeof row.content_hash === 'string')
      && Number.isFinite(Number(row.created_at))
      && (row.deleted_at === null || Number.isFinite(Number(row.deleted_at)));
    if (!valid) throw new Error('inspection artifact rows are invalid');
    if (ids.has(row.id)) throw new Error(`inspection artifact contains duplicate memory ${row.id}`);
    ids.add(row.id);
  }
}

export async function validateInspectionArtifact(source, config) {
  let artifact;
  try {
    artifact = JSON.parse(source);
  } catch {
    throw new Error('inspection artifact contains invalid JSON');
  }
  if (!isRecord(artifact) || artifact.artifact_schema !== INSPECTION_ARTIFACT_SCHEMA) {
    throw new Error('inspection artifact schema is unsupported');
  }
  if (!isRecord(artifact.integrity) || artifact.integrity.algorithm !== 'sha256'
    || typeof artifact.integrity.fingerprint !== 'string') {
    throw new Error('inspection artifact integrity metadata is invalid');
  }
  const fingerprint = await sha256Hex(canonicalJson(artifactPayload(artifact)));
  if (fingerprint !== artifact.integrity.fingerprint) {
    throw new Error('inspection artifact integrity fingerprint mismatch');
  }
  if (canonicalJson(artifact.target) !== canonicalJson(artifactTarget(config))) {
    throw new Error('inspection artifact target does not match current configuration');
  }
  if (typeof artifact.created_at !== 'string' || Number.isNaN(Date.parse(artifact.created_at))) {
    throw new Error('inspection artifact created_at is invalid');
  }
  validateArtifactRows(artifact.rows);
  const expectedReport = await inspectionPlan(artifact.rows);
  if (canonicalJson(artifact.report) !== canonicalJson(expectedReport)
    || canonicalJson(artifact.mappings) !== canonicalJson(expectedReport.active_duplicate_mappings)) {
    throw new Error('inspection artifact plan does not match its rows');
  }
  return artifact;
}

export async function validateApplyState(artifact, currentRows) {
  validateArtifactRows(currentRows);
  const inspectedById = new Map(artifact.rows.map((row) => [row.id, row]));
  const currentById = new Map(currentRows.map((row) => [row.id, row]));
  for (const row of currentRows) {
    if (!inspectedById.has(row.id)) throw new Error(`inspection artifact state has new memory ${row.id}`);
  }
  for (const row of artifact.rows) {
    if (!currentById.has(row.id)) throw new Error(`inspection artifact state is missing memory ${row.id}`);
  }

  const updates = artifact.report.pending_hash_updates;
  const updatesById = new Map(updates.map((update) => [update.id, update.contentHash]));
  const loserIds = new Set(artifact.mappings.map(({ loserId }) => loserId));
  for (const inspected of artifact.rows) {
    const current = currentById.get(inspected.id);
    for (const field of [
      'user_id', 'agent_id', 'run_id', 'actor_id', 'metadata_json', 'content', 'created_at',
    ]) {
      if (current[field] !== inspected[field]) {
        throw new Error(`inspection artifact state memory ${inspected.id} changed ${field}`);
      }
    }
    const plannedHash = updatesById.get(inspected.id);
    if (current.content_hash !== inspected.content_hash
      && (plannedHash === undefined || current.content_hash !== plannedHash)) {
      throw new Error(`inspection artifact state memory ${inspected.id} has an unplanned content_hash`);
    }
    if (inspected.deleted_at !== null) {
      if (current.deleted_at !== inspected.deleted_at) {
        throw new Error(`inspection artifact state memory ${inspected.id} has an unplanned deletion transition`);
      }
    } else if (current.deleted_at !== null && !loserIds.has(inspected.id)) {
      throw new Error(`inspection artifact state memory ${inspected.id} has an unplanned deletion transition`);
    }
  }

  let foundPendingHash = false;
  for (const update of updates) {
    const current = currentById.get(update.id);
    const inspected = inspectedById.get(update.id);
    if (current.content_hash === inspected.content_hash) {
      foundPendingHash = true;
    } else if (foundPendingHash) {
      throw new Error('inspection artifact state has unreachable hash commit ordering');
    }
  }
  let foundPendingDelete = false;
  let hasCommittedDelete = false;
  for (const mapping of artifact.mappings) {
    const current = currentById.get(mapping.loserId);
    const committed = current.deleted_at !== null;
    if (!committed) foundPendingDelete = true;
    else {
      hasCommittedDelete = true;
      if (foundPendingDelete) throw new Error('inspection artifact state has unreachable deletion ordering');
    }
  }
  if (hasCommittedDelete && updates.some((update) => (
    currentById.get(update.id).content_hash !== update.contentHash
  ))) {
    throw new Error('inspection artifact state deleted a loser before hash backfill completed');
  }
}

function safeTimestamp(date) {
  return date.toISOString().replaceAll(':', '-');
}

async function writeInspectionBackup({ rows, report, config, now, mkdirImpl, writeFileImpl }) {
  const directory = 'backups';
  await mkdirImpl(directory, { recursive: true });
  const path = join(directory, `memory-deduplication-${safeTimestamp(now)}.json`);
  const backup = await createInspectionArtifact({ rows, config, createdAt: now });
  await writeFileImpl(path, `${JSON.stringify(backup, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return path;
}

async function loadRuntime({ env, fetchImpl, readFileImpl }) {
  const secrets = validateEnvironment(env);
  const wranglerConfig = parseWranglerConfig(await readFileImpl('wrangler.toml', 'utf8'));
  const client = createCloudflareClient({ token: secrets.token, fetchImpl });
  const accountId = await resolveAccountId(secrets.accountId, client);
  const config = {
    accountId,
    databaseId: wranglerConfig.databaseId,
    vectorizeIndexName: wranglerConfig.vectorizeIndexName,
    mem0BaseUrl: secrets.mem0BaseUrl,
  };
  return { client, config, dashboardPassword: secrets.dashboardPassword };
}

export async function runCommand(parsed, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
  now = () => new Date(),
  logger = console,
} = {}) {
  const runtime = await loadRuntime({ env, fetchImpl, readFileImpl });
  const { client, config } = runtime;
  const queryD1 = (body) => client.queryD1(config.accountId, config.databaseId, body);
  const getVectors = (ids) => client.getVectors(config.accountId, config.vectorizeIndexName, ids);
  const deleteVectors = (ids) => client.deleteVectors(config.accountId, config.vectorizeIndexName, ids);
  const getIndexInfo = () => client.getVectorIndexInfo(config.accountId, config.vectorizeIndexName);

  if (parsed.command === 'inspect') {
    const rows = await pageAllMemories(queryD1);
    const report = await inspectionPlan(rows);
    const createdAt = now();
    const backupPath = await writeInspectionBackup({
      rows,
      report,
      config,
      now: createdAt,
      mkdirImpl,
      writeFileImpl,
    });
    logger.log(JSON.stringify({ command: 'inspect', backup_path: backupPath, report }, null, 2));
    return 0;
  }

  if (parsed.command === 'verify') {
    const rows = await pageAllMemories(queryD1);
    const result = await verifyMemoryState({ rows, getVectors });
    logger.log(JSON.stringify({ command: 'verify', ok: result.ok, report: result.report }, null, 2));
    return result.ok ? 0 : 1;
  }

  const artifact = await validateInspectionArtifact(
    await readFileImpl(parsed.artifactPath, 'utf8'),
    config,
  );
  const initialRows = await pageAllMemories(queryD1);
  await validateApplyState(artifact, initialRows);
  const unreindexableIds = unreindexableActiveMemoryIds(initialRows);
  if (unreindexableIds.length > 0) {
    const memoryLabel = unreindexableIds.length === 1 ? 'memory' : 'memories';
    throw new Error(
      `apply preflight found ${unreindexableIds.length} unreindexable active ${memoryLabel}: ${unreindexableIds.join(', ')}`,
    );
  }
  const session = {
    cookie: await loginDashboard({
      baseUrl: config.mem0BaseUrl,
      password: runtime.dashboardPassword,
      fetchImpl,
    }),
  };
  const initialRowsById = new Map(initialRows.map((row) => [row.id, row]));
  const hashUpdates = artifact.report.pending_hash_updates.filter((update) => (
    initialRowsById.get(update.id).content_hash !== update.contentHash
  ));
  const hashResult = await applyHashUpdates({
    rows: initialRows,
    updates: hashUpdates,
    queryD1,
  });

  const hashedRows = await pageAllMemories(queryD1);
  await validateApplyState(artifact, hashedRows);
  const remainingHashUpdates = artifact.report.pending_hash_updates.filter((update) => (
    hashedRows.find((row) => row.id === update.id).content_hash !== update.contentHash
  ));
  if (remainingHashUpdates.length > 0) {
    throw new Error(`hash backfill is incomplete for ${remainingHashUpdates.length} rows; rerun apply --confirm`);
  }

  const mappings = artifact.mappings;
  const decisiveLoserIds = [];
  for (const mapping of mappings) {
    if (await cleanupDuplicate({ mapping, queryD1 })) decisiveLoserIds.push(mapping.loserId);
  }

  const finalRows = await pageAllMemories(queryD1);
  await validateApplyState(artifact, finalRows);
  const remainingMappings = duplicateMappings(finalRows);
  if (remainingMappings.length > 0) {
    throw new Error(`duplicate cleanup is incomplete for ${remainingMappings.length} rows; rerun apply --confirm`);
  }
  const graphConvergence = await verifyGraphConvergence({ mappings, queryD1 });
  if (!graphConvergence.ok) {
    const staleIds = graphConvergence.incomplete.map(({ loserId }) => loserId);
    throw new Error(
      `graph convergence is incomplete for ${staleIds.length} planned loser(s): ${staleIds.join(', ')}`,
    );
  }

  const deletedVectorIds = finalRows
    .filter((row) => row.deleted_at !== null)
    .map((row) => row.id);
  const vectorDeleteResult = await deleteVectorIds({ ids: deletedVectorIds, deleteVectors });
  const activeRows = finalRows.filter((row) => row.deleted_at === null);
  const pendingReindex = await pendingReindexRows({ rows: activeRows, getVectors });
  let reindexResult = { reindexed: 0, lastMutationId: null };
  if (pendingReindex.length > 0) {
    reindexResult = await reindexActiveMemories({
      rows: pendingReindex,
      baseUrl: config.mem0BaseUrl,
      session,
      password: runtime.dashboardPassword,
      fetchImpl,
    });
  }
  const lastMutationId = reindexResult.lastMutationId ?? vectorDeleteResult.lastMutationId;
  const mutationBarrier = lastMutationId === null
    ? null
    : await waitForVectorMutation({ mutationId: lastMutationId, getIndexInfo });

  const report = {
    initial_row_count: initialRows.length,
    hash_updates_attempted: hashResult.attempted,
    hash_update_batches: hashResult.batches,
    duplicate_mappings_planned: mappings.length,
    duplicates_decisively_merged: decisiveLoserIds.length,
    graph_mappings_verified: mappings.length,
    deleted_vector_ids_submitted: vectorDeleteResult.ids,
    vector_delete_batches: vectorDeleteResult.batches,
    active_memories_already_converged: activeRows.length - pendingReindex.length,
    active_memories_reindexed: reindexResult.reindexed,
    last_vector_mutation_id: lastMutationId,
    vector_mutation_barrier_polls: mutationBarrier?.polls ?? 0,
  };
  logger.log(JSON.stringify({ command: 'apply', ok: true, report }, null, 2));
  return 0;
}

export async function main(argv = process.argv.slice(2), options = {}) {
  let parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    (options.logger ?? console).error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    return await runCommand(parsed, options);
  } catch (error) {
    (options.logger ?? console).error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const entryUrl = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (entryUrl === import.meta.url) process.exitCode = await main();
