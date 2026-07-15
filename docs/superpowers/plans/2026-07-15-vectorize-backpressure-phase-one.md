# Vectorize Backpressure Phase One Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bulk Mem0 imports eventually consistent across D1 and Vectorize while bounding Queue write pressure and preserving failed work for recovery.

**Architecture:** D1 becomes the durable authority for every imported item through a `mem0_import_requests` ledger. Queue delivery contains only a request ID and acts as a trigger: a worker claims and reads the canonical ledger row, waits for Vectorize to accept the mutation, then atomically publishes memory, history, and completion through a lease-fenced D1 batch. Queue concurrency and batch size are bounded, transient failures use delayed retries, exhausted deliveries enter a DLQ, and a dispatch lease lets cron recover producer gaps without repeatedly publishing legitimate backlog.

**Tech Stack:** Cloudflare Workers, Queues, D1, Vectorize, Drizzle ORM, TypeScript, Vitest, Wrangler.

---

### Task 1: Add the durable import ledger

**Files:**
- Create: `src/migrations/0006_mem0_import_requests.sql`
- Modify: `src/db/schema.ts`
- Modify: `tests/schema.test.ts`

- [x] **Step 1: Write a failing schema test**

Add assertions that `mem0ImportRequests` has `request_id` as its primary key, contains owner, payload, status, attempt, error, timestamp, and lease columns, and that migration `0006` creates the table plus `mem0_import_requests_status_updated_at_idx`.

- [x] **Step 2: Run the schema test and confirm RED**

Run: `npm.cmd test -- tests/schema.test.ts`

Expected: FAIL because `mem0ImportRequests` and migration `0006` do not exist.

- [x] **Step 3: Add the migration and Drizzle schema**

Create a table with this contract:

```sql
CREATE TABLE mem0_import_requests (
  request_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('user', 'agent')),
  entity_id TEXT NOT NULL,
  item_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token INTEGER NOT NULL DEFAULT 0,
  publish_token INTEGER NOT NULL DEFAULT 0,
  publish_attempted_at INTEGER,
  published_at INTEGER,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);
CREATE INDEX mem0_import_requests_status_updated_at_idx
  ON mem0_import_requests (status, updated_at);
```

- [x] **Step 4: Run the schema test and confirm GREEN**

Run: `npm.cmd test -- tests/schema.test.ts`

Expected: PASS.

### Task 2: Make import processing fenced and eventually consistent

**Files:**
- Modify: `src/import/service.ts`
- Modify: `tests/import.test.ts`

- [x] **Step 1: Write failing import consistency tests**

Cover these behaviors:

```ts
it('persists every canonical import item before publishing request-id triggers');
it('accepts the Vectorize mutation before atomically publishing memory and history in D1');
it('marks a vector failure as failed without inserting a memory row');
it('reclaims a failed item and completes it idempotently on retry');
it('does not process an already completed import item twice');
it('ignores a conflicting queue payload and processes the canonical ledger item');
it('prevents a stale lease from publishing memory or history');
```

The tests must assert call order, ledger status transitions, stable request IDs, and user/agent ownership.

- [x] **Step 2: Run focused import tests and confirm RED**

Run: `npm.cmd test -- tests/import.test.ts`

Expected: FAIL because no persistent import ledger or fenced processing exists.

- [x] **Step 3: Implement the import state machine**

Add focused helpers in `src/import/service.ts`:

```ts
type ProcessImportResult = 'processed' | 'noop' | 'inflight';

async function ensureLegacyImportRequest(env: Env, job: Mem0ImportJob): Promise<void>;
async function claimImportRequest(env: Env, requestId: string): Promise<ImportClaim | undefined>;
async function publishClaimedImport(env: Env, claim: ImportClaim, mutationId?: string): Promise<boolean>;
async function failImportRequest(env: Env, requestId: string, leaseToken: number, error: unknown): Promise<void>;
```

`enqueueMem0Import` must insert all deterministic ledger rows before sending request-ID-only messages. `processMem0ImportJob` must create a ledger row only for a valid pre-ledger legacy job, claim with a lease token, and process only the owner and item read back from the canonical ledger. After embedding and accepted Vectorize upsert, one `env.DB.batch()` must use lease-conditional `INSERT ... SELECT` statements for memory and history plus a lease-conditional completion update. A stale lease must publish no D1 rows. On failure it must fence a `failed` update and rethrow. Vectorize query visibility is eventually consistent; completion means its durable mutation was accepted, not that a query already observes it.

- [x] **Step 4: Run focused import tests and confirm GREEN**

Run: `npm.cmd test -- tests/import.test.ts`

Expected: PASS.

### Task 3: Bound Queue pressure and delay transient retries

**Files:**
- Modify: `src/queue.ts`
- Modify: `tests/queue.test.ts`
- Modify: `tests/import.test.ts`
- Modify: `wrangler.toml`

- [x] **Step 1: Write failing Queue retry tests**

Cover `40041`, HTTP 429, and inflight leases. Assert that transient messages call:

```ts
message.retry({ delaySeconds: expectedBackoff });
```

and are not acknowledged. Also assert a batch never processes more than one item at a time inside one invocation.

- [x] **Step 2: Run focused Queue tests and confirm RED**

Run: `npm.cmd test -- tests/queue.test.ts tests/import.test.ts`

Expected: FAIL because messages are processed with `Promise.all` and retries have no delay.

- [x] **Step 3: Serialize batch handling and configure Queue guardrails**

Replace the batch-level `Promise.all` with ordered message processing and use exponential retry delay capped at five minutes. Configure:

```toml
[[queues.consumers]]
queue = "mem0-edge-memory-jobs"
max_batch_size = 1
max_concurrency = 2
max_retries = 8
retry_delay = 30
dead_letter_queue = "mem0-edge-memory-jobs-dlq"
```

Treat Vectorize code `40041`, HTTP 429, timeouts, and 5xx failures as transient even when the surfaced status is 400.

- [x] **Step 4: Run focused Queue tests and confirm GREEN**

Run: `npm.cmd test -- tests/queue.test.ts tests/import.test.ts`

Expected: PASS.

### Task 4: Recover producer gaps from the durable ledger

**Files:**
- Modify: `src/import/service.ts`
- Modify: `src/index.ts`
- Modify: `src/env.ts`
- Modify: `tests/import.test.ts`
- Modify: `wrangler.toml`

- [x] **Step 1: Write failing recovery tests**

Cover a producer failure after ledger persistence and assert that recovery later claims and republishes only unpublished rows whose dispatch lease is stale. A published row waiting in normal Queue backlog, completed rows, failed rows, and rows with a fresh dispatch lease must not be republished. A crash after Queue send but before `published_at` may produce one duplicate; processing leases must make that duplicate harmless.

- [x] **Step 2: Run focused recovery tests and confirm RED**

Run: `npm.cmd test -- tests/import.test.ts`

Expected: FAIL because no recovery scanner or scheduled handler exists.

- [x] **Step 3: Add stale-queued recovery**

Implement:

```ts
export async function dispatchPendingMem0Imports(env: Env, now = Math.floor(Date.now() / 1000)): Promise<number>;
```

Atomically claim at most 100 `queued` rows where `published_at IS NULL` and the dispatch lease is absent or stale by incrementing `publish_token` and setting `publish_attempted_at`. Publish compact `{ type, requestId }` triggers with `MEMORY_JOBS.sendBatch`, then conditionally set `published_at` under the same publish token. Register a scheduled Worker handler and a two-minute cron. Do not requeue `failed` rows automatically; Queue retry/DLQ policy remains the retry budget authority.

- [x] **Step 4: Run focused recovery tests and confirm GREEN**

Run: `npm.cmd test -- tests/import.test.ts`

Expected: PASS.

### Task 5: Verify, document operational setup, and deploy safely

**Files:**
- Modify: `docs/2026-07-15-vectorize-write-backpressure.md`

- [x] **Step 1: Update the remediation document**

Mark phase one implemented, document the ledger authority and vector-first visibility rule, and leave batching, Dashboard progress, and durable dedupe explicitly deferred.

- [x] **Step 2: Run complete verification**

Run:

```powershell
npm.cmd run typecheck
npm.cmd test
git diff --check
```

Expected: all commands exit 0.

- [x] **Step 3: Create the DLQ before deploying configuration**

Run: `npx.cmd wrangler queues create mem0-edge-memory-jobs-dlq`

Treat an already-existing queue as success.

- [x] **Step 4: Apply the D1 migration and deploy**

Run:

```powershell
npx.cmd wrangler d1 migrations apply mem0-edge --remote
npm.cmd run deploy
```

Expected: migration `0006` succeeds and the Worker deployment retains `mem0.yanksi.li`.

- [x] **Step 5: Verify production health and Queue configuration**

Check `/health`, inspect the deployed consumer configuration, and submit a small deterministic agent import twice. Confirm one ledger row and one memory/vector identity, with the ledger ending in `completed`.
