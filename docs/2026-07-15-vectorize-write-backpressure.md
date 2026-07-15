# Vectorize Write Backpressure Follow-up

Status: phase one implemented and deployed on 2026-07-15.

## Summary

The memory queue currently assumes that a successful queue invocation means every
downstream write can safely be treated as final. That assumption is false for
Vectorize. A burst of queued memory jobs produced:

```text
VECTOR_UPSERT_ERROR (code = 40041): Too Many Requests
```

This is a write-backpressure defect. Cloudflare Queue consumer autoscaling can
create more concurrent Vectorize upserts than the index will accept. The current
handler records this as a failed memory request instead of classifying it as a
transient failure and retrying with delay.

## What Cloudflare Publishes

Cloudflare's Vectorize limits document these relevant hard limits:

- A Workers binding `upsert` batch may contain at most 1,000 vectors.
- The HTTP API accepts batches of at most 5,000 vectors.
- A `list-vectors` page contains at most 1,000 vectors.

Cloudflare does **not** publish a numeric requests-per-second or concurrent
upsert limit for the Vectorize Workers binding. The Vectorize documentation does
explicitly advise leaving sufficient time between consecutive list requests to
avoid rate limits, and its bulk-insert guidance recommends large batches to
avoid excessive control-plane API calls. Treat `40041` as dynamic downstream
backpressure, not as evidence of a stable fixed QPS threshold.

The general Cloudflare REST API allowance of 1,200 requests per five minutes per
user/account token is a separate control-plane limit. It does not establish the
runtime capacity of a Worker calling its bound Vectorize index.

References:

- <https://developers.cloudflare.com/vectorize/platform/limits/>
- <https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/>
- <https://developers.cloudflare.com/vectorize/best-practices/list-vectors/>
- <https://developers.cloudflare.com/fundamentals/api/reference/limits/>

## Incident Evidence

During the graph rebuild, a large set of `async: true` memory writes was sent to
the Worker queue. Queue consumers autoscaled and the resulting Vectorize
upserts were rejected with `40041`. The same workload was stable when retried
through a small number of synchronous writers. This demonstrates that consumer
parallelism is the trigger, while rate limiting is the rejection mechanism.

Each inferred memory can produce more than one write:

1. one memory vector upsert;
2. zero or more entity vector upserts;
3. D1 memory, entity, relationship, and link writes.

Therefore queue-message concurrency understates the actual Vectorize write
pressure.

## Current Failure Mode

`createMemoriesForLease` upserts a memory vector before inserting the memory row.
It subsequently upserts entity vectors while persisting the extracted graph.
When an upsert receives `40041`, the request ledger is marked `failed`.

That ordering avoids a created memory row without its primary memory vector,
which makes an idempotent retry viable. However, treating the rate limit as a
terminal ledger failure has two bad effects:

- Queue delivery is acknowledged instead of retried with backoff.
- Bulk writes require an operator to identify and resubmit failed request IDs.

## Phase One Implementation

Phase one makes Mem0 migration imports durable and recoverable without changing
the Dashboard UI:

- Every import item is written first to the D1 `mem0_import_requests` ledger.
  Queue messages contain only the stable request ID; the ledger remains the
  canonical owner and payload source.
- A consumer claims work with a fencing token. After Vectorize accepts the
  upsert, memory, history, and ledger completion are published together in one
  lease-conditional D1 batch. A stale consumer cannot publish D1 state.
- Queue deliveries are serialized with `max_batch_size = 1` and
  `max_concurrency = 2`. Vectorize `40041`, HTTP 429, timeouts, and server
  failures retry with exponential delay before moving to the configured DLQ.
- Dispatch has a separate lease. A two-minute scheduled handler republishes
  ledger rows left unpublished by a producer interruption without repeatedly
  publishing ordinary Queue backlog.

`completed` means Vectorize accepted the durable mutation and the D1 state was
published atomically. Vectorize query visibility can still lag temporarily due
to its eventual-consistency model; it no longer leaves an import permanently
present only in D1 after an upsert failure.

Deferred from phase one:

- batching vectors across multiple Queue messages;
- Dashboard queue and per-import progress views;
- dedicated rebuild and maintenance queues;
- durable, graph-aware exact-text deduplication maintenance runs.

## Remediation Plan

Phase one implements sections 1 and 2 plus the durable import ledger and
producer-gap recovery described above. The remaining sections are follow-up
work.

### 1. Bound Queue Consumer Concurrency

Set an explicit initial ceiling on the memory queue consumer, likely
`max_concurrency = 2`. Cloudflare queues otherwise autoscale consumer
invocations to reduce backlog, which is desirable only when all downstream
services can tolerate the resulting burst.

Keep `max_batch_size` deliberately small while measuring the workload. The
default Queue batch size is 10, so an invocation may already contain multiple
memory writes even with a low consumer-concurrency ceiling.

The ceiling is a guardrail, not the entire solution. It should be adjusted from
observed success rate, latency, queue depth, and Vectorize `40041` telemetry.

Reference: <https://developers.cloudflare.com/queues/configuration/consumer-concurrency/>

### 2. Retry Transient Vectorize Failures

Classify `VECTOR_UPSERT_ERROR` code `40041`, HTTP `429`, and equivalent
transient Vectorize transport failures as retryable. The queue handler must not
acknowledge the message as a final business failure in these cases.

Use delayed retries with exponential backoff and jitter. A fixed consumer
`retry_delay` is a useful baseline; per-message retry delays are preferable
when the handler can distinguish the attempt number. Retain a dead-letter queue
for messages that exceed the configured retry budget, with enough request
context for safe manual replay.

Reference: <https://developers.cloudflare.com/queues/configuration/batching-retries/>

### 3. Batch Vectorize Writes Inside a Queue Delivery

Do not issue one `upsert` per memory or entity. Accumulate vectors by index for
the delivered Queue batch, deduplicate by vector ID, then call:

- one or a small number of `VECTORIZE.upsert(...)` operations for memory
  vectors; and
- one or a small number of `ENTITY_VECTORIZE.upsert(...)` operations for entity
  vectors.

The 1,000-vector Workers batch limit is an upper bound, not a recommended
operating size. Start with substantially smaller chunks and tune with measured
backpressure.

This requires an explicit consistency design: D1 rows and vectors are separate
systems and cannot share an atomic transaction. The request ledger should remain
the recovery authority and record enough progress to safely resume a partially
completed delivery.

### 4. Add Observability and a Rebuild Mode

Record at least:

- queue backlog and active consumer count;
- Vectorize upsert count, batch size, latency, and `40041` count per index;
- request-ledger status transitions and retry attempt count;
- D1/vector consistency repair actions.

For large migrations, add a dedicated throttled rebuild path instead of relying
on the user-facing memory queue's normal autoscaling policy.

### 5. Surface Processing State in the Dashboard

The dashboard must expose queue progress from the D1 request ledger rather than
requiring an operator to inspect Cloudflare's dashboard.

Provide two related but deliberately different views:

- A global, always-visible processing indicator aggregating all active ledger
  records: `queued`, `processing`, and `failed`. This is queue health, not a
  percentage, because new requests can continuously change the total work.
  When work is active, render an indeterminate progress bar alongside counts
  such as `124 queued`, `3 processing`, and `2 need attention`.
- A per-import-run progress view for imports such as "Import from Mem0". An
  import run has a fixed submitted total, so it can show a determinate progress
  bar: `completed + failed + pending = total`. It must distinguish retrying
  from terminal failure and expose failure reasons plus a retry action.

Add a dashboard-only, read-only aggregation endpoint backed by the request
ledger. Poll it while active (for example every 3-5 seconds), then reduce or
stop polling while idle. Do not infer completion from Queue backlog alone: the
ledger is the source of truth for the service's durable, user-visible state.

### 6. Move Exact-Text Deduplication to Durable Maintenance Runs

Keep the existing product rule: only memories with exactly equal stored text are
duplicates. Deduplication must remain scope-local and must never compare across
`user_id` or `agent_id`.

The execution model must change. A dashboard button that synchronously
soft-deletes D1 rows and then directly deletes vectors has the same Vectorize
backpressure problem as ingestion. It can also leave graph edges whose only
evidence is a deleted memory, or orphaned entity vectors.

Replace the synchronous operation with a durable dedupe maintenance run:

1. The dashboard creates a run and returns its ID immediately.
2. A stable D1 snapshot identifies each exact-text duplicate group and selects a
   deterministic canonical memory. Prefer the earliest source creation time,
   then the earliest local creation time as a fallback.
3. The transaction soft-deletes noncanonical memories and records durable
   cleanup/outbox work for their memory vectors and graph evidence.
4. A background maintenance consumer batches and retries Vectorize deletes,
   removes relationships supported only by deleted memories, and garbage
   collects unreferenced entities and their vectors.
5. The run becomes `completed` only after its D1, vector, graph, and entity
   cleanup work has completed. A `failed` or dead-lettered step remains visible
   and retryable in the dashboard.

Use a separate low-concurrency maintenance queue rather than the user-facing
memory ingestion queue. This prevents large imports from being delayed by
cleanup while preventing cleanup work from creating a second Vectorize burst.

Do not start a dedupe run while an import or memory rebuild is active for the
same scope. Disable the action or require a stable-snapshot confirmation in the
dashboard, so the result cannot be misrepresented as a complete deduplication
of moving data.

## Acceptance Criteria

Phase-one acceptance covers durable import publication, bounded consumers,
delayed transient retries, idempotent replay, and producer-gap recovery. The
batching, Dashboard, metrics, and dedupe criteria below remain follow-up work.

- A burst larger than the normal downstream capacity drains without terminal
  `failed` ledger records caused solely by Vectorize rate limits.
- Delayed retries eventually complete after a synthetic `40041` response.
- Vector upserts are batched per queue delivery and stay within the Worker
  batch-size limit.
- A replay is idempotent across retries, worker restarts, and partial D1/vector
  completion.
- Metrics make it possible to tune consumer concurrency using evidence rather
  than a guessed fixed Vectorize QPS limit.
- Dashboard queue health and per-import-run progress remain consistent with the
  request ledger, without requiring the Cloudflare dashboard for routine
  operation.
- Exact-text deduplication is scope-local, resumable, graph-aware, and cannot
  leave vector or graph cleanup permanently incomplete after a transient error.
