import { and, asc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { createDb } from '../db/client';
import { memories } from '../db/schema';
import type { Env } from '../env';
import { embedText } from '../llm';
import { assertDedupLlmConfigured, getSemanticDedupEnabled } from '../settings/service';
import { searchDeduplicationCandidates } from '../vectorize';
import { selectSemanticDuplicate } from './deduplication-llm';
import { contentHash, ownerPredicate, scopeKey, type MemoryOwnerScope } from './identity';

export type MemoryRow = typeof memories.$inferSelect;

export interface PreparedMemoryWrite {
  contentHash: string;
  exactScopeKey: string;
  embedding?: number[];
  duplicate?: MemoryRow;
}

export async function findActiveExactMemory(
  env: Env,
  scope: MemoryOwnerScope,
  content: string,
  digest?: string,
  excludeId?: string,
): Promise<MemoryRow | undefined> {
  const resolvedDigest = digest ?? await contentHash(content);
  const db = createDb(env.DB);
  const exclusion = excludeId === undefined ? undefined : ne(memories.id, excludeId);
  const common = [
    isNull(memories.deletedAt),
    ownerPredicate(scope),
    eq(memories.content, content),
    exclusion,
  ];

  const [match] = await db.select()
    .from(memories)
    .where(and(
      ...common,
      or(eq(memories.contentHash, resolvedDigest), isNull(memories.contentHash)),
    ))
    .orderBy(asc(memories.createdAt), asc(memories.id))
    .limit(1);
  if (match === undefined) {
    return undefined;
  }
  if (match.contentHash !== null) {
    return match;
  }

  const [backfilled] = await db.update(memories)
    .set({ contentHash: resolvedDigest })
    .where(and(
      eq(memories.id, match.id),
      ...common,
      isNull(memories.contentHash),
    ))
    .returning();
  if (backfilled !== undefined) {
    return backfilled;
  }

  const [concurrentMatch] = await db.select()
    .from(memories)
    .where(and(
      eq(memories.id, match.id),
      isNull(memories.deletedAt),
      ownerPredicate(scope),
      eq(memories.content, content),
      eq(memories.contentHash, resolvedDigest),
      exclusion,
    ))
    .limit(1);
  return concurrentMatch;
}

export async function prepareMemoryWrite(
  env: Env,
  scope: MemoryOwnerScope,
  content: string,
): Promise<PreparedMemoryWrite> {
  const digest = await contentHash(content);
  const exactDuplicate = await findActiveExactMemory(env, scope, content, digest);
  const exactScopeKey = await scopeKey(scope);

  if (exactDuplicate !== undefined) {
    return { contentHash: digest, exactScopeKey, duplicate: exactDuplicate };
  }

  if (!await getSemanticDedupEnabled(env)) {
    return { contentHash: digest, exactScopeKey };
  }

  assertDedupLlmConfigured(env);
  const embedding = await embedText(env, content);
  const threshold = similarityThreshold(env.DEDUP_SIMILARITY_THRESHOLD);
  const limit = candidateLimit(env.DEDUP_CANDIDATE_LIMIT);
  const matches = (await searchDeduplicationCandidates(
    env.VECTORIZE,
    embedding,
    exactScopeKey,
    limit,
  )).filter(({ score }) => score >= threshold).slice(0, 20);

  if (matches.length === 0) {
    return { contentHash: digest, exactScopeKey, embedding };
  }

  const candidateIds = [...new Set(matches.map(({ id }) => id))];
  const db = createDb(env.DB);
  const rows = await db.select()
    .from(memories)
    .where(and(
      inArray(memories.id, candidateIds),
      isNull(memories.deletedAt),
      ownerPredicate(scope),
    ));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const candidates = matches.flatMap(({ id, score }) => {
    const row = rowsById.get(id);
    return row === undefined ? [] : [{ row, score }];
  }).sort((left, right) => (
    right.score - left.score
    || left.row.createdAt - right.row.createdAt
    || (left.row.id < right.row.id ? -1 : left.row.id > right.row.id ? 1 : 0)
  ));

  if (candidates.length === 0) {
    return { contentHash: digest, exactScopeKey, embedding };
  }

  const refs = new Map<string, MemoryRow>();
  const llmCandidates = candidates.map(({ row }, index) => {
    const ref = `M${index + 1}`;
    refs.set(ref, row);
    return { ref, text: row.content };
  });
  const selectedRef = await selectSemanticDuplicate(env, {
    new_memory: { ref: 'NEW', text: content },
    candidates: llmCandidates,
  });
  const duplicate = selectedRef === null ? undefined : refs.get(selectedRef);

  return {
    contentHash: digest,
    exactScopeKey,
    embedding,
    ...(duplicate === undefined ? {} : { duplicate }),
  };
}

function similarityThreshold(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0.85;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.85;
}

function candidateLimit(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 8;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, 20) : 8;
}
