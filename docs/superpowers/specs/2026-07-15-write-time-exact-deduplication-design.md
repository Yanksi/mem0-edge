# Write-Time Exact Memory Deduplication Design

**Date:** 2026-07-15

## Goal

Prevent active exact-text memory duplicates at write time across every creation
path, remove the Dashboard's manual deduplication feature, and perform one final
cleanup of existing production duplicates before enabling database-enforced
uniqueness.

This design does not perform semantic deduplication. Two memories are duplicates
only when their final stored `content`, `user_id`, and `agent_id` are equal,
including null ownership fields.

Each memory also stores `content_hash`, the lowercase hexadecimal SHA-256 digest
of its final stored content. The existing `hash` column remains the originating
request/idempotency hash and is not reused for this purpose.

## Scope Identity

Exact-text uniqueness uses the complete memory ownership scope:

- user and agent: `(user_id, agent_id, content)`;
- user only: `(user_id, NULL, content)`;
- agent only: `(NULL, agent_id, content)`.

The same text may exist for different users, different agents, or different
user-agent pairs. `run_id`, `actor_id`, metadata, and timestamps do not change
deduplication identity.

Only active rows participate. A row with `deleted_at IS NOT NULL` does not block
the same text from being created as a new active memory. The old row and its
history remain unchanged.

## Exact-Text Contract

Comparison uses the content that each path would otherwise store. It is
case-sensitive and does not collapse internal whitespace, punctuation, or
Unicode variants.

Existing path-specific behavior remains intact:

- extracted and direct API candidates retain their current trimming behavior;
- Mem0 migration imports continue preserving source memory text verbatim.

Deduplication introduces no additional normalization.

`content_hash` is an indexed lookup accelerator, not the final equality
authority. Queries match both the digest and original content, so even a
theoretical digest collision does not merge distinct memories.

## Database Enforcement

The schema adds a required `content_hash` column and three partial unique
indexes. Scope and the fixed-size digest form the selective index prefix; raw
content is the final collision-safe key component:

```sql
CREATE UNIQUE INDEX memories_active_user_agent_content_idx
  ON memories (user_id, agent_id, content_hash, content)
  WHERE deleted_at IS NULL AND user_id IS NOT NULL AND agent_id IS NOT NULL;

CREATE UNIQUE INDEX memories_active_user_content_idx
  ON memories (user_id, content_hash, content)
  WHERE deleted_at IS NULL AND user_id IS NOT NULL AND agent_id IS NULL;

CREATE UNIQUE INDEX memories_active_agent_content_idx
  ON memories (agent_id, content_hash, content)
  WHERE deleted_at IS NULL AND user_id IS NULL AND agent_id IS NOT NULL;
```

The indexes are the concurrency authority. Application-side lookups avoid
unnecessary model and Vectorize work, but correctness does not depend on a
check-then-insert sequence.

Rows with both owners null are outside supported creation paths and are not
covered by these indexes. This change does not add a new ownership constraint
that could reject legacy data unrelated to deduplication.

## Shared Write Behavior

Memory creation paths use a shared exact-match lookup and insertion contract.
For each unique candidate:

1. Compute SHA-256 once from the final stored content.
2. Query for an active row with the same complete ownership scope,
   `content_hash`, and content.
3. If found, return that canonical memory without embedding, adding history, or
   persisting extracted graph data.
4. If not found, embed and upsert the candidate vector, then attempt the memory
   insert with conflict-safe returning semantics.
5. If the insert wins, append history and persist graph data as today.
6. If the insert loses to a concurrent writer, fetch and return the canonical
   row. Delete the losing candidate's Vectorize ID when it differs from the
   canonical ID.

Every normal add and import already has a durable request ledger. If a Worker
stops after a vector upsert or conflict but before cleanup, retrying the same
request uses the same candidate ID, observes the canonical row, and retries the
orphan-vector deletion before completing the ledger request.

Duplicate writes return the existing canonical memory in the normal response.
They do not return an empty result and do not mutate canonical metadata,
timestamps, history, or graph evidence.

## Candidate Deduplication

Before persistence:

- LLM extraction output and direct-add candidates are deduplicated by exact
  final content within the request, preserving the first candidate.
- A Mem0 import payload is deduplicated within its selected user or agent scope
  before ledger rows are created.

For repeated import items with distinct source timestamps, choose the item with
the earliest valid `created_at`; null timestamps sort after valid timestamps,
and original input order breaks ties. This preserves the oldest available source
record. The import endpoint's `queued` count reports the number of unique items
submitted to the durable ledger.

An import that matches an already-active memory may still create a ledger item,
but processing completes against the canonical memory without creating another
memory or vector.

## Existing Production Cleanup

Adding a non-null digest to existing rows requires a two-phase schema rollout:

1. migration `0007` adds nullable `content_hash` without uniqueness;
2. an intermediate Worker deployment writes `content_hash` on every new memory;
3. after writers are paused and the Queue is drained, a repository maintenance
   command pages through all existing rows, computes SHA-256 locally, and
   backfills D1 in bounded batches;
4. the same command computes duplicate groups by
   `(user_id, agent_id, content_hash, content)` over active rows;
5. after cleanup and verification, migration `0008` rebuilds the column as
   `NOT NULL` and creates the three unique partial indexes.

The maintenance command must be resumable: updating an already-correct digest
and reapplying the same loser mapping are no-ops. Keep the active row ordered
first by `created_at ASC, id ASC`; every other row in a duplicate group is a
loser.

For each loser-to-canonical mapping, one-time cleanup must:

1. copy its `memory_entity_links` to the canonical memory with conflict-safe
   inserts;
2. repoint `relationships.evidence_memory_id` to the canonical memory;
3. soft-delete the loser memory;
4. delete the loser's memory vector from Vectorize.

D1 changes are applied transactionally before vector deletion. If Vectorize
cleanup is interrupted, stale vectors cannot produce active results because the
corresponding D1 rows are already soft-deleted; rerunning deletion is safe. Do
not apply migration `0008` until verification reports zero null or mismatched
content hashes and zero active duplicate groups.

The cleanup does not delete memory history, entities, relationships, or entity
vectors. It preserves graph evidence by moving memory references to the
canonical row.

## Dashboard Removal

Remove the manual exact-text deduplication feature completely:

- navigation item and view markup;
- summary, confirmation, loading, and invalidation JavaScript;
- `GET` and `POST /dashboard/api/deduplication` routes;
- Dashboard deduplication service functions and response types;
- read-only-preview control handling specific to deduplication;
- feature tests and README instructions.

Search, all-memory browsing, graph viewing, imports, aliases, reindexing, and
agent reclassification remain unchanged.

## Failure Handling

- Database uniqueness conflicts are expected concurrency outcomes, not request
  failures.
- A stored digest is always computed from final content by the Worker; callers
  cannot provide or override it.
- A losing vector cleanup failure is transient and leaves the durable request
  retryable.
- Embedding or Vectorize failure before a successful insert creates no active
  D1 memory.
- A soft-deleted exact match never becomes canonical for a new request.
- Cleanup migration failure leaves writers paused; it is rerun from the
  deterministic loser-to-canonical mapping before index creation.

## Tests

Automated coverage must include:

- content-hash generation for verbatim imports and normalized API candidates;
- backfill resumption and detection of null or mismatched hashes;
- all three digest-prefixed partial unique indexes and soft-delete exclusion;
- identical user-agent scope returns one active memory;
- same text under a different user or agent remains distinct;
- user-only and agent-only scope behavior;
- soft-deleted text can be created as a new active row;
- duplicate direct, inferred, synchronous, and queued adds return canonical
  memory without extra embedding, history, or graph writes;
- duplicate import items create one ledger item and preserve the oldest source
  timestamp;
- an import matching existing active storage creates no new memory/vector;
- a concurrent unique-index loser resolves the winner and cleans its candidate
  vector, including retry after cleanup failure;
- production cleanup selection keeps the oldest row and rewires graph evidence;
- Dashboard HTML and routes no longer expose deduplication;
- the complete existing test suite remains green.

## Deployment Sequence

1. Verify tests and prepare migrations `0007` and `0008` plus the resumable
   maintenance command.
2. Apply migration `0007` and deploy intermediate dual-write code.
3. Pause Hermes writes and drain Queue work.
4. Backfill hashes and export the deterministic production duplicate mapping.
5. Apply D1 graph-preserving soft deletion and remove loser vectors.
6. Confirm zero null/mismatched hashes, duplicate groups, and loser vectors.
7. Apply migration `0008`.
8. Deploy final shared write-time deduplication and Dashboard removal.
9. Run scope, soft-delete recreation, synchronous add, queued add, and import
   probes; clean up probe records.
10. Resume Hermes writes.

## Explicitly Not Included

- semantic similarity deduplication;
- merging or rewriting memory text;
- updating canonical metadata from a duplicate request;
- deduplicating entities or relationships independently;
- a general-purpose background deduplication maintenance system;
- a replacement Dashboard deduplication or cleanup interface.
