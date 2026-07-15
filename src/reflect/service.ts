import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { createDb } from '../db/client';
import { entities, memories, memoryEntityLinks, relationships } from '../db/schema';
import type { Env } from '../env';
import type { EntityResponse, RelationshipResponse } from '../graph/service';
import { reflectWithGraphModel } from '../llm';
import { searchMemories } from '../memory/service';
import type { MemoryResponse } from '../memory/types';
import type { ReflectRequest } from './types';

export const REFLECT_SEED_LIMIT = 12;
export const REFLECT_MAX_HOPS = 2;
export const REFLECT_MAX_ENTITIES = 24;
export const REFLECT_MAX_EDGES = 32;
export const REFLECT_MAX_EVIDENCE = 20;
export const REFLECT_MAX_EVIDENCE_CHARS = 24_000;
export const REFLECT_MEMORY_QUERY_CHUNK_SIZE = 90;

export interface ReflectResult {
  result: string;
  uncertainty: 'low' | 'medium' | 'high';
  evidences: Array<{
    relationship: RelationshipResponse;
    source_entity: EntityResponse;
    target_entity: EntityResponse;
    evidence_memory?: MemoryResponse;
  }>;
  relation_paths: Array<{ entity_ids: string[]; relationship_ids: string[] }>;
  limitations?: string;
  request_id: string;
}

type EntityRow = typeof entities.$inferSelect;
type RelationshipRow = typeof relationships.$inferSelect;

export async function reflectMemories(env: Env, request: ReflectRequest, requestId: string): Promise<ReflectResult> {
  const seeds = await searchMemories(env, {
    query: request.query,
    user_id: request.user_id,
    agent_id: request.agent_id,
    limit: REFLECT_SEED_LIMIT,
    filters: {},
  });
  if (seeds.length === 0) return noEvidence(requestId);

  const db = createDb(env.DB);
  const seedIds = seeds.map(({ id }) => id);
  const links = await db.select({ memoryId: memoryEntityLinks.memoryId, entityId: memoryEntityLinks.entityId })
    .from(memoryEntityLinks).where(inArray(memoryEntityLinks.memoryId, seedIds)).all();
  const seedEntityIds = uniqueSorted(links.map(({ entityId }) => entityId)).slice(0, REFLECT_MAX_ENTITIES);
  if (seedEntityIds.length === 0) return noEvidence(requestId);

  const byId = new Map<string, EntityRow>();
  for (const entity of await loadEntities(db, request.user_id, seedEntityIds)) byId.set(entity.id, entity);
  if (byId.size === 0) return noEvidence(requestId);

  let frontier = uniqueSorted([...byId.keys()]);
  const accepted: RelationshipRow[] = [];
  for (let hop = 0; hop < REFLECT_MAX_HOPS && frontier.length > 0 && accepted.length < REFLECT_MAX_EDGES; hop += 1) {
    const candidates = await db.select().from(relationships).where(and(
      eq(relationships.userId, request.user_id),
      or(
        inArray(relationships.sourceEntityId, frontier),
        inArray(relationships.targetEntityId, frontier),
      ),
    )).all();
    const seen = new Set(accepted.map(({ id }) => id));
    const edges = candidates
      .filter((edge) => edge.userId === request.user_id && !seen.has(edge.id))
      .filter((edge) => frontier.includes(edge.sourceEntityId) || frontier.includes(edge.targetEntityId))
      .sort((left, right) => left.id.localeCompare(right.id));
    const discoveredIds = uniqueSorted(edges.flatMap((edge) => [edge.sourceEntityId, edge.targetEntityId]));
    const missingIds = discoveredIds.filter((id) => !byId.has(id));
    const available = Math.max(0, REFLECT_MAX_ENTITIES - byId.size);
    const loaded = available === 0 ? [] : await loadEntities(db, request.user_id, missingIds.slice(0, available));
    for (const entity of loaded) byId.set(entity.id, entity);

    const next = new Set<string>();
    for (const edge of edges) {
      if (accepted.length === REFLECT_MAX_EDGES) break;
      if (!byId.has(edge.sourceEntityId) || !byId.has(edge.targetEntityId)) continue;
      accepted.push(edge);
      if (!frontier.includes(edge.sourceEntityId)) next.add(edge.sourceEntityId);
      if (!frontier.includes(edge.targetEntityId)) next.add(edge.targetEntityId);
    }
    frontier = uniqueSorted([...next]);
  }
  if (accepted.length === 0) return noEvidence(requestId);
  const evidenceCandidates = await collectEvidenceCandidates(
    db, request.user_id, seeds, accepted, [...byId.keys()],
  );

  const orderedEntities = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  const entityRefs = new Map(orderedEntities.map((entity, index) => [entity.id, `E${index + 1}`]));
  const relationRefs = new Map(accepted.map((edge, index) => [edge.id, `R${index + 1}`]));
  const reflection = await reflectWithGraphModel(env, {
    query: request.query,
    entities: orderedEntities.map((entity) => ({ ref: entityRefs.get(entity.id)!, name: entity.name, type: entity.type })),
    relations: accepted.map((edge) => ({
      ref: relationRefs.get(edge.id)!, source: entityRefs.get(edge.sourceEntityId)!, predicate: edge.relationType,
      target: entityRefs.get(edge.targetEntityId)!, ...(edge.confidence === null ? {} : { confidence: edge.confidence }),
    })),
  });

  const selectedRefs = reflection.evidence_relation_refs;
  if (selectedRefs.length === 0 || new Set(selectedRefs).size !== selectedRefs.length) return noEvidence(requestId);
  const byRef = new Map(accepted.map((edge) => [relationRefs.get(edge.id)!, edge]));
  const selected = selectedRefs.map((ref) => byRef.get(ref));
  if (selected.some((edge) => edge === undefined)) return noEvidence(requestId);

  const selectedEdges = selected as RelationshipRow[];
  const evidenceById = new Map(evidenceCandidates.map((memory) => [memory.id, memory]));
  if (selectedEdges.some((edge) => edge.evidenceMemoryId !== null && !evidenceById.has(edge.evidenceMemoryId))) {
    return noEvidence(requestId);
  }
  return {
    result: reflection.result,
    uncertainty: 'medium',
    evidences: selectedEdges.map((edge) => ({
      relationship: toRelationshipResponse(edge),
      source_entity: toEntityResponse(byId.get(edge.sourceEntityId)!),
      target_entity: toEntityResponse(byId.get(edge.targetEntityId)!),
      ...(edge.evidenceMemoryId === null || !evidenceById.has(edge.evidenceMemoryId)
        ? {} : { evidence_memory: evidenceById.get(edge.evidenceMemoryId)! }),
    })),
    relation_paths: relationPaths(selectedEdges),
    request_id: requestId,
  };
}

function noEvidence(requestId: string): ReflectResult {
  return {
    result: 'I cannot answer reliably from the retrieved memories.',
    uncertainty: 'high',
    evidences: [],
    relation_paths: [],
    limitations: 'No relevant stored memory evidence was found.',
    request_id: requestId,
  };
}

async function loadEntities(db: ReturnType<typeof createDb>, userId: string, ids: string[]): Promise<EntityRow[]> {
  if (ids.length === 0) return [];
  const requested = new Set(ids);
  const rows = await db.select().from(entities).where(and(
    eq(entities.userId, userId), inArray(entities.id, ids),
  )).all();
  return rows.filter((entity) => entity.userId === userId && requested.has(entity.id));
}

async function collectEvidenceCandidates(
  db: ReturnType<typeof createDb>,
  userId: string,
  seeds: MemoryResponse[],
  edges: RelationshipRow[],
  entityIds: string[],
): Promise<MemoryResponse[]> {
  const links = entityIds.length === 0 ? [] : await db.select({ memoryId: memoryEntityLinks.memoryId })
    .from(memoryEntityLinks).where(inArray(memoryEntityLinks.entityId, entityIds)).all();
  const graphMemoryIds = uniqueSorted([
    ...edges.map(({ evidenceMemoryId }) => evidenceMemoryId).filter((id): id is string => id !== null),
    ...links.map(({ memoryId }) => memoryId),
  ]);
  return boundedEvidenceCandidates(seeds, await loadActiveMemories(db, userId, graphMemoryIds));
}

async function loadActiveMemories(db: ReturnType<typeof createDb>, userId: string, ids: string[]): Promise<MemoryResponse[]> {
  const evidenceIds = uniqueSorted(ids);
  if (evidenceIds.length === 0) return [];
  const rowsById = new Map<string, typeof memories.$inferSelect>();
  for (let offset = 0; offset < evidenceIds.length && rowsById.size < REFLECT_MAX_EVIDENCE; offset += REFLECT_MEMORY_QUERY_CHUNK_SIZE) {
    const chunk = evidenceIds.slice(offset, offset + REFLECT_MEMORY_QUERY_CHUNK_SIZE);
    const rows = await db.select().from(memories).where(and(
      inArray(memories.id, chunk), eq(memories.userId, userId), isNull(memories.deletedAt),
    )).all();
    for (const row of rows) {
      if (chunk.includes(row.id) && row.userId === userId && row.deletedAt === null) rowsById.set(row.id, row);
    }
  }
  return evidenceIds.flatMap((id) => {
    const row = rowsById.get(id);
    return row === undefined ? [] : [toMemoryResponse(row)];
  }).slice(0, REFLECT_MAX_EVIDENCE);
}

export function boundedEvidenceCandidates(seeds: MemoryResponse[], graphMemories: MemoryResponse[]): MemoryResponse[] {
  const candidates = [...seeds, ...[...graphMemories].sort((left, right) => left.id.localeCompare(right.id))];
  const seen = new Set<string>();
  const bounded: MemoryResponse[] = [];
  let characters = 0;
  for (const memory of candidates) {
    if (seen.has(memory.id)) continue;
    seen.add(memory.id);
    if (bounded.length === REFLECT_MAX_EVIDENCE || characters + memory.memory.length > REFLECT_MAX_EVIDENCE_CHARS) continue;
    bounded.push(memory);
    characters += memory.memory.length;
  }
  return bounded;
}

function relationPaths(edges: RelationshipRow[]): Array<{ entity_ids: string[]; relationship_ids: string[] }> {
  const bySource = new Map<string, RelationshipRow[]>();
  const targets = new Set(edges.map(({ targetEntityId }) => targetEntityId));
  for (const edge of edges) bySource.set(edge.sourceEntityId, [...(bySource.get(edge.sourceEntityId) ?? []), edge]);
  const starts = [...bySource.keys()].filter((id) => !targets.has(id)).sort();
  const paths: Array<{ entity_ids: string[]; relationship_ids: string[] }> = [];
  for (const start of starts) {
    const pathEntities = [start];
    const pathEdges: string[] = [];
    const visited = new Set<string>();
    let current = start;
    while (true) {
      const next = (bySource.get(current) ?? []).find((edge) => !visited.has(edge.id));
      if (next === undefined) break;
      visited.add(next.id);
      pathEdges.push(next.id);
      pathEntities.push(next.targetEntityId);
      current = next.targetEntityId;
    }
    if (pathEdges.length > 0) paths.push({ entity_ids: pathEntities, relationship_ids: pathEdges });
  }
  return paths;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function toEntityResponse(row: EntityRow): EntityResponse {
  return { id: row.id, user_id: row.userId, name: row.name, type: row.type, metadata: parseMetadata(row.metadataJson), created_at: toIso(row.createdAt), updated_at: toIso(row.updatedAt) };
}

function toRelationshipResponse(row: RelationshipRow): RelationshipResponse {
  return {
    id: row.id, user_id: row.userId, source_entity_id: row.sourceEntityId, target_entity_id: row.targetEntityId,
    relation_type: row.relationType, ...(row.confidence === null ? {} : { confidence: row.confidence }),
    ...(row.evidenceMemoryId === null ? {} : { evidence_memory_id: row.evidenceMemoryId }), metadata: parseMetadata(row.metadataJson),
    created_at: toIso(row.createdAt), updated_at: toIso(row.updatedAt),
  };
}

function toMemoryResponse(row: typeof memories.$inferSelect): MemoryResponse {
  return {
    id: row.id, memory: row.content, ...(row.userId === null ? {} : { user_id: row.userId }),
    ...(row.agentId === null ? {} : { agent_id: row.agentId }), ...(row.runId === null ? {} : { run_id: row.runId }),
    ...(row.actorId === null ? {} : { actor_id: row.actorId }), metadata: parseMetadata(row.metadataJson),
    created_at: toIso(row.createdAt), updated_at: toIso(row.updatedAt),
  };
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function toIso(value: number): string { return new Date(value * 1000).toISOString(); }
