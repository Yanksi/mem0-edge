# Remote Read-only Dashboard Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run local Dashboard code against remote Cloudflare test data without permitting Dashboard mutations, and make graph entity selection unambiguous and immediately refreshed.

**Architecture:** A local-only `DASHBOARD_READ_ONLY` binding marks remote development sessions. Dashboard mutation routes enforce that flag before service calls, while the rendered page displays the mode and disables mutation controls. The graph view keeps user-scoped data unchanged but redraws whenever the selected entity changes and replaces its canvas with a clear explanation for agent scopes.

**Tech Stack:** Cloudflare Workers, Wrangler remote development, Hono, TypeScript, Vitest, browser-native SVG.

---

### Task 1: Add the read-only binding and local remote-preview command

**Files:**
- Modify: `src/env.ts:31-47`
- Modify: `package.json:6-13`
- Test: `tests/dashboard.test.ts`

- [ ] **Step 1: Write the failing page-mode test**

Add an isolated `readonlyEnv` and an assertion that the authenticated dashboard response exposes a mode marker:

```ts
const readonlyEnv = { DASHBOARD_PASSWORD: 'dashboard-secret', DASHBOARD_READ_ONLY: 'true' } as Env;

it('renders a remote read-only preview marker when enabled', async () => {
  const response = await worker.fetch(request('/dashboard', {
    headers: { 'x-dashboard-password': 'dashboard-secret' },
  }), readonlyEnv);

  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toContain('Remote read-only preview');
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
npx.cmd vitest run tests/dashboard.test.ts
```

Expected: FAIL because the current page does not include `Remote read-only preview`.

- [ ] **Step 3: Add the optional binding and script**

Extend `Env` with an optional value and add a script that never changes `wrangler.toml`:

```ts
DASHBOARD_READ_ONLY?: string;
```

```json
"dev:remote-readonly": "wrangler dev --remote --var DASHBOARD_READ_ONLY:true"
```

- [ ] **Step 4: Run the focused test and typecheck**

Run:

```powershell
npx.cmd vitest run tests/dashboard.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS; TypeScript completes without errors.

- [ ] **Step 5: Commit the command and binding**

```powershell
git add src/env.ts package.json tests/dashboard.test.ts
git commit -m "feat: add remote read-only preview mode"
```

### Task 2: Enforce Dashboard read-only mode at every mutation route

**Files:**
- Modify: `src/routes/dashboard.ts:46-131`
- Test: `tests/dashboard-api.test.ts`

- [ ] **Step 1: Write failing mutation-boundary tests**

Create an authenticated read-only environment and test each mutation endpoint. The test must prove the underlying service is not called:

```ts
const readonlyEnv = {
  DASHBOARD_PASSWORD: 'dashboard-secret',
  DASHBOARD_READ_ONLY: 'true',
  VECTORIZE: {} as VectorizeIndex,
} as Env;

it('rejects dashboard mutations in remote read-only mode before service calls', async () => {
  const cookie = await dashboardCookie(readonlyEnv);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  const responses = await Promise.all([
    worker.fetch(request('/dashboard/api/users/user-123/alias', { method: 'PUT', headers, body: JSON.stringify({ alias: 'User' }) }), readonlyEnv),
    worker.fetch(request('/dashboard/api/deduplication', { method: 'POST', headers, body: JSON.stringify({ entity_type: 'user', entity_id: 'user-123', confirm: true }) }), readonlyEnv),
    worker.fetch(request('/dashboard/api/imports/mem0', { method: 'POST', headers, body: JSON.stringify({ entity_type: 'user', entity_id: 'user-123', export: { memories: [] } }) }), readonlyEnv),
    worker.fetch(request('/dashboard/api/entities/reclassify-agent', { method: 'POST', headers, body: JSON.stringify({ source_user_id: 'user-123', agent_id: 'agent-123' }) }), readonlyEnv),
  ]);

  expect(responses.map(({ status }) => status)).toEqual([403, 403, 403, 403]);
  expect(dashboardService.setDashboardUserAlias).not.toHaveBeenCalled();
  expect(dashboardService.softDeleteDashboardMemories).not.toHaveBeenCalled();
  expect(importService.enqueueMem0Import).not.toHaveBeenCalled();
  expect(importService.enqueueMem0AgentReclassification).not.toHaveBeenCalled();
});
```

Change `dashboardCookie` to accept an optional `Env` argument so it signs a valid session for `readonlyEnv`:

```ts
async function dashboardCookie(currentEnv: Env = env): Promise<string> {
  const response = await worker.fetch(request('/dashboard/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=dashboard-secret',
  }), currentEnv);
  return response.headers.get('Set-Cookie')!.split(';', 1)[0];
}
```

- [ ] **Step 2: Run the focused mutation test and verify it fails**

Run:

```powershell
npx.cmd vitest run tests/dashboard-api.test.ts
```

Expected: FAIL because the mutation routes currently call their services and return `200` or `202`.

- [ ] **Step 3: Implement a single route guard**

Add a helper near `dashboardScope`:

```ts
function dashboardReadOnly(context: { env: Env }): Response | undefined {
  return context.env.DASHBOARD_READ_ONLY === 'true'
    ? context.json({ error: 'Dashboard is read-only in this preview' }, 403)
    : undefined;
}
```

Use the guard at the first line of the alias, deduplication POST, import, and agent-reclassification handlers:

```ts
const readOnly = dashboardReadOnly(context);
if (readOnly !== undefined) return readOnly;
```

Use a `Context<{ Bindings: Env }>` parameter for the helper if required by Hono's `json` type.

- [ ] **Step 4: Run focused tests and the full suite**

Run:

```powershell
npx.cmd vitest run tests/dashboard-api.test.ts
npx.cmd vitest run
```

Expected: all tests pass, and ordinary authenticated mutation tests still retain their existing success responses when the flag is absent.

- [ ] **Step 5: Commit server-side enforcement**

```powershell
git add src/routes/dashboard.ts tests/dashboard-api.test.ts
git commit -m "feat: block dashboard mutations in preview mode"
```

### Task 3: Make the Dashboard graph state explicit and keep it synchronized

**Files:**
- Modify: `src/dashboard/page.ts:19-110`
- Modify: `tests/dashboard.test.ts`

- [ ] **Step 1: Write failing rendered-page contract tests**

Add assertions for the client-side contracts rather than executing browser scripts in Vitest:

```ts
it('renders graph selection refresh and read-only dashboard controls', async () => {
  const response = await worker.fetch(request('/dashboard', {
    headers: { 'x-dashboard-password': 'dashboard-secret' },
  }), readonlyEnv);
  const html = await response.text();

  expect(html).toContain('Remote read-only preview');
  expect(html).toContain("if (state.currentView === 'graph') await loadGraph();");
  expect(html).toContain('Select the corresponding user entity to view its graph.');
  expect(html).toContain('readonly');
});
```

- [ ] **Step 2: Run the focused page test and verify it fails**

Run:

```powershell
npx.cmd vitest run tests/dashboard.test.ts
```

Expected: FAIL because the current page has no preview marker, no graph-refresh branch in the select handler, and no explicit graph canvas message.

- [ ] **Step 3: Implement the minimal page changes**

Pass a boolean from `renderDashboard` based on `DASHBOARD_READ_ONLY` and render:

```html
<p class="preview-notice" id="preview-notice">Remote read-only preview</p>
```

Expose it to the script:

```js
const readonly = true;
```

When `readonly` is true, disable the alias and deduplicate buttons and every control inside `#import-form`. In `loadGraph`, replace the agent canvas with:

```js
graph.replaceChildren(Object.assign(document.createElement('p'), {
  className: 'empty',
  textContent: 'Select the corresponding user entity to view its graph.',
}));
status.textContent = 'Memory graphs are available for user entities only.';
```

Finally, append the graph branch to the entity select listener:

```js
if (state.currentView === 'graph') await loadGraph();
```

Ensure the existing production page receives `readonly = false`, contains no active preview notice, and keeps its mutation controls enabled.

- [ ] **Step 4: Run focused tests, typecheck, and full suite**

Run:

```powershell
npx.cmd vitest run tests/dashboard.test.ts
npx.cmd tsc --noEmit
npx.cmd vitest run
```

Expected: all commands pass.

- [ ] **Step 5: Commit Dashboard behavior**

```powershell
git add src/dashboard/page.ts tests/dashboard.test.ts
git commit -m "fix: clarify dashboard graph preview state"
```

### Task 4: Verify the local remote read-only preview without deployment

**Files:**
- Modify: `README.md:100-110`

- [ ] **Step 1: Write the failing documentation assertion**

Add a README test-free documentation checklist in the planned text and verify manually that it is absent before editing:

```powershell
rg -n "dev:remote-readonly|Remote read-only preview" README.md
```

Expected: no matches.

- [ ] **Step 2: Document the preview workflow**

Add this focused section under Dashboard usage:

```markdown
### Remote read-only preview

Run `npm run dev:remote-readonly` to preview local Dashboard code against the configured remote Worker resources. The preview reads remote data but rejects Dashboard alias, deduplication, import, and reclassification mutations with `403`; it does not change the deployed Worker configuration. Open the local URL Wrangler prints, sign in with `DASHBOARD_PASSWORD`, select `User: curl-403-probe-user-...`, and open **Memory graph** to inspect the retained graph test data.
```

- [ ] **Step 3: Validate the local runtime**

Run:

```powershell
npm run dev:remote-readonly
```

Expected: Wrangler prints a local URL and reports remote bindings. In the browser, verify the preview notice, the four-node/four-edge test graph, and a `403` response for any direct protected Dashboard mutation request. Stop the local server after verification.

- [ ] **Step 4: Run final non-deployment verification**

Run:

```powershell
npx.cmd tsc --noEmit
npx.cmd vitest run
git diff --check
```

Expected: all commands pass with no whitespace errors. Do not run `wrangler deploy` in this task.

- [ ] **Step 5: Commit documentation**

```powershell
git add README.md
git commit -m "docs: explain remote dashboard preview"
```
