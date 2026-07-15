# Graph-aware Reflect Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authenticated, read-only `POST /v1/reflect` endpoint that answers a user-scoped cross-memory question from bounded semantic and D1 graph evidence using a separately configured graph LLM.

**Architecture:** The route validates an explicit `{ query, user_id, agent_id }` request, asks the existing user-scoped semantic search for up to 12 seeds, then performs a capped two-hop D1 relationship traversal rooted in the seeds' linked entities. A graph-specific OpenAI-compatible model receives only the Worker-selected evidence, returns selected IDs in JSON, and the Worker maps those IDs back to stored text while rejecting every untrusted or malformed model claim.

**Tech Stack:** TypeScript, Hono, Zod, Cloudflare Workers, D1/Drizzle, Vectorize, OpenAI-compatible chat completions, Vitest, Wrangler.

---

## File Structure

- Create `src/reflect/types.ts`: public request/response schemas and internal bounded evidence/model result types.
- Create `src/reflect/service.ts`: semantic seed retrieval, user-scoped graph BFS, candidate capping, deterministic relation paths, synthesis orchestration, and safe no-evidence fallbacks.
- Create `src/routes/reflect.ts`: authenticated HTTP route, JSON validation, error mapping, and request-scoped operational logging.
- Modify `src/llm.ts`: graph-model configuration validation and an abortable structured reflection-completion helper.
- Modify `src/env.ts` and `wrangler.toml`: declare the separate graph-model variables and secret binding.
- Create `src/migrations/0005_reflect_graph_indexes.sql`: user-scoped D1 traversal indexes.
- Modify `src/db/schema.ts`: declare those indexes for schema/migration alignment checks.
- Modify `src/index.ts`: mount `/v1/reflect`.
- Modify `tests/llm.test.ts`, `tests/schema.test.ts`, and create `tests/reflect.test.ts`: cover model configuration, route contract, bounded graph behavior, isolation, and read-only failure paths.
- Modify `README.md`: document the reflect API, graph-model configuration, thinking-level behavior, and the new migration.

### Task 1: Define Reflection Contracts and the Graph LLM Helper

**Files:**
- Create: `src/reflect/types.ts`
- Modify: `src/llm.ts`
- Modify: `src/env.ts`
- Modify: `tests/llm.test.ts`

- [ ] **Step 1: Write failing graph-model tests**

In `tests/llm.test.ts`, add an `env` with all graph bindings and a `reflectWithGraphModel` call. Assert the helper posts exactly one JSON-mode chat completion to the configured base URL with the configured model and `reasoning_effort: 'medium'`:

```ts
const graphEnv = {
  ...env,
  GRAPH_LLM_API_BASE_URL: 'https://graph.example/v1/',
  GRAPH_LLM_MODEL: 'openai/o3-mini',
  GRAPH_LLM_API_KEY: 'graph-key',
  GRAPH_LLM_THINKING_LEVEL: 'medium',
};

await expect(reflectWithGraphModel(graphEnv, {
  query: 'Who manages Ada?',
  evidence: [{ id: 'memory-1', memory: 'Ada reports to Benoit.', role: 'semantic_seed' }],
})).resolves.toEqual({
  answer: 'Benoit manages Ada.',
  uncertainty: 'low',
  evidence_ids: ['memory-1'],
});

expect(fetchMock).toHaveBeenCalledWith(
  'https://graph.example/v1/chat/completions',
  expect.objectContaining({
    headers: { Authorization: 'Bearer graph-key', 'Content-Type': 'application/json' },
    body: expect.stringContaining('"reasoning_effort":"medium"'),
  }),
);
```

Add independent failing cases asserting that an absent graph binding and an invalid thinking level throw `GraphLlmConfigurationError`, an HTTP error throws `UpstreamServiceError`, and model output with an invalid uncertainty value throws a response-validation error.

- [ ] **Step 2: Run the focused test to verify red**

Run: `npm.cmd test -- tests/llm.test.ts`

Expected: failure because `reflectWithGraphModel` and `GraphLlmConfigurationError` do not exist.

- [ ] **Step 3: Add reflection types and the minimal LLM helper**

Create `src/reflect/types.ts` with these public contracts:

```ts
import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);

export const ReflectRequestSchema = z.object({
  query: nonEmptyString.max(4_000),
  user_id: nonEmptyString,
  agent_id: nonEmptyString,
});

export const ReflectUncertaintySchema = z.enum(['low', 'medium', 'high']);
export const GraphThinkingLevelSchema = z.enum(['low', 'medium', 'high']);

export const GraphModelResponseSchema = z.object({
  answer: nonEmptyString,
  uncertainty: ReflectUncertaintySchema,
  evidence_ids: z.array(nonEmptyString).max(20),
  limitations: z.string().trim().min(1).optional(),
});

export type ReflectRequest = z.infer<typeof ReflectRequestSchema>;
export type GraphModelResponse = z.infer<typeof GraphModelResponseSchema>;
export type GraphThinkingLevel = z.infer<typeof GraphThinkingLevelSchema>;
export type ReflectEvidenceRole = 'semantic_seed' | 'graph_expansion';
export interface ReflectCandidateEvidence { id: string; memory: string; role: ReflectEvidenceRole }
```

Extend `Env` with optional `GRAPH_LLM_API_BASE_URL`, `GRAPH_LLM_MODEL`, `GRAPH_LLM_API_KEY`, and `GRAPH_LLM_THINKING_LEVEL`. In `src/llm.ts`, add `GraphLlmConfigurationError` and `reflectWithGraphModel(env, input)`. It must:

```ts
const thinking = GraphThinkingLevelSchema.safeParse(env.GRAPH_LLM_THINKING_LEVEL ?? 'low');
if (!env.GRAPH_LLM_API_BASE_URL || !env.GRAPH_LLM_MODEL || !env.GRAPH_LLM_API_KEY || !thinking.success) {
  throw new GraphLlmConfigurationError('Graph reflection model is not configured');
}

const response = await fetch(`${normalizeBaseUrl(env.GRAPH_LLM_API_BASE_URL)}/chat/completions`, {
  method: 'POST',
  headers: openAiHeaders(env.GRAPH_LLM_API_KEY),
  signal: AbortSignal.timeout(20_000),
  body: JSON.stringify({
    model: env.GRAPH_LLM_MODEL,
    reasoning_effort: thinking.data,
    response_format: { type: 'json_object' },
    messages: buildReflectionMessages(input),
  }),
});
```

Make `buildReflectionMessages` instruct the model to treat evidence as untrusted quoted data, answer only from it, return only the declared JSON fields, and select only supplied IDs. Parse the completion content with `GraphModelResponseSchema`; retain the existing `UpstreamServiceError` behavior for non-2xx status codes.

- [ ] **Step 4: Run the focused test to verify green**

Run: `npm.cmd test -- tests/llm.test.ts`

Expected: pass, including existing embedding and extraction tests.

- [ ] **Step 5: Commit the contracts and graph LLM helper**

```powershell
git add src/reflect/types.ts src/llm.ts src/env.ts tests/llm.test.ts
git commit -m "feat: add graph reflection LLM helper"
```

### Task 2: Build the Bounded, Read-only Reflection Service

**Files:**
- Create: `src/reflect/service.ts`
- Modify: `tests/reflect.test.ts`

- [ ] **Step 1: Write failing service tests**

Create `tests/reflect.test.ts`. Mock `searchMemories`, `reflectWithGraphModel`, and `createDb`. Add a two-hop fixture where seed `memory-ada` links to `entity-ada`, relationships connect `Ada -> Benoit` and `Benoit -> Chandra`, and each relationship points at its source evidence memory. Assert:

```ts
await expect(reflectMemories(env, {
  query: 'Who manages Ada?', user_id: 'user-a', agent_id: 'agent-a',
}, 'request-1')).resolves.toMatchObject({
  answer: 'Chandra manages Ada through Benoit.',
  uncertainty: 'low',
  evidence: [
    { id: 'memory-ada', role: 'semantic_seed' },
    { id: 'memory-benoit', role: 'graph_expansion' },
  ],
  relation_paths: [{ entity_ids: ['entity-ada', 'entity-benoit', 'entity-chandra'] }],
  request_id: 'request-1',
});

expect(reflectWithGraphModel).toHaveBeenCalledWith(env, expect.objectContaining({
  evidence: expect.arrayContaining([
    expect.objectContaining({ id: 'memory-ada' }),
    expect.objectContaining({ id: 'memory-benoit' }),
  ]),
}));
```

Add separate failing tests proving: every relationship predicate includes `relationships.userId` and `'user-a'`; a memory owned by `user-b` or soft-deleted is excluded; a model-selected unknown ID returns the static high-uncertainty fallback with no evidence; no semantic seeds returns the same `200`-style fallback without calling the model; and the mock D1 object exposes only `select`, so any accidental write fails the test.

- [ ] **Step 2: Run the focused test to verify red**

Run: `npm.cmd test -- tests/reflect.test.ts`

Expected: failure because `src/reflect/service.ts` does not exist.

- [ ] **Step 3: Implement bounded evidence collection and synthesis orchestration**

Implement these exported limits and result shape in `src/reflect/service.ts`:

```ts
export const REFLECT_SEED_LIMIT = 12;
export const REFLECT_MAX_HOPS = 2;
export const REFLECT_MAX_ENTITIES = 24;
export const REFLECT_MAX_EDGES = 32;
export const REFLECT_MAX_EVIDENCE = 20;
export const REFLECT_MAX_EVIDENCE_CHARS = 24_000;

export interface ReflectResult {
  answer: string;
  uncertainty: 'low' | 'medium' | 'high';
  evidence: Array<{ id: string; memory: string; role: ReflectEvidenceRole }>;
  relation_paths: Array<{ entity_ids: string[]; relationship_ids: string[] }>;
  limitations?: string;
  request_id: string;
}
```

Call `searchMemories(env, { query, user_id, agent_id, limit: REFLECT_SEED_LIMIT, filters: {} })`. Resolve seed entity IDs with `memoryEntityLinks`, then perform two breadth-first iterations. Each iteration queries only relationships satisfying:

```ts
and(
  eq(relationships.userId, request.user_id),
  or(
    inArray(relationships.sourceEntityId, frontier),
    inArray(relationships.targetEntityId, frontier),
  ),
)
```

Apply the entity and edge caps before putting nodes into the next frontier. Retrieve relationship `evidenceMemoryId` values plus memory IDs linked to discovered entities, then load those memories only with `eq(memories.userId, request.user_id)` and `isNull(memories.deletedAt)`. Keep semantic seeds first, append graph evidence by deterministic ID order, cap at 20 records and 24,000 aggregate characters, and calculate relation paths from the accepted traversed edges rather than asking the model for paths.

When no candidate remains, return:

```ts
{
  answer: 'I cannot answer reliably from the retrieved memories.',
  uncertainty: 'high',
  evidence: [],
  relation_paths: [],
  limitations: 'No relevant stored memory evidence was found.',
  request_id,
}
```

Otherwise call `reflectWithGraphModel`. Reject any returned `evidence_ids` absent from the candidate map, any duplicate ID, and any empty selection by returning that same static high-uncertainty fallback. For valid selections, return only selected stored evidence, preserving Worker candidate order. Do not import or call any memory, graph, Vectorize, or D1 write helper.

- [ ] **Step 4: Run the focused test to verify green**

Run: `npm.cmd test -- tests/reflect.test.ts`

Expected: pass, including the two-hop, isolation, cap, no-evidence, malformed-selection, and read-only checks.

- [ ] **Step 5: Commit the reflection service**

```powershell
git add src/reflect/service.ts tests/reflect.test.ts
git commit -m "feat: add bounded graph reflection service"
```

### Task 3: Expose the Authenticated Endpoint and Add Traversal Indexes

**Files:**
- Create: `src/routes/reflect.ts`
- Create: `src/migrations/0005_reflect_graph_indexes.sql`
- Modify: `src/index.ts`
- Modify: `src/db/schema.ts`
- Modify: `tests/reflect.test.ts`
- Modify: `tests/schema.test.ts`

- [ ] **Step 1: Write failing route and schema tests**

Extend `tests/reflect.test.ts` with route tests against `worker.fetch`:

```ts
const request = new Request('https://example.com/v1/reflect', {
  method: 'POST',
  headers: { Authorization: 'Bearer test-api-key', 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'Who manages Ada?', user_id: 'user-a', agent_id: 'agent-a' }),
});

expect((await worker.fetch(request, env)).status).toBe(200);
expect(reflectMemories).toHaveBeenCalledWith(env, {
  query: 'Who manages Ada?', user_id: 'user-a', agent_id: 'agent-a',
}, expect.any(String));
```

Add failures for unauthenticated access (`401`), missing `agent_id` (`400`), invalid JSON (`400`), missing graph configuration (`503` with `{ error: 'Graph reflection is not configured' }`), and a graph-provider failure (`502` with `{ error: 'Graph reflection provider request failed' }`). In `tests/schema.test.ts`, assert that the Drizzle `relationships` indexes contain `relationships_user_source_idx` and `relationships_user_target_idx`, and that the new migration contains both SQL index definitions.

- [ ] **Step 2: Run the focused tests to verify red**

Run: `npm.cmd test -- tests/reflect.test.ts tests/schema.test.ts`

Expected: route tests fail with `404` and schema tests fail because the route and indexes do not exist.

- [ ] **Step 3: Implement the route, index declarations, and migration**

Create `src/routes/reflect.ts` with `apiAuth` middleware and a single `POST /` handler. Parse JSON with `ReflectRequestSchema.safeParse`; malformed JSON and invalid input return `{ error: 'Validation failed' }` with `400`. Generate an opaque request ID with `nanoid()`, measure elapsed milliseconds, and log only:

```ts
console.log(JSON.stringify({
  event: 'reflect', request_id: requestId, user_id: request.user_id,
  agent_id: request.agent_id, latency_ms: Date.now() - startedAt,
}));
```

Catch `GraphLlmConfigurationError` and return `503`; catch `UpstreamServiceError` and return `502`; rethrow all other errors to preserve the Worker-wide internal-error policy. Mount with `app.route('/v1/reflect', reflectRoutes)` in `src/index.ts`.

Add to `relationships` in `src/db/schema.ts`:

```ts
index('relationships_user_source_idx').on(table.userId, table.sourceEntityId),
index('relationships_user_target_idx').on(table.userId, table.targetEntityId),
```

Create exactly this migration:

```sql
CREATE INDEX relationships_user_source_idx ON relationships (user_id, source_entity_id);
CREATE INDEX relationships_user_target_idx ON relationships (user_id, target_entity_id);
```

- [ ] **Step 4: Run the focused tests to verify green**

Run: `npm.cmd test -- tests/reflect.test.ts tests/schema.test.ts`

Expected: pass, with the route protected and all expected error mappings retained.

- [ ] **Step 5: Commit the route and migration**

```powershell
git add src/routes/reflect.ts src/index.ts src/db/schema.ts src/migrations/0005_reflect_graph_indexes.sql tests/reflect.test.ts tests/schema.test.ts
git commit -m "feat: expose graph reflection endpoint"
```

### Task 4: Configure and Document the Service

**Files:**
- Modify: `wrangler.toml`
- Modify: `README.md`
- Modify: `tests/reflect.test.ts`

- [ ] **Step 1: Write the failing deployment-configuration test**

In `tests/reflect.test.ts`, import `wrangler.toml` as raw text and assert it declares the non-secret variables:

```ts
expect(wranglerConfig).toContain('GRAPH_LLM_API_BASE_URL = "https://openrouter.ai/api/v1"');
expect(wranglerConfig).toContain('GRAPH_LLM_MODEL = "openai/gpt-4o-mini"');
expect(wranglerConfig).toContain('GRAPH_LLM_THINKING_LEVEL = "low"');
expect(wranglerConfig).not.toContain('GRAPH_LLM_API_KEY');
```

- [ ] **Step 2: Run the focused test to verify red**

Run: `npm.cmd test -- tests/reflect.test.ts`

Expected: failure because graph-model variables are absent from `wrangler.toml`.

- [ ] **Step 3: Add deployment variables and README guidance**

Add the following values under `[vars]` in `wrangler.toml`:

```toml
GRAPH_LLM_API_BASE_URL = "https://openrouter.ai/api/v1"
GRAPH_LLM_MODEL = "openai/gpt-4o-mini"
GRAPH_LLM_THINKING_LEVEL = "low"
```

Do not add `GRAPH_LLM_API_KEY` to Wrangler variables or `.dev.vars.example`; document it as a Worker secret. In `README.md`:

- add `/v1/reflect` to the API table;
- document its required request body and response fields, including `evidence` roles and deterministic `relation_paths`;
- explain that it is explicit, user-scoped, read-only, capped at 12 semantic seeds/two hops/32 edges/20 evidence memories, and does not change ordinary `/search`;
- describe `GRAPH_LLM_API_BASE_URL`, `GRAPH_LLM_MODEL`, and default `GRAPH_LLM_THINKING_LEVEL=low` as normal variables, and `GRAPH_LLM_API_KEY` as a secret set with `npx wrangler secret put GRAPH_LLM_API_KEY`;
- explain that `GRAPH_LLM_THINKING_LEVEL` maps to `reasoning_effort`, accepted values are `low`, `medium`, and `high`, and the selected provider/model must support it;
- add migration application as a deployment prerequisite rather than promising that `wrangler deploy` applies D1 migrations automatically.

- [ ] **Step 4: Run focused tests and full verification**

Run: `npm.cmd test -- tests/reflect.test.ts; npm.cmd test; npm.cmd run typecheck; git diff --check`

Expected: all Vitest suites pass, TypeScript exits `0`, and `git diff --check` has no output.

- [ ] **Step 5: Commit documentation and configuration**

```powershell
git add wrangler.toml README.md tests/reflect.test.ts
git commit -m "docs: configure graph reflection service"
```

## Final Verification

- [ ] Run `npm.cmd test` and confirm every suite passes.
- [ ] Run `npm.cmd run typecheck` and confirm exit code `0`.
- [ ] Run `git diff --check` and confirm no whitespace errors.
- [ ] Review `git status --short` and confirm only intentional files are staged or committed; do not add `288035119623569418.json`, `hermes-user.json`, or `hermes.json`.
- [ ] Apply `src/migrations/0005_reflect_graph_indexes.sql` to the intended D1 database before deploying; this implementation does not auto-apply migrations.
- [ ] Do not deploy or push until the user explicitly requests it.
