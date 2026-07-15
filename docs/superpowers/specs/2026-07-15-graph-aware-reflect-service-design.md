# Graph-aware Reflect Service Design

## Goal

Add an explicit, read-only `POST /v1/reflect` endpoint that answers a
cross-memory question from bounded user-scoped semantic and graph evidence.

## API

The endpoint accepts a non-empty `query`, `user_id`, and `agent_id`. It uses
the existing API-key middleware. `user_id` is the non-negotiable retrieval and
storage boundary; `agent_id` is returned only as request provenance in worker
logs and does not narrow the memory scope.

Successful responses always contain `answer`, `evidence`, and `uncertainty`.
They may include deterministically computed `relation_paths`, `limitations`,
and a generated request ID. Insufficient evidence is a successful response
with an empty evidence array and `uncertainty: "high"`.

## Retrieval And Graph Expansion

1. Use the current `searchMemories()` user-scoped path with a maximum of 12
   semantic seeds. This retains the existing Vectorize and entity-vector boost.
2. Resolve seed memory IDs to linked entities through `memory_entity_links`.
3. Run a Worker-side breadth-first traversal over D1 relationships, at most two
   hops, with fixed caps of 24 entities and 32 edges. Every relationship query
   includes the same `user_id` predicate.
4. Add only evidence memories from traversed relationships and active memories
   linked to discovered entities. Re-check every candidate memory's `user_id`
   and soft-delete state; deduplicate against seed IDs.
5. Rank seeds ahead of graph expansion, then cap the evidence set at 20
   memories and a fixed character budget before synthesis.

The Worker computes relation paths from the traversed edges. The model neither
chooses tenant scope nor issues graph queries.

## Synthesis And Safety

One LLM request is allowed, with a 20-second timeout. Reflection uses a
dedicated, explicitly configured OpenAI-compatible model: `GRAPH_LLM_API_BASE_URL`,
`GRAPH_LLM_MODEL`, and `GRAPH_LLM_API_KEY`. These three bindings are a group;
the endpoint returns a clear configuration error when any member is missing.
`GRAPH_LLM_THINKING_LEVEL` is an optional `low`, `medium`, or `high` variable;
it defaults to `low` and is sent to the provider as `reasoning_effort` for this
reflection request only. It does not silently fall back to the extraction
model, because reflection is a distinct workload with its own cost and quality
requirements. Providers and models must support `reasoning_effort`; an
unsupported parameter or value is surfaced as a clear upstream configuration
failure rather than silently being ignored. Evidence text is passed as
untrusted data inside explicit memory delimiters. The model must return JSON
with an answer, an uncertainty enum, optional limitations, and selected
evidence IDs.

The Worker validates that every selected evidence ID came from the bounded
candidate set and maps IDs back to the stored text and deterministic role
(`semantic_seed` or `graph_expansion`). Unknown IDs, malformed JSON, provider
failure, or deadline exhaustion produce a conservative high-uncertainty
response without invented evidence. The endpoint never writes D1, Vectorize,
or graph records.

## Operational Behavior

The route logs a generated request ID, user ID, agent ID, candidate counts,
and latency, but never logs memory text, prompts, or keys. It uses the existing
error shape and API authentication; the repository does not currently have a
shared request-ID or rate-limit middleware, so this endpoint creates its own
opaque request ID rather than pretending to reuse one.

The endpoint, model slug, and thinking level are ordinary Worker variables.
`GRAPH_LLM_API_KEY` is a Worker secret, alongside the existing provider
credentials. `.dev.vars` contains local development values only; deployed
values are configured in the Cloudflare dashboard or through Wrangler secrets
and variables.

## Tests

- Request validation and API-key authentication.
- Semantic seed plus two-hop graph evidence produces a supported answer and
  deterministic path.
- User A data never appears in User B results.
- Empty or unsupported evidence returns `200`, empty evidence, and high
  uncertainty.
- Traversal caps, soft-deleted records, malformed model JSON, unknown evidence
  IDs, prompt-injection-like memory text, invalid thinking levels, unsupported
  provider thinking parameters, and upstream timeout all fail closed.
- A read-only invariant verifies no memory, entity, relationship, or vector
  write service is called.

## Out Of Scope

- Hermes changes, tools, prompts, or configuration.
- Dashboard reflect UI, graph editing, arbitrary graph query languages, or
  unbounded traversal.
- Changes to existing memory add, search, CRUD, or graph endpoint semantics.
