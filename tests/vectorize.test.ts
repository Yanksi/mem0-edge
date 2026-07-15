import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { SearchMemoryRequest } from '../src/memory/types';
import {
  deleteVector,
  deleteVectors,
  searchEntityVectors,
  searchVectors,
  type EntityVector,
  type VectorSearchResult,
  upsertEntityVectors,
  upsertVectors,
} from '../src/vectorize';

expectTypeOf<VectorSearchResult['metadata']>().toEqualTypeOf<Record<string, VectorizeVectorMetadataValue> | undefined>();
expectTypeOf<EntityVector['metadata']['user_id']>().toEqualTypeOf<string>();

describe('Vectorize wrappers', () => {
  it('upserts records and deletes individual vector IDs', async () => {
    const index = {
      upsert: vi.fn().mockResolvedValue({}),
      deleteByIds: vi.fn().mockResolvedValue({}),
    } as unknown as VectorizeIndex;
    const records = [{ id: 'memory-123', values: [0.1, 0.2], metadata: { user_id: 'user-123' } }];

    await upsertVectors(index, records);
    await deleteVector(index, 'memory-123');

    expect(index.upsert).toHaveBeenCalledWith(records);
    expect(index.deleteByIds).toHaveBeenCalledWith(['memory-123']);
  });

  it('deletes arbitrary vector IDs in sequential batches of 100', async () => {
    const index = { deleteByIds: vi.fn().mockResolvedValue({}) } as unknown as VectorizeIndex;
    const ids = Array.from({ length: 201 }, (_, index) => `memory-${index}`);

    await deleteVectors(index, ids);

    expect(index.deleteByIds).toHaveBeenCalledTimes(3);
    expect(index.deleteByIds).toHaveBeenNthCalledWith(1, ids.slice(0, 100));
    expect(index.deleteByIds).toHaveBeenNthCalledWith(2, ids.slice(100, 200));
    expect(index.deleteByIds).toHaveBeenNthCalledWith(3, ids.slice(200));
  });

  it('does not call Vectorize when no IDs are supplied', async () => {
    const index = { deleteByIds: vi.fn() } as unknown as VectorizeIndex;

    await deleteVectors(index, []);

    expect(index.deleteByIds).not.toHaveBeenCalled();
  });

  it('stops after a rejected batch and propagates the failure', async () => {
    const failure = new Error('Vectorize unavailable');
    const index = {
      deleteByIds: vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(failure),
    } as unknown as VectorizeIndex;
    const ids = Array.from({ length: 201 }, (_, index) => `memory-${index}`);

    await expect(deleteVectors(index, ids)).rejects.toBe(failure);

    expect(index.deleteByIds).toHaveBeenCalledTimes(2);
    expect(index.deleteByIds).toHaveBeenNthCalledWith(1, ids.slice(0, 100));
    expect(index.deleteByIds).toHaveBeenNthCalledWith(2, ids.slice(100, 200));
  });

  it('caps topK, scopes its filter, returns metadata, and omits vector values', async () => {
    const index = {
      query: vi.fn().mockResolvedValue({
        matches: [{ id: 'memory-123', score: 0.95, values: [0.1, 0.2], metadata: { memory: 'Lives in Zurich' } }],
      }),
    } as unknown as VectorizeIndex;
    const request = {
      query: 'Zurich',
      user_id: 'user-123',
      agent_id: 'agent-123',
      run_id: 'run-123',
      actor_id: 'actor-123',
      filters: {
        category: { $in: ['profile', 'project'] },
        created_at: { $gte: '2026-01-01', $lt: '2027-01-01' },
      },
      limit: 99,
    } as SearchMemoryRequest;

    await expect(searchVectors(index, [0.1, 0.2], request)).resolves.toEqual([
      { id: 'memory-123', score: 0.95, metadata: { memory: 'Lives in Zurich' } },
    ]);
    expect(index.query).toHaveBeenCalledWith([0.1, 0.2], {
      topK: 50,
      returnMetadata: 'all',
      returnValues: false,
      filter: {
        category: { $in: ['profile', 'project'] },
        created_at: { $gte: '2026-01-01', $lt: '2027-01-01' },
        user_id: 'user-123',
        agent_id: 'agent-123',
        run_id: 'run-123',
        actor_id: 'actor-123',
      },
    });
  });

  it('allows an internal semantic candidate pool larger than the requested result limit', async () => {
    const index = {
      query: vi.fn().mockResolvedValue({ matches: [] }),
    } as unknown as VectorizeIndex;
    const request = {
      query: 'Zurich',
      user_id: 'user-123',
      filters: {},
      limit: 5,
    } as SearchMemoryRequest;

    await searchVectors(index, [0.1, 0.2], request, { candidatePool: 50 });

    expect(index.query).toHaveBeenCalledWith([0.1, 0.2], expect.objectContaining({ topK: 50 }));
  });

  it('upserts typed entity records and searches entities scoped only by user ID', async () => {
    const index = {
      upsert: vi.fn().mockResolvedValue({}),
      query: vi.fn().mockResolvedValue({
        matches: [{ id: 'entity-123', score: 0.95, values: [0.1, 0.2], metadata: { user_id: 'user-123', entity: 'Zurich' } }],
      }),
    } as unknown as VectorizeIndex;
    const records: EntityVector[] = [{
      id: 'entity-123',
      values: [0.1, 0.2],
      metadata: { user_id: 'user-123', entity: 'Zurich' },
    }];

    await upsertEntityVectors(index, records);

    await expect(searchEntityVectors(index, [0.1, 0.2], 'user-123')).resolves.toEqual([
      { id: 'entity-123', score: 0.95, metadata: { user_id: 'user-123', entity: 'Zurich' } },
    ]);
    expect(index.upsert).toHaveBeenCalledWith(records);
    expect(index.query).toHaveBeenCalledWith([0.1, 0.2], {
      topK: 20,
      returnMetadata: 'all',
      returnValues: false,
      filter: { user_id: 'user-123' },
    });
  });

  it('rejects malformed user metadata filters before querying Vectorize', async () => {
    const index = { query: vi.fn() } as unknown as VectorizeIndex;
    const invalidFilters = [
      { 'bad.key': 'profile' },
      { $private: 'profile' },
      { category: { $eq: ['profile'] } },
      { category: { $in: ['profile', {}] } },
      { score: { $eq: 1, $gt: 0 } },
      { score: { $gt: 0, $gte: 1 } },
      { score: { $gte: 1, $lt: '9' } },
      { ['a'.repeat(513)]: 'profile' },
      { note: 'x'.repeat(2048) },
    ];

    for (const filters of invalidFilters) {
      const request = {
        query: 'Zurich',
        user_id: 'user-123',
        filters,
        limit: 10,
      } as SearchMemoryRequest;

      await expect(searchVectors(index, [0.1, 0.2], request)).rejects.toThrow('Invalid Vectorize metadata filter');
    }

    expect(index.query).not.toHaveBeenCalled();
  });
});
