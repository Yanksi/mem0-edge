# Dashboard Exact-Text Deduplication Design

## Goal

Give dashboard operators a deliberate, scoped way to remove active memories that have exactly the same text, without exposing a public deduplication API.

## Scope

- Add a **Deduplicate memories** dashboard view.
- Operate on the currently selected entity only: either one user ID or one agent ID.
- Treat two records as duplicates only when their `content` values are byte-for-byte equal. Case and whitespace are significant.
- Include only active records (`deleted_at IS NULL`).
- For each duplicate group, retain the oldest record by `created_at`, then by `id` as a deterministic tie-breaker.
- Soft-delete every later duplicate, delete its Vectorize vector, and retain all `memory_history` records.
- Require an explicit browser confirmation before running cleanup.

## Exclusions

- No semantic similarity matching, text normalization, cross-entity cleanup, memory merge, public API, or background queue.
- No deletion of history, graph entities, relationships, or user aliases.

## Architecture

`src/dashboard/service.ts` owns scope-safe SQL queries and cleanup orchestration. It will expose a summary containing duplicate-group and removable-record counts plus a bounded preview, and a cleanup operation returning the removed count and vector IDs.

`src/routes/dashboard.ts` exposes authenticated dashboard endpoints for the summary and the confirmed cleanup. The cleanup handler removes D1 records first via soft deletion, then calls the existing Vectorize deletion helper for the removed IDs. A Vectorize failure is surfaced to the operator so it can be retried; D1 never hard-deletes memory or audit data.

`src/dashboard/page.ts` adds the navigation view, renders the scoped summary and preview safely with DOM APIs, and asks for a browser confirmation before its cleanup request. It refreshes the current entity list and memory view after a successful cleanup.

## Error Handling

- Missing/invalid entity scope returns `400`.
- All deduplication dashboard API calls require the existing signed dashboard session.
- A summary with no duplicates is successful and disables the cleanup action.
- Cleanup remains idempotent: rerunning after a successful cleanup returns zero removed records.
- Vectorize deletion receives only IDs soft-deleted by that request.

## Tests

- Service tests cover user and agent scoping, exact-text matching, canonical oldest selection, tie-breaking, and no-op cleanup.
- Dashboard API tests cover session protection, scope validation, summary forwarding, and cleanup forwarding.
- Dashboard render tests assert that the new navigation and API endpoints are present.
- The full Vitest suite, TypeScript typecheck, and `git diff --check` verify the finished change.
