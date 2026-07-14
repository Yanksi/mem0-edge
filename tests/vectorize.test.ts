import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { SearchMemoryRequest } from '../src/memory/types';
import { deleteVector, deleteVectors, searchVectors, type VectorSearchResult, upsertVectors } from '../src/vectorize';

expectTypeOf<VectorSearchResult['metadata']>().toEqualTypeOf<Record<string, VectorizeVectorMetadataValue> | undefined>();

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

  it('deletes a batch of duplicate vector IDs in one call', async () => {
    const index = { deleteByIds: vi.fn().mockResolvedValue({}) } as unknown as VectorizeIndex;
    const ids = ['memory-456', 'memory-789'];

    await deleteVectors(index, ids);

    expect(index.deleteByIds).toHaveBeenCalledOnce();
    expect(index.deleteByIds).toHaveBeenCalledWith(ids);
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
