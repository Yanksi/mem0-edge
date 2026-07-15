# Cytoscape Dashboard Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-written SVG graph with an animated Cytoscape.js graph loaded from a pinned CDN URL.

**Architecture:** Keep the existing user-scoped graph API. The Dashboard page loads Cytoscape's UMD build from jsDelivr, maps entity and relationship JSON into Cytoscape elements, and retains Dashboard-owned fetch, status, and node-detail behavior.

**Tech Stack:** Cloudflare Workers, Hono, TypeScript, Cytoscape.js 3.34.0 via jsDelivr, Vitest, Chrome local preview.

---

### Task 1: Replace manual SVG rendering

**Files:**
- Modify: `src/dashboard/page.ts:31,65,107-112`
- Modify: `tests/dashboard.test.ts:40-75`

- [ ] **Step 1: Write a failing page contract test**

Add a Dashboard HTML test which asserts `https://cdn.jsdelivr.net/npm/cytoscape@3.34.0/dist/cytoscape.min.js`, `cytoscape({`, and `'text-wrap': 'wrap'` are present; assert `createElementNS('http://www.w3.org/2000/svg'` is absent.

- [ ] **Step 2: Verify the red test**

Run `npx.cmd vitest run tests/dashboard.test.ts`. Expect the new contract to fail because the page still uses SVG nodes.

- [ ] **Step 3: Load Cytoscape and update graph CSS**

Put `<script src="https://cdn.jsdelivr.net/npm/cytoscape@3.34.0/dist/cytoscape.min.js"></script>` immediately before the inline Dashboard script. Remove SVG-only CSS. Keep `.graph` at minimum height 420px and make the Cytoscape child div `width: 100%; height: 420px`.

- [ ] **Step 4: Implement Cytoscape graph mapping**

Replace the fixed circular positions and all SVG construction in `loadGraph()` with a `graphElements(body)` helper. Map entities to `{ group: 'nodes', data: { id, label: name, entity } }`; map relationships to `{ group: 'edges', data: { id, source, target, label: relationship } }`. Create Cytoscape using a `round-rectangle` node with label-driven width/height, 18px padding, wrapped labels with a 132px max width, and bezier directed edges carrying predicate labels. Run animated `cose` with padding 32, node repulsion 9000, and ideal edge length 130.

Tap a node to call existing `setGraphDetail`; tap graph background to hide `#graph-detail`. If `window.cytoscape` is absent, throw `Graph library failed to load. Please reload the dashboard.`. In the catch path, replace the container with an `.empty` error and set `#graph-status` to `Unable to load graph`. Preserve current agent guidance and dropdown graph refresh.

- [ ] **Step 5: Verify green and commit**

Run `npx.cmd vitest run tests/dashboard.test.ts`, `npx.cmd tsc --noEmit`, `npx.cmd vitest run`, and `git diff --check`. Expect all to pass. Commit `src/dashboard/page.ts` and `tests/dashboard.test.ts` with message `feat: render dashboard graph with Cytoscape`.

### Task 2: Browser verification against remote test data

**Files:**
- Verify only: `src/dashboard/page.ts`
- Verify only: `wrangler.remote-preview.toml`

- [ ] **Step 1: Start local remote-binding preview**

Run `npm.cmd run dev:remote-readonly`. Verify Wrangler reports remote `DB`, `VECTORIZE`, and `ENTITY_VECTORIZE`, local `MEMORY_JOBS`, and `http://127.0.0.1:8787`.

- [ ] **Step 2: Verify rendered graph and interactions**

Sign in, select `User: curl-403-probe-user-5940ad806c8e4792a38908c026b276e3`, and open **Memory graph**. Verify read-only notice, `4 entities | 4 relationships`, a Cytoscape canvas (not SVG), readable Ada/Benoit/Chandra/Orion program labels, pan/zoom/drag, and node-detail interaction.

- [ ] **Step 3: Verify mutation guard**

With an authenticated local Dashboard session, post a valid deduplication request. Expect HTTP 403 and `Dashboard is read-only in this preview`. Stop any foreground server after verification or relaunch it hidden for user testing.
