import type { SearchMemoryRequest } from './memory/types';

export interface VectorSearchResult {
  id: string;
  score: number;
  metadata?: Record<string, VectorizeVectorMetadataValue>;
}

export interface EntityVector extends VectorizeVector {
  metadata: { user_id: string } & Record<string, VectorizeVectorMetadataValue>;
}

export interface MemoryVectorSearchOptions {
  candidatePool?: number;
}

export function upsertVectors(index: VectorizeIndex, records: VectorizeVector[]) {
  return index.upsert(records);
}

export function upsertEntityVectors(index: VectorizeIndex, records: EntityVector[]) {
  return index.upsert(records);
}

export function deleteVector(index: VectorizeIndex, id: string) {
  return index.deleteByIds([id]);
}

export async function deleteVectors(index: VectorizeIndex, ids: string[]): Promise<void> {
  for (let start = 0; start < ids.length; start += 100) {
    await index.deleteByIds(ids.slice(start, start + 100));
  }
}

export async function searchVectors(
  index: VectorizeIndex,
  vector: number[],
  request: SearchMemoryRequest,
  options: MemoryVectorSearchOptions = {},
): Promise<VectorSearchResult[]> {
  validateMetadataFilter(request.filters, false);
  const filter = {
    ...request.filters,
    ...(request.user_id === undefined ? {} : { user_id: request.user_id }),
    ...(request.agent_id === undefined ? {} : { agent_id: request.agent_id }),
    ...(request.run_id === undefined ? {} : { run_id: request.run_id }),
    ...(request.actor_id === undefined ? {} : { actor_id: request.actor_id }),
  };
  validateMetadataFilter(filter, true);

  const result = await index.query(vector, {
    topK: Math.min(options.candidatePool ?? request.limit, 50),
    returnMetadata: 'all',
    returnValues: false,
    filter: filter as VectorizeVectorMetadataFilter,
  });

  return result.matches.map(({ id, score, metadata }) => ({
    id,
    score,
    metadata: metadata as VectorSearchResult['metadata'],
  }));
}

export async function searchDeduplicationCandidates(
  index: VectorizeIndex,
  vector: number[],
  exactScopeKey: string,
  limit: number,
): Promise<VectorSearchResult[]> {
  const result = await index.query(vector, {
    topK: Math.min(Math.max(limit, 1), 20),
    returnMetadata: 'none',
    returnValues: false,
    filter: { scope_key: exactScopeKey },
  });

  return result.matches.map(({ id, score }) => ({ id, score }));
}

export async function searchEntityVectors(
  index: VectorizeIndex,
  vector: number[],
  userId: string,
): Promise<VectorSearchResult[]> {
  const result = await index.query(vector, {
    topK: 20,
    returnMetadata: 'all',
    returnValues: false,
    filter: { user_id: userId },
  });

  return result.matches.map(({ id, score, metadata }) => ({
    id,
    score,
    metadata: metadata as VectorSearchResult['metadata'],
  }));
}

const SCALAR_OPERATORS = new Set(['$eq', '$ne']);
const ARRAY_OPERATORS = new Set(['$in', '$nin']);
const RANGE_OPERATORS = new Set(['$lt', '$lte', '$gt', '$gte']);
const LOWER_RANGE_OPERATORS = new Set(['$gt', '$gte']);
const UPPER_RANGE_OPERATORS = new Set(['$lt', '$lte']);

function validateMetadataFilter(filter: unknown, requireNonEmpty: boolean): void {
  if (!isRecord(filter)) {
    throw invalidFilterError();
  }

  const entries = Object.entries(filter);
  if ((requireNonEmpty && entries.length === 0) || !entries.every(([key, value]) => isValidField(key, value))) {
    throw invalidFilterError();
  }

  let compactJson: string;
  try {
    compactJson = JSON.stringify(filter);
  } catch {
    throw invalidFilterError();
  }

  if (compactJson.length === 0 || new TextEncoder().encode(compactJson).byteLength >= 2048) {
    throw invalidFilterError();
  }
}

function isValidField(key: string, value: unknown): boolean {
  return key.length > 0
    && key.length <= 512
    && !key.includes('"')
    && !key.includes('.')
    && !key.startsWith('$')
    && isValidFilterValue(value);
}

function isValidFilterValue(value: unknown): boolean {
  if (isScalar(value)) {
    return true;
  }

  if (!isRecord(value)) {
    return false;
  }

  const entries = Object.entries(value);
  if (entries.length === 0 || !entries.every(([operator]) => SCALAR_OPERATORS.has(operator) || ARRAY_OPERATORS.has(operator) || RANGE_OPERATORS.has(operator))) {
    return false;
  }

  if (entries.length === 1) {
    const [operator, operand] = entries[0];
    return (SCALAR_OPERATORS.has(operator) && isScalar(operand))
      || (ARRAY_OPERATORS.has(operator) && Array.isArray(operand) && operand.every(isScalar))
      || (RANGE_OPERATORS.has(operator) && isRangeOperand(operand));
  }

  if (entries.length !== 2 || !entries.every(([operator, operand]) => RANGE_OPERATORS.has(operator) && isRangeOperand(operand))) {
    return false;
  }

  const operators = entries.map(([operator]) => operator);
  if (!operators.some((operator) => LOWER_RANGE_OPERATORS.has(operator)) || !operators.some((operator) => UPPER_RANGE_OPERATORS.has(operator))) {
    return false;
  }

  return typeof entries[0][1] === typeof entries[1][1];
}

function isRangeOperand(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidFilterError(): Error {
  return new Error('Invalid Vectorize metadata filter');
}
