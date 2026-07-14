# Mem0 Dashboard Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a dashboard operator import a Mem0 `RawMemoryMigrationExport` through a file or pasted JSON while preserving each source memory and its timestamps.

**Architecture:** The dashboard submits the validated export and target user ID to a signed-session route. The route creates one durable Queue job per source memory; the consumer embeds and persists it directly without LLM extraction or graph inference. Stable IDs derived from the target user, whole export, and item index make delivery retries idempotent.

**Tech Stack:** Cloudflare Workers, Hono, Queues, D1, Vectorize, TypeScript, Zod, Vitest.

---

### Task 1: Define and validate migration payloads

**Files:**
- Create: `src/import/types.ts`
- Test: `tests/import.test.ts`

- [ ] **Step 1: Write failing validation tests**

```ts
expect(parseMem0Export({ memories: [{ memory: 'Keep this verbatim.', created_at: '2026-07-14', updated_at: null }] })).toEqual(...);
expect(() => parseMem0Export({ memories: [{ memory: '' }] })).toThrow();
expect(() => parseMem0Export({ memories: [{ memory: 'x', created_at: 'not-a-date' }] })).toThrow();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/import.test.ts`
Expected: FAIL because `src/import/types.ts` does not exist.

- [ ] **Step 3: Implement the import schema**

```ts
export const Mem0MigrationExportSchema = z.object({
  memories: z.array(z.object({
    memory: z.string().min(1),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
  })).min(1),
});
```

Reject invalid non-null timestamps with `Date.parse`; export the exact JSON Schema object for rendering in the dashboard.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm.cmd test -- tests/import.test.ts`
Expected: PASS.

### Task 2: Queue migration import jobs and persist direct memories

**Files:**
- Create: `src/import/service.ts`
- Modify: `src/env.ts`
- Modify: `src/queue.ts`
- Test: `tests/import.test.ts`

- [ ] **Step 1: Write failing import-service tests**

```ts
await enqueueMem0Import(env, 'hermes', exportData);
expect(queue.send).toHaveBeenCalledTimes(exportData.memories.length);
await importMem0Memory(env, job);
expect(db.insert).toHaveBeenCalledWith(memories);
expect(embedText).toHaveBeenCalledWith(env, 'Keep this verbatim.');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/import.test.ts`
Expected: FAIL because import functions and `import-memory` queue jobs do not exist.

- [ ] **Step 3: Implement direct import persistence**

```ts
type MemoryJob =
  | { type: 'extract-and-store'; requestId: string; body: unknown }
  | { type: 'import-memory'; userId: string; importId: string; itemIndex: number; memory: string; createdAt: string | null; updatedAt: string | null };
```

Generate stable IDs from `userId`, `importId`, and `itemIndex`. Preserve valid source timestamps in `memories.created_at`/`updated_at` and metadata; use import time where a source timestamp is null. Embed the exact source text, upsert Vectorize metadata, insert the memory/history only when the stable ID is new, and do not extract graph records.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm.cmd test -- tests/import.test.ts tests/queue.test.ts`
Expected: PASS.

### Task 3: Add authenticated dashboard import API

**Files:**
- Modify: `src/routes/dashboard.ts`
- Modify: `tests/dashboard-api.test.ts`

- [ ] **Step 1: Write failing route tests**

```ts
const response = await worker.fetch(request('/dashboard/api/imports/mem0', {
  method: 'POST', headers: { Cookie: await dashboardCookie(), 'Content-Type': 'application/json' },
  body: JSON.stringify({ user_id: 'hermes', export: { memories: [{ memory: 'Imported' }] } }),
}), env);
expect(response.status).toBe(202);
expect(importService.enqueueMem0Import).toHaveBeenCalledWith(env, 'hermes', expect.any(Object));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/dashboard-api.test.ts`
Expected: FAIL with a 404 response.

- [ ] **Step 3: Implement the route**

Parse `{ user_id, export }`, validate the user ID and export object, call `enqueueMem0Import`, and return `{ queued: number }` with `202 Accepted`. Preserve the existing dashboard-session middleware as the only authentication boundary.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm.cmd test -- tests/dashboard-api.test.ts`
Expected: PASS.

### Task 4: Build the dashboard import view and document the contract

**Files:**
- Modify: `src/dashboard/page.ts`
- Modify: `tests/dashboard.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing page assertions**

```ts
expect(html).toContain('data-view="import"');
expect(html).toContain('name="target_user_id"');
expect(html).toContain('name="export_json"');
expect(html).toContain('RawMemoryMigrationExport');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/dashboard.test.ts`
Expected: FAIL because the import view is absent.

- [ ] **Step 3: Implement the import view**

Add an Import from Mem0 navigation view with a file picker, pasted JSON textarea, target-user-ID override input, embedded schema, and an import action. File selection reads its contents into the same textarea and sets the target ID from the `.json` filename only when the operator has not manually overridden it. Submit the selected target and parsed JSON to `/dashboard/api/imports/mem0`, then show the queued count.

- [ ] **Step 4: Document use and boundaries**

Add the exact export JSON Schema to the README and explain file/paste inputs, filename-derived user IDs, user-ID override, timestamp behavior, direct embedding, asynchronous Queue processing, retry idempotency, and no graph/LLM inference.

- [ ] **Step 5: Run the page tests to verify it passes**

Run: `npm.cmd test -- tests/dashboard.test.ts tests/dashboard-api.test.ts`
Expected: PASS.

### Task 5: Verify and import the requested Hermes exports

**Files:**
- Modify: none
- Test: all test files

- [ ] **Step 1: Run complete verification**

Run: `npm.cmd run typecheck; npm.cmd test; npx.cmd wrangler deploy --dry-run`
Expected: typecheck succeeds, every test passes, and Wrangler reports a valid Worker bundle.

- [ ] **Step 2: Deploy and run the two requested imports**

Deploy the Worker after obtaining or confirming production deployment permission. Import `hermes.json` as `hermes` and `hermes-user.json` as `hermes-user`; do not upload `288035119623569418.json`. Verify the dashboard reports 129 and 73 queued jobs respectively.
