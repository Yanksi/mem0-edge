# Memory Update Mutation Consistency Design

## Goal

Make content updates recoverable and concurrency-safe across D1, the memory graph,
the memory Vectorize index, and the entity Vectorize index. A successful update
must expose one logical version everywhere; an interrupted update must be
deterministically replayable.

## Architecture

Content updates use a durable `memory_update_mutations` ledger. The ledger stores
the base memory version, canonical target content and metadata, extracted graph,
phase, lease and dispatch state. Prepared vector payloads live in
`memory_update_vector_intents`, one row per target index/vector ID. Model output is
therefore generated once and replayed byte-for-byte.

`memories.mutation_version` is a monotonic optimistic-concurrency token and
`last_mutation_id` fences operations that calculate the same target version. The D1
commit is one guarded batch: compare-and-swap the memory row, replace its graph,
insert deterministic history, and advance the ledger. Every statement is guarded
by owner, active state, and target version, so a failed CAS cannot mutate graph or
history.

After D1 commits, vector intents are upserted idempotently. A queue consumer and a
scheduled dispatcher reclaim expired leases and replay incomplete mutations. The
synchronous API attempts the whole state machine first, retaining the current
success response. Durable transient failures return a retryable error with the
mutation ID; version and target conflicts return HTTP 409.

Metadata-only updates remain D1-only, but use the same version CAS. Delete also
increments the version with CAS. An update that observes deletion after an
external vector write performs compensating memory-vector deletion, preventing a
late upsert from resurrecting search state.

## State Machine

- `queued`: durable target exists and may be dispatched.
- `preparing`: a leased worker is extracting graph and embeddings.
- `prepared`: graph and all vector intents are durable.
- `d1_committed`: the memory, graph, history, and version are atomically committed.
- `vectors_committed`: every target vector intent has been accepted.
- `completed`: active target version was verified.
- `superseded`: target was deleted/replaced after D1 commit and its memory vector
  was cleaned.
- `failed_conflict`: base version or target conflicts terminally.

Lease tokens fence phase transitions. Replaying a phase is safe: D1 identifiers
and history IDs are deterministic, graph writes are guarded, and Vectorize upserts
repeat the persisted payload.

## API Semantics

Native PATCH and Hermes PUT keep their existing success bodies. Exact-content
conflicts keep the existing 409 response. Optimistic concurrency conflicts use a
distinct 409 response. Recoverable infrastructure failures use 503 with
`Retry-After` and `mutation_id`; recovery continues independently.

An identical target reuses an incomplete mutation. A different content target is
rejected while a mutation for the same memory is nonterminal.

## Testing

Regression tests inject failures before preparation, inside the D1 batch, after
each vector intent, and before every phase transition. Concurrency tests cover
update/update, update/delete, delete/update, and metadata/content races. Completion
assertions compare D1 content/hash/version, graph links and evidence, vector
payloads, deterministic history, vector intents, and terminal ledger status.

The full verification gate is `npm test` followed by `npm run typecheck`.
