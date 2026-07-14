import type { Env } from '../env';
import type { MemoryResponse } from '../memory/types';

const PAGE_SIZE = 50;

export type DashboardEntityType = 'user' | 'agent';

export interface DashboardEntity {
  entity_type: DashboardEntityType;
  entity_id: string;
  alias?: string;
  memory_count: number;
}

export interface DashboardMemoryPage {
  results: MemoryResponse[];
  next_offset?: number;
}

export interface DashboardDeduplicationSummary {
  duplicate_groups: number;
  removable_memories: number;
  previews: Array<{ memory: string; duplicate_count: number }>;
}

export async function listDashboardUsers(env: Env): Promise<DashboardEntity[]> {
  const query = `
    WITH scopes AS (
      SELECT DISTINCT 'user' AS entity_type, user_id AS entity_id FROM memories WHERE deleted_at IS NULL AND user_id IS NOT NULL
      UNION SELECT DISTINCT 'agent' AS entity_type, agent_id AS entity_id FROM memories WHERE deleted_at IS NULL AND agent_id IS NOT NULL
      UNION SELECT DISTINCT 'user' AS entity_type, user_id AS entity_id FROM entities
      UNION SELECT 'user' AS entity_type, user_id AS entity_id FROM user_aliases
    )
    SELECT scopes.entity_type, scopes.entity_id, user_aliases.alias,
      (SELECT COUNT(*) FROM memories WHERE deleted_at IS NULL AND
        ((scopes.entity_type = 'user' AND memories.user_id = scopes.entity_id) OR
         (scopes.entity_type = 'agent' AND memories.agent_id = scopes.entity_id))) AS memory_count
    FROM scopes
    LEFT JOIN user_aliases ON user_aliases.user_id = scopes.entity_id
    ORDER BY scopes.entity_type, COALESCE(user_aliases.alias, scopes.entity_id) COLLATE NOCASE
  `;
  const result = await env.DB.prepare(query).all<{ entity_type: DashboardEntityType; entity_id: string; alias: string | null; memory_count: number }>();
  return result.results.map((row) => ({
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    ...(row.alias === null ? {} : { alias: row.alias }),
    memory_count: row.memory_count,
  }));
}

export async function setDashboardUserAlias(env: Env, userId: string, alias: string): Promise<void> {
  const normalized = alias.trim();
  if (normalized === '') {
    await env.DB.prepare('DELETE FROM user_aliases WHERE user_id = ?').bind(userId).run();
    return;
  }

  await env.DB.prepare(`
    INSERT INTO user_aliases (user_id, alias) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET alias = excluded.alias, updated_at = unixepoch()
  `).bind(userId, normalized).run();
}

export async function listDashboardMemories(env: Env, entityType: DashboardEntityType, entityId: string, offset: number): Promise<DashboardMemoryPage> {
  const column = dashboardScopeColumn(entityType);
  const result = await env.DB.prepare(`
    SELECT id, user_id, agent_id, run_id, actor_id, content, metadata_json, created_at, updated_at
    FROM memories
    WHERE ${column} = ? AND deleted_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).bind(entityId, PAGE_SIZE + 1, offset).all<MemoryRow>();
  const rows = result.results.slice(0, PAGE_SIZE);
  return {
    results: rows.map(toMemoryResponse),
    ...(result.results.length > PAGE_SIZE ? { next_offset: offset + PAGE_SIZE } : {}),
  };
}

export async function getDashboardDeduplicationSummary(
  env: Env,
  entityType: DashboardEntityType,
  entityId: string,
): Promise<DashboardDeduplicationSummary> {
  const column = dashboardScopeColumn(entityType);
  const [totals, previewRows] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) AS duplicate_groups, COALESCE(SUM(duplicate_count), 0) AS removable_memories
      FROM (
        SELECT COUNT(*) - 1 AS duplicate_count
        FROM memories
        WHERE ${column} = ? AND deleted_at IS NULL
        GROUP BY content
        HAVING COUNT(*) >= 2
      )
    `).bind(entityId).first<{ duplicate_groups: number; removable_memories: number }>(),
    env.DB.prepare(`
      SELECT content, COUNT(*) - 1 AS duplicate_count
      FROM memories
      WHERE ${column} = ? AND deleted_at IS NULL
      GROUP BY content
      HAVING COUNT(*) >= 2
      ORDER BY content COLLATE NOCASE
      LIMIT 10
    `).bind(entityId).all<{ content: string; duplicate_count: number }>(),
  ]);

  return {
    duplicate_groups: totals?.duplicate_groups ?? 0,
    removable_memories: totals?.removable_memories ?? 0,
    previews: previewRows.results.map((group) => ({ memory: group.content, duplicate_count: group.duplicate_count })),
  };
}

export async function listDashboardDuplicateMemoryIds(
  env: Env,
  entityType: DashboardEntityType,
  entityId: string,
): Promise<string[]> {
  const column = dashboardScopeColumn(entityType);
  const result = await env.DB.prepare(`
    WITH ranked_memories AS (
      SELECT id, created_at,
        ROW_NUMBER() OVER (PARTITION BY content ORDER BY created_at ASC, id ASC) AS row_number
      FROM memories
      WHERE ${column} = ? AND deleted_at IS NULL
    )
    SELECT id
    FROM ranked_memories
    WHERE row_number > 1
    ORDER BY created_at ASC, id ASC
  `).bind(entityId).all<{ id: string }>();
  return result.results.map((row) => row.id);
}

export async function softDeleteDashboardMemories(
  env: Env,
  entityType: DashboardEntityType,
  entityId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;

  const column = dashboardScopeColumn(entityType);
  let deleted = 0;
  for (let start = 0; start < ids.length; start += 99) {
    const batch = ids.slice(start, start + 99);
    const placeholders = batch.map(() => '?').join(', ');
    const result = await env.DB.prepare(`
      WITH ranked_memories AS (
        SELECT id,
          ROW_NUMBER() OVER (PARTITION BY content ORDER BY created_at ASC, id ASC) AS row_number
        FROM memories
        WHERE ${column} = ? AND deleted_at IS NULL
      )
      UPDATE memories
      SET deleted_at = unixepoch()
      WHERE deleted_at IS NULL
        AND id IN (SELECT id FROM ranked_memories WHERE row_number > 1)
        AND id IN (${placeholders})
    `).bind(entityId, ...batch).run();
    deleted += result.meta.changes;
  }
  return deleted;
}

function dashboardScopeColumn(entityType: DashboardEntityType): 'user_id' | 'agent_id' {
  return entityType === 'user' ? 'user_id' : 'agent_id';
}

interface MemoryRow {
  id: string;
  user_id: string | null;
  agent_id: string | null;
  run_id: string | null;
  actor_id: string | null;
  content: string;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

function toMemoryResponse(row: MemoryRow): MemoryResponse {
  return {
    id: row.id,
    memory: row.content,
    ...(row.user_id === null ? {} : { user_id: row.user_id }),
    ...(row.agent_id === null ? {} : { agent_id: row.agent_id }),
    ...(row.run_id === null ? {} : { run_id: row.run_id }),
    ...(row.actor_id === null ? {} : { actor_id: row.actor_id }),
    metadata: parseMetadata(row.metadata_json),
    created_at: new Date(row.created_at * 1000).toISOString(),
    updated_at: new Date(row.updated_at * 1000).toISOString(),
  };
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
