# Hermes V1 Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Worker compatible with Hermes Agent when its self-hosted Mem0 base URL ends in `/v1`.

**Architecture:** Normalize Hermes transport fields at the Hono route boundary and invoke the existing memory service. Keep native `/v1/memories` operations intact and add only the `/v1/search` alias needed by Hermes.

**Tech Stack:** TypeScript, Hono, Vitest, Cloudflare Workers.

---

### Task 1: Hermes Search Normalization

**Files:**
- Modify: `tests/memories.test.ts`
- Modify: `src/routes/memories.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing `/v1/search` and native-path compatibility tests**

```ts
body: JSON.stringify({
  query: 'Where does the user live?',
  top_k: 7,
  filters: { user_id: 'hermes-user', agent_id: 'neko-chan', channel: 'discord' },
})
```

Assert `searchMemories` receives `user_id`, `agent_id`, `limit: 7`, and remaining metadata filters.

- [ ] **Step 2: Run the focused test and observe the missing `/v1/search` route**

Run: `npm.cmd test -- tests/memories.test.ts`

- [ ] **Step 3: Add a request normalizer and alias**

Use a discriminated parser at the route boundary that maps `top_k` to `limit` and extracts identity fields from `filters` while preserving the remaining filter entries.

- [ ] **Step 4: Rerun focused tests**

Run: `npm.cmd test -- tests/memories.test.ts`

### Task 2: Hermes Item Operations

**Files:**
- Modify: `tests/memories.test.ts`
- Modify: `src/routes/memories.ts`

- [ ] **Step 1: Write failing `PUT {text}` and unscoped `DELETE` tests using a 64-character SHA-256-like ID**

```ts
const id = 'a'.repeat(64);
```

Assert both operations resolve the stored owner through `getMemoryById` and call the existing service with that owner.

- [ ] **Step 2: Run the focused test and observe the current 404/400 behavior**

Run: `npm.cmd test -- tests/memories.test.ts`

- [ ] **Step 3: Add owner-resolved PUT and DELETE fallbacks**

Keep query-scoped PATCH and DELETE behavior unchanged. Use the existing `getMemoryById`, `updateMemory`, and `deleteMemory` services.

- [ ] **Step 4: Rerun focused tests**

Run: `npm.cmd test -- tests/memories.test.ts`

### Task 3: Documentation and Release Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the Hermes `/v1` configuration and supported transport aliases**

- [ ] **Step 2: Run full verification**

Run: `npm.cmd test; npm.cmd run typecheck; git diff --check`

- [ ] **Step 3: Deploy and remove the compatibility probe through the repaired route**

Use an authenticated request only after the full suite passes. Verify the probe is absent from active D1 records.
