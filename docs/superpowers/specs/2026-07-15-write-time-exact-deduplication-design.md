# Write-Time Memory Deduplication Design

**Date:** 2026-07-15

## Goal

Prevent duplicate active memories at write time across every creation path,
remove the Dashboard's manual cleanup workflow, and perform one final cleanup of
existing exact duplicates before enabling database-enforced uniqueness.

Deduplication has two layers:

1. exact-text deduplication is always enabled and enforced within the complete
   memory ownership scope;
2. semantic deduplication is a Dashboard-managed global setting, defaults to
   disabled, and uses a separately configured LLM to reject a new memory only
   when it restates an existing memory without adding or changing information.

Existing memories are not compared semantically during migration. Semantic
deduplication applies only when a new memory is processed after the setting is
enabled.

## Scope Identity

Both layers use the complete memory ownership scope:

- user and agent: `(user_id, agent_id)`;
- user only: `(user_id, NULL)`;
- agent only: `(NULL, agent_id)`.

The same text or fact may exist for different users, different agents, or
different user-agent pairs. `run_id`, `actor_id`, metadata, and timestamps do
not change deduplication identity.

Only active rows participate. A row with `deleted_at IS NOT NULL` does not block
the same text or fact from being created as a new active memory. The old row and
its history remain unchanged.

## Exact-Text Contract

Exact comparison uses the content that each path would otherwise store. It is
case-sensitive and does not collapse internal whitespace, punctuation, or
Unicode variants.

Existing path-specific behavior remains intact:

- extracted and direct API candidates retain their current trimming behavior;
- Mem0 migration imports continue preserving source memory text verbatim.

Deduplication introduces no additional normalization.

Each memory stores `content_hash`, the lowercase hexadecimal SHA-256 digest of
its final stored content. The existing `hash` column remains the originating
request/idempotency hash and is not reused. `content_hash` is an indexed lookup
accelerator, not the final equality authority: exact queries match both the
digest and original content.

## Database Enforcement

The schema adds a required `content_hash` column and three partial unique
indexes:

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

These indexes are the exact-deduplication concurrency authority. Application
lookups avoid unnecessary model and Vectorize work, but exact correctness does
not depend on a check-then-insert sequence.

Rows with both owners null are outside supported creation paths and are not
covered by these indexes. This change does not add an ownership constraint that
could reject unrelated legacy data.

## Shared Write Pipeline

Every inferred add, direct add, synchronous request, Queue consumer, and Mem0
import uses the same candidate persistence pipeline:

1. Compute `content_hash` from final stored content.
2. Look up an active exact match in the complete ownership scope.
3. If found, return that canonical memory without embedding, history, graph, or
   metadata changes.
4. If semantic deduplication is enabled, generate the candidate embedding and
   retrieve same-scope Vectorize candidates above the configured threshold.
5. If candidates exist, ask the dedicated deduplication LLM whether one is an
   information-equivalent restatement.
6. If the LLM selects a candidate, return that existing memory unchanged and do
   not create a vector, row, history event, or graph evidence for the new text.
7. Otherwise, reuse the already-generated embedding, or generate one if the
   semantic layer was disabled, and upsert the new candidate vector.
8. Insert the memory with conflict-safe returning semantics.
9. If the insert wins, append history and persist graph data as today.
10. If an exact-text insert loses to a concurrent writer, fetch and return the
    canonical row and delete the losing Vectorize ID when necessary.

Every normal add and import already has a durable request ledger. If a Worker
stops after vector upsert or conflict but before cleanup, retrying the same
request uses the same candidate ID, observes the canonical row, and retries
orphan-vector deletion before completing the ledger request.

Duplicate writes return the existing canonical memory in the normal response.
They do not return an empty result and never mutate canonical content, metadata,
timestamps, history, vectors, or graph evidence.

Exact deduplication is race-safe through D1 uniqueness. Semantic deduplication
is intentionally best-effort under concurrency: two differently worded facts
that are written simultaneously can both pass before either becomes searchable.
Preventing that case would require serializing all writes per ownership scope,
which is outside this design.

## Vector Candidate Retrieval

Each memory vector includes a deterministic `scope_key` metadata value derived
from the complete `(user_id, agent_id)` pair, including null positions. The
value is a lowercase SHA-256 digest of a canonical JSON tuple. A Vectorize
metadata index on `scope_key` enables pre-filtering before `topK`, so unrelated
owners cannot consume the semantic candidate limit.

Semantic lookup:

- filters by exact `scope_key`;
- requests at most `DEDUP_CANDIDATE_LIMIT` candidate vectors;
- drops results below `DEDUP_SIMILARITY_THRESHOLD`;
- resolves returned vector IDs through D1 and revalidates active state and the
  complete ownership scope before sending any text to the LLM;
- sorts candidates by descending vector score, then `created_at`, then ID.

Similarity scores are not sent to the LLM because the threshold has already
performed candidate gating and the scores could anchor its decision. Existing
vectors receive `scope_key` metadata through the exact-deduplication backfill
and Vectorize re-upsert, but existing memories are not semantically compared to
one another.

## Semantic LLM Configuration

Semantic deduplication has dedicated configuration and never falls back to the
fact-extraction or graph LLM credentials:

| Name | Type | Purpose |
| --- | --- | --- |
| `DEDUP_LLM_API_BASE_URL` | plaintext variable | OpenRouter API base URL |
| `DEDUP_LLM_MODEL` | plaintext variable | model slug used only for deduplication |
| `DEDUP_LLM_API_KEY` | secret | credential used only for deduplication |
| `DEDUP_SIMILARITY_THRESHOLD` | plaintext variable | minimum Vectorize score; default `0.85` |
| `DEDUP_CANDIDATE_LIMIT` | plaintext variable | maximum LLM candidates; default `8`, capped at `20` |

The implementation targets OpenRouter's chat-completions structured-output
contract. It sends `temperature: 0`, `response_format.type: "json_schema"`, a
strict schema, and `provider.require_parameters: true`. Enabling semantic
deduplication without all three LLM settings produces a configuration error on
new writes; no other API key is substituted.

## Semantic LLM Input

The server assigns opaque, request-local references. It never exposes database
IDs, ownership IDs, similarity scores, metadata, or unrelated timestamps:

```json
{
  "new_memory": {
    "ref": "NEW",
    "text": "The user resides in Zurich."
  },
  "candidates": [
    {
      "ref": "M1",
      "text": "The user lives in Zurich."
    },
    {
      "ref": "M2",
      "text": "The user previously lived in Zurich."
    }
  ]
}
```

The server retains the `M*` to memory-ID mapping. Candidate memory text is
explicitly marked as untrusted data rather than instructions.

The system prompt limits the task to information equivalence. The model may
select a candidate only when subject, relation, object, polarity, time, status,
quantity, conditions, and material qualifiers assert the same durable fact.
Different facts about the same topic are not duplicates.

The model must return no match for:

- contradictions, negations, or state changes;
- newer or older temporal facts;
- subset/superset pairs containing material additional information;
- facts that require inference rather than direct equivalence;
- ambiguous or uncertain comparisons.

It must not merge, rewrite, summarize, or invent facts. If multiple candidates
are equivalent, it selects the first candidate in the supplied order.

## Semantic LLM Output

The server dynamically restricts `duplicate_of` to the current candidate
references plus null:

```json
{
  "type": "object",
  "properties": {
    "duplicate_of": {
      "type": ["string", "null"],
      "enum": ["M1", "M2", null]
    }
  },
  "required": ["duplicate_of"],
  "additionalProperties": false
}
```

`{"duplicate_of":"M1"}` means discard the new memory and return `M1`'s full
canonical D1 record. `{"duplicate_of":null}` means continue creating the new
memory. There is no confidence field, free-text rationale, or independent
decision field that could conflict with the selected reference.

The Worker validates parsed JSON against the candidate-reference whitelist even
after provider-side schema enforcement. Invalid JSON, an unknown reference, an
empty response, or a provider refusal is a transient write failure; it never
causes the new memory to be discarded.

## Request-Local Deduplication

Before persistence:

- LLM extraction output and direct-add candidates are deduplicated by exact
  final content within the request, preserving the first candidate;
- a Mem0 import payload is deduplicated within its selected user or agent scope
  before ledger rows are created.

For repeated import items with distinct source timestamps, choose the item with
the earliest valid `created_at`; null timestamps sort after valid timestamps,
and original input order breaks ties. This preserves the oldest available
source record. The import endpoint's `queued` count reports the number of unique
items submitted to the durable ledger.

An import that matches active storage may still create a ledger item, but
processing completes against the canonical memory without creating another
memory or vector.

## Dashboard System Setting

The Dashboard replaces the manual deduplication view with a **System settings**
view. A single toggle controls semantic deduplication globally:

- label: `Semantic memory deduplication`;
- default: off;
- off: all paths still use exact-text deduplication;
- on: all new-memory paths run the Vectorize and LLM checks described above;
- read-only previews display the value but cannot change it.

A singleton D1 settings row stores the boolean rather than an environment
variable, allowing the Dashboard to change it without redeployment. Signed
Dashboard endpoints expose only this supported setting. Queue consumers read
the setting when processing each candidate, so the current value, not the value
at submission time, controls queued work.

Configuration values and API keys remain deployment settings and are never
returned to the browser. Enabling the toggle verifies that the dedicated base
URL, model, and API key are present; missing configuration rejects the setting
change with a generic configuration error. It does not expose values or make a
model request. Every write defensively validates configuration again.

## Existing Production Cleanup

Adding a non-null digest to existing rows requires a two-phase schema rollout:

1. migration `0007` adds nullable `content_hash` and the singleton settings row
   without exact uniqueness;
2. an intermediate Worker deployment writes `content_hash` and vector
   `scope_key` metadata for every new memory;
3. after writers are paused and the Queue is drained, a resumable maintenance
   command pages through existing rows, computes SHA-256 locally, backfills D1,
   and re-upserts vector metadata in bounded batches;
4. the command computes exact duplicate groups by
   `(user_id, agent_id, content_hash, content)` over active rows;
5. after cleanup and verification, migration `0008` rebuilds `content_hash` as
   `NOT NULL` and creates the three unique partial indexes.

The maintenance command must be resumable: updating an already-correct digest,
re-upserting matching vector metadata, and reapplying the same loser mapping are
no-ops. Keep the active row ordered first by `created_at ASC, id ASC`; every
other row in an exact duplicate group is a loser.

For each loser-to-canonical mapping, one-time cleanup must:

1. copy its `memory_entity_links` to the canonical memory with conflict-safe
   inserts;
2. repoint `relationships.evidence_memory_id` to the canonical memory;
3. soft-delete the loser memory;
4. delete the loser's memory vector from Vectorize.

D1 changes are applied transactionally before vector deletion. If Vectorize
cleanup is interrupted, stale vectors cannot produce active results because D1
revalidation rejects soft-deleted rows; rerunning deletion is safe. Do not apply
migration `0008` until verification reports zero null or mismatched content
hashes and zero active exact duplicate groups.

The cleanup does not semantically compare existing memories and does not delete
memory history, entities, relationships, or entity vectors.

## Dashboard Manual Cleanup Removal

Remove the manual exact-text deduplication feature completely:

- navigation item and view markup;
- summary, confirmation, loading, and invalidation JavaScript;
- `GET` and `POST /dashboard/api/deduplication` routes;
- Dashboard deduplication service functions and response types;
- read-only-preview control handling specific to manual deduplication;
- feature tests and README instructions.

Search, all-memory browsing, graph viewing, imports, aliases, reindexing, and
agent reclassification remain unchanged. System settings take the removed
navigation entry's role; they do not provide a bulk cleanup action.

## Failure Handling

- Database uniqueness conflicts are expected exact-deduplication concurrency
  outcomes, not request failures.
- A stored digest and vector `scope_key` are always computed by the Worker;
  callers cannot provide or override them.
- A losing vector cleanup failure is transient and leaves the durable request
  retryable.
- Embedding or Vectorize failure before a successful insert creates no active
  D1 memory.
- Missing semantic LLM configuration, provider failure, invalid structured
  output, or an unknown candidate reference fails and retries the write instead
  of failing open or discarding the candidate.
- A soft-deleted match never becomes canonical for a new request.
- Cleanup migration failure leaves writers paused and is resumed before unique
  index creation.

## Tests

Automated coverage must include:

- content-hash and scope-key generation for null and non-null owner pairs;
- backfill resumption and detection of null or mismatched hashes;
- all three partial unique indexes and soft-delete exclusion;
- identical user-agent scope returns one active memory;
- same text under a different user or agent remains distinct;
- user-only and agent-only scope behavior;
- soft-deleted text can be created as a new active row;
- duplicate direct, inferred, synchronous, queued, and imported adds return the
  canonical memory without extra embedding, history, or graph writes;
- duplicate import items create one ledger item and preserve the oldest source
  timestamp;
- a concurrent exact-index loser resolves the winner and cleans its candidate
  vector, including retry after cleanup failure;
- same-scope Vectorize pre-filtering, thresholding, candidate caps, ordering,
  and D1 active/scope revalidation;
- semantic setting defaults off and Queue consumers read it at processing time;
- strict semantic input excludes IDs, scores, metadata, and timestamps;
- structured-output schema permits only current candidate references or null;
- equivalent paraphrases are discarded while contradictions, temporal changes,
  material additions, and uncertain matches are retained;
- duplicate semantic decisions create no vector, row, history, or graph data;
- invalid LLM output and provider failures retry without discarding the memory;
- existing embeddings are reused when the semantic decision is distinct;
- Dashboard signed settings read/update behavior and read-only-preview behavior;
- Dashboard HTML and routes no longer expose manual deduplication;
- the complete existing test suite remains green.

## Deployment Sequence

1. Prepare migrations `0007` and `0008`, the resumable maintenance command,
   shared exact pipeline, `scope_key` vector metadata, semantic service, and
   Dashboard setting behind its default-off value.
2. Apply migration `0007`, create the Vectorize `scope_key` metadata index, and
   deploy intermediate dual-write code with semantic deduplication off.
3. Pause Hermes writes and drain Queue work.
4. Backfill hashes and scope metadata and export the deterministic exact
   duplicate mapping.
5. Apply graph-preserving soft deletion and remove loser vectors.
6. Confirm zero null/mismatched hashes, exact duplicate groups, missing scope
   metadata, and loser vectors.
7. Apply migration `0008` and deploy the final exact-deduplication pipeline and
   Dashboard manual-cleanup removal.
8. Configure the dedicated deduplication endpoint, model, and secret while the
   toggle remains off.
9. Run exact scope, soft-delete recreation, synchronous, queued, and import
   probes and clean up their records.
10. Enable semantic deduplication in the Dashboard for a bounded paraphrase,
    contradiction, temporal-change, and provider-failure probe.
11. Disable the probe setting if verification fails; otherwise leave it at the
    operator's chosen value and resume Hermes writes.

## Explicitly Not Included

- retroactive semantic comparison or consolidation of existing memories;
- semantic uniqueness guarantees for simultaneous differently worded writes;
- merging, rewriting, or replacing canonical memory text;
- updating canonical metadata from a duplicate request;
- deduplicating entities or relationships independently;
- a general-purpose background deduplication maintenance system;
- a replacement Dashboard bulk-cleanup interface;
- exposing model credentials or configuration through Dashboard APIs.
