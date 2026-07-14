import type { Env } from '../env';
import type { MemoryResponse } from '../memory/types';

const PAGE_SIZE = 50;

export interface DashboardUser {
  user_id: string;
  alias?: string;
  memory_count: number;
}

export interface DashboardMemoryPage {
  results: MemoryResponse[];
  next_offset?: number;
}

export async function listDashboardUsers(env: Env): Promise<DashboardUser[]> {
  const query = `
    WITH user_ids AS (
      SELECT DISTINCT user_id FROM memories WHERE deleted_at IS NULL
      UNION SELECT DISTINCT user_id FROM entities
      UNION SELECT user_id FROM user_aliases
    )
    SELECT user_ids.user_id, user_aliases.alias,
      (SELECT COUNT(*) FROM memories WHERE memories.user_id = user_ids.user_id AND deleted_at IS NULL) AS memory_count
    FROM user_ids
    LEFT JOIN user_aliases ON user_aliases.user_id = user_ids.user_id
    ORDER BY COALESCE(user_aliases.alias, user_ids.user_id) COLLATE NOCASE
  `;
  const result = await env.DB.prepare(query).all<{ user_id: string; alias: string | null; memory_count: number }>();
  return result.results.map((row) => ({
    user_id: row.user_id,
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

export async function listDashboardMemories(env: Env, userId: string, offset: number): Promise<DashboardMemoryPage> {
  const result = await env.DB.prepare(`
    SELECT id, user_id, agent_id, run_id, actor_id, content, metadata_json, created_at, updated_at
    FROM memories
    WHERE user_id = ? AND deleted_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).bind(userId, PAGE_SIZE + 1, offset).all<MemoryRow>();
  const rows = result.results.slice(0, PAGE_SIZE);
  return {
    results: rows.map(toMemoryResponse),
    ...(result.results.length > PAGE_SIZE ? { next_offset: offset + PAGE_SIZE } : {}),
  };
}

interface MemoryRow {
  id: string;
  user_id: string;
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
    user_id: row.user_id,
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
