# Memory Update Mutation Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make memory content updates recoverable and concurrency-safe across D1, graph storage, and Vectorize.

**Architecture:** Add a versioned durable mutation ledger and persisted vector intents. Commit D1 state with a guarded atomic batch, then replay idempotent vector intents through the existing queue and scheduled dispatcher.

**Tech Stack:** TypeScript, Cloudflare Workers, D1/SQLite, Vectorize, Drizzle ORM, Vitest.

---

### Task 1: Schema and migration

**Files:**
- Create: `src/migrations/0009_memory_update_mutations.sql`
- Modify: `src/db/schema.ts`
- Test: `tests/schema.test.ts`

- [ ] Add a failing migration test asserting `memories.mutation_version`, both ledger tables, terminal/nonterminal constraints, and dispatcher indexes.
- [ ] Run `npx vitest run tests/schema.test.ts` and confirm it fails because migration 0009 is absent.
- [ ] Add the migration and exact Drizzle mappings.
- [ ] Re-run the schema test and confirm it passes.

### Task 2: Durable update state machine

**Files:**
- Create: `src/memory/update-mutations.ts`
- Modify: `src/memory/service.ts`
- Test: `tests/memory-update-consistency.test.ts`

- [ ] Add a minimal failing test proving extraction/embedding failure leaves memory and graph unchanged.
- [ ] Add a failing two-update CAS test proving at most one base version commits.
- [ ] Add failing phase-interruption tests proving persisted payload replay converges without another model call.
- [ ] Implement deterministic mutation IDs, canonical targets, lease claims, preparation persistence, guarded D1 commit, vector-intent replay, and terminal verification.
- [ ] Run `npx vitest run tests/memory-update-consistency.test.ts` after each red/green cycle.

### Task 3: Metadata and delete fencing

**Files:**
- Modify: `src/memory/service.ts`
- Test: `tests/memory-update-consistency.test.ts`
- Test: `tests/memory-graph-mutations.test.ts`

- [ ] Add failing metadata/content and update/delete race tests.
- [ ] Implement version-CAS metadata batches and delete fencing with late-vector compensation.
- [ ] Run both focused test files and confirm all cases pass.

### Task 4: Queue recovery and dispatcher

**Files:**
- Modify: `src/env.ts`
- Modify: `src/queue.ts`
- Modify: `src/index.ts`
- Modify: `src/memory/update-mutations.ts`
- Test: `tests/queue.test.ts`
- Test: `tests/import.test.ts`

- [ ] Add failing tests for update job routing, transient retry, terminal ack, expired dispatch leases, and both scheduled dispatchers running.
- [ ] Implement the job type, queue handler, publish lease, scheduled recovery, and stale processing lease reclaim.
- [ ] Run the focused queue/import tests and confirm they pass.

### Task 5: HTTP conflict and retry semantics

**Files:**
- Modify: `src/routes/memories.ts`
- Modify: `src/routes/hermes.ts`
- Test: `tests/memories.test.ts`

- [ ] Add failing Native and Hermes tests for mutation 409 and durable 503 responses.
- [ ] Add distinct mutation conflict/retry error classes and route mappings while preserving existing duplicate-content responses.
- [ ] Run `npx vitest run tests/memories.test.ts` and confirm it passes.

### Task 6: Full convergence verification

**Files:**
- Modify only files required by failures found in verification.

- [ ] Run `npm test` and require zero failures.
- [ ] Run `npm run typecheck` and require exit code 0.
- [ ] Run `graphify update .` and inspect affected update/delete call paths.
- [ ] Review `git diff --check`, `git status --short`, and the final diff against every design requirement.
