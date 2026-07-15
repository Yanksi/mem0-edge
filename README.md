# @mem0/cloudflare-workers

Deployable edge memory service for Cloudflare Workers. It provides a compact, OpenAI-compatible-provider-backed subset of Mem0: extract and store memories, semantic search, memory CRUD, a graph-lite read API, and a password-protected dashboard.

This is **not** the full Python Mem0 implementation. It deliberately uses D1 for graph-lite entities and relationships, Cloudflare Vectorize for retrieval, and the OpenAI-compatible API surface implemented in this Worker. Full Python Mem0 feature parity, provider breadth, and a graph database are out of scope by default.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Yanksi/mem-worker)

Repository: [Yanksi/mem-worker](https://github.com/Yanksi/mem-worker). Cloudflare's deploy button provisions the declared D1, Vectorize, and Queue bindings, and prompts for secrets from `.dev.vars.example`. Create the Vectorize metadata indexes listed below after deployment.

## Included

- A Cloudflare Worker HTTP API for adding, searching, listing, reading, updating, and soft-deleting memories.
- OpenAI-compatible chat-completion fact extraction and embedding requests, using the configured OpenAI API endpoint and models.
- Cloudflare Vectorize upserts, deletes, scoped semantic search, and validated metadata filters.
- Mem0-compatible entity linking that boosts inferred user-memory search results without changing Hermes requests.
- D1-backed memory metadata, audit history, graph-lite entities, relationships, and memory/entity links.
- Durable tenant-scoped idempotency records, retry-safe deterministic writes, and bounded Queue consumers for asynchronous ingestion and Mem0 imports.
- Extracted entity and relationship persistence, plus read-only graph endpoints.
- API-key authentication, per-user memory and graph isolation, and a signed-session operator dashboard with automatic user discovery.
- Dashboard views for semantic search, paginated active-memory browsing, exact-text deduplication across discovered user and agent entities, a bounded user entity/relationship graph, and dashboard-managed user-ID aliases.
- D1 migrations, local test coverage, Wrangler configuration, and a deployment guide.

## Not Included

- The Python Mem0 runtime, SDKs, or full API and behavioral compatibility.
- Hosted Mem0 Platform features such as organizations, billing, advanced user management, and hosted-dashboard parity.
- Alternative vector stores, graph databases, or the broad LLM/embedder provider matrix from Mem0 OSS.
- A Neo4j-style graph engine, unbounded graph traversal, advanced graph analytics, or agent-scoped graphs; graph support is bounded D1-backed storage and reads for user-scoped memories.
- Automatic Cloudflare resource provisioning or secret creation. Deployment requires creating the D1 database, Vectorize indexes, Queue and DLQ, metadata indexes, and secrets described below.
- A general-purpose job-status API or dashboard job monitor beyond the durable ingestion behavior used internally by async memory requests.
- Dashboard memory editing, general deletion, bulk exports, graph editing, or graph traversal beyond the bounded read-only graph view. Exact-text deduplication is the limited deletion exception; the dashboard can otherwise only create, change, or remove display aliases for stored user IDs.

## Architecture

- **Worker / Hono** exposes the API, health check, and dashboard.
- **D1** stores memories, idempotency/request state, history, and graph-lite entities/relationships.
- **Vectorize** stores memory embeddings plus a parallel entity index used for Mem0-style entity-link score fusion.
- **Queues** receives asynchronous extraction-and-store jobs. Import work is backed by a canonical D1 ledger, bounded to one message per batch and two concurrent consumers, retried with delay on transient Vectorize failures, and exhausted deliveries are retained in a DLQ.
- **OpenAI-compatible endpoints** are used for embeddings and chat-completion memory extraction. They default to the OpenAI API, but extraction and embedding base URLs can be configured independently.

All `/v1/*` routes require `Authorization: Bearer $MEM0_API_KEY`. The dashboard has its own password login.

### Model and endpoint defaults

- **Extraction model:** `gpt-4o-mini` (`LLM_MODEL`)
- **Embedding model:** `text-embedding-3-small` (`EMBEDDING_MODEL`)
- **Extraction endpoint:** `https://openrouter.ai/api/v1` by default (`LLM_API_BASE_URL`), authenticated with `LLM_API_KEY`
- **Embedding endpoint:** `https://openrouter.ai/api/v1` by default (`EMBEDDING_API_BASE_URL`), authenticated with `EMBEDDING_API_KEY`

Graph reflection uses separate Worker variables: `GRAPH_LLM_API_BASE_URL` (default `https://openrouter.ai/api/v1`), `GRAPH_LLM_MODEL` (default `deepseek/deepseek-v4-flash`), and `GRAPH_LLM_THINKING_LEVEL` (default `low`). Set `GRAPH_LLM_API_KEY` as a Cloudflare secret; it is intentionally not a `wrangler.toml` variable. Thinking levels `disabled`, `low`, `medium`, and `high` map to OpenRouter's `reasoning` object: `disabled` sends `{ "enabled": false }`, while the other values send `{ "effort": "low" | "medium" | "high" }`. Graph reflection currently only adapts the OpenRouter endpoint.

Both endpoints and their credentials are configured independently and must implement the OpenAI-compatible `/chat/completions` or `/embeddings` path respectively. Base URLs may include `/v1`; trailing slashes are ignored. `LLM_API_KEY`, `EMBEDDING_API_KEY`, and `GRAPH_LLM_API_KEY` are three separate required secrets for their respective model paths; no model path reads another path's key.

### Hermes compatibility

The Worker supports the request contract used by Hermes's self-hosted Mem0 adapter when Hermes is configured with a `/v1` base URL. User-scoped `infer: true` writes and normal search use entity linking transparently; Hermes needs no graph-specific setting:

- `POST /v1/memories` accepts `X-API-Key: $MEM0_API_KEY` and the standard Mem0 add payload.
- `POST /v1/search` and `POST /v1/memories/search` accept `top_k` plus `filters.user_id`; optional `agent_id`, `run_id`, and `actor_id` are scoped fields, while other filters are preserved as Vectorize metadata filters.
- `PUT /v1/memories/:id` accepts `{ "text": "..." }`, while native `PATCH` continues to accept `{ "memory": "..." }`.
- `DELETE /v1/memories/:id` resolves the stored user owner when Hermes omits a `user_id` query parameter. Memory IDs are opaque strings, including the Worker-generated SHA-256 IDs.

Example Hermes configuration:

```json
{
  "mode": "platform",
  "host": "https://your-worker.example/v1",
  "user_id": "stable-user-id",
  "agent_id": "stable-agent-id",
  "rerank": false
}
```

`user_id` remains the profile boundary. Configure Hermes with a stable `MEM0_USER_ID` to merge one person's memories across gateways, or leave it unset to let Hermes use its gateway-native identity (for example, a Discord user ID). The API key only authenticates the trusted Hermes gateway; it does not bind a request to a user ID.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Service health response. |
| `POST` | `/v1/memories` | Add/extract memories; supports synchronous and queued work. |
| `POST` | `/v1/memories/search` | Semantic search, scoped by `user_id` and optional identity fields. |
| `POST` | `/v1/search` | Hermes-compatible semantic search using `top_k` and identity values inside `filters`. |
| `POST` | `/v1/reflect` | Reflect on a bounded, read-only graph retrieved from semantic memory seeds. |
| `GET` | `/v1/memories?user_id=...&limit=...` | List a user's active memories. |
| `GET`, `PATCH`, `DELETE` | `/v1/memories/:id?user_id=...` | Native read, update, or delete a memory. |
| `PUT`, `DELETE` | `/v1/memories/:id` | Hermes-compatible update or delete using the stored user owner. |
| `GET` | `/v1/entities?user_id=...` | List graph-lite entities. |
| `GET` | `/v1/entities/:id?user_id=...` | Get a graph-lite entity. |
| `GET` | `/v1/relationships?user_id=...&entity_id=...` | List graph-lite relationships. |
| `GET` | `/dashboard` | Dashboard login and authenticated dashboard. |

`POST /v1/memories` accepts `messages`, `user_id`, optional `agent_id`, `run_id`, `actor_id`, `metadata`, `request_id`, `infer`, and `async`. With `async: true`, it returns `202 Accepted` with a queued job payload:

```json
{ "request_id": "<idempotency-hash>", "status": "queued" }
```

The request is idempotent; use `request_id` when the caller needs a stable caller-supplied key.

### Reflect on a bounded graph

`POST /v1/reflect` accepts `query`, `user_id`, and `agent_id`. It performs explicit read-only bounded graph retrieval: up to 12 semantic-memory seeds, two graph hops, 24 entities, 32 edges, and 20 candidate memories capped at 24,000 characters. It does not write memories or graph records, and does not change `/v1/search` behavior.

```sh
curl -X POST "$MEM0_URL/v1/reflect" \
  -H "Authorization: Bearer $MEM0_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Who manages Ada?",
    "user_id": "user-123",
    "agent_id": "agent-456"
  }'
```

```json
{
  "result": "Chandra manages Ada through Benoit.",
  "uncertainty": "medium",
  "evidences": [
    {
      "relationship": {
        "id": "relationship-ada", "user_id": "user-123", "source_entity_id": "entity-ada", "target_entity_id": "entity-benoit", "relation_type": "reports_to", "confidence": 0.9, "evidence_memory_id": "memory-ada", "metadata": {}, "created_at": "2026-07-15T00:00:00.000Z", "updated_at": "2026-07-15T00:00:00.000Z"
      },
      "source_entity": {
        "id": "entity-ada", "user_id": "user-123", "name": "Ada", "type": "person", "metadata": {}, "created_at": "2026-07-15T00:00:00.000Z", "updated_at": "2026-07-15T00:00:00.000Z"
      },
      "target_entity": {
        "id": "entity-benoit", "user_id": "user-123", "name": "Benoit", "type": "person", "metadata": {}, "created_at": "2026-07-15T00:00:01.000Z", "updated_at": "2026-07-15T00:00:01.000Z"
      },
      "evidence_memory": {
        "id": "memory-ada", "memory": "Ada reports to Benoit.", "user_id": "user-123", "agent_id": "agent-456", "metadata": {}, "created_at": "2026-07-15T00:00:00.000Z", "updated_at": "2026-07-15T00:00:00.000Z"
      }
    },
    {
      "relationship": {
        "id": "relationship-benoit", "user_id": "user-123", "source_entity_id": "entity-benoit", "target_entity_id": "entity-chandra", "relation_type": "managed_by", "confidence": 0.8, "evidence_memory_id": "memory-benoit", "metadata": {}, "created_at": "2026-07-15T00:00:01.000Z", "updated_at": "2026-07-15T00:00:01.000Z"
      },
      "source_entity": {
        "id": "entity-benoit", "user_id": "user-123", "name": "Benoit", "type": "person", "metadata": {}, "created_at": "2026-07-15T00:00:01.000Z", "updated_at": "2026-07-15T00:00:01.000Z"
      },
      "target_entity": {
        "id": "entity-chandra", "user_id": "user-123", "name": "Chandra", "type": "person", "metadata": {}, "created_at": "2026-07-15T00:00:02.000Z", "updated_at": "2026-07-15T00:00:02.000Z"
      },
      "evidence_memory": {
        "id": "memory-benoit", "memory": "Benoit is managed by Chandra.", "user_id": "user-123", "agent_id": "agent-456", "metadata": {}, "created_at": "2026-07-15T00:00:01.000Z", "updated_at": "2026-07-15T00:00:01.000Z"
      }
    }
  ],
  "relation_paths": [
    { "entity_ids": ["entity-ada", "entity-benoit", "entity-chandra"], "relationship_ids": ["relationship-ada", "relationship-benoit"] }
  ],
  "request_id": "example-reflect-request-id"
}
```

The returned evidences contain complete relationship, source-entity, target-entity, and supporting-memory records. `relation_paths` identifies the entity and relationship IDs supporting the result; `request_id` is generated for each request.

## Dashboard

Open `$MEM0_URL/dashboard` and sign in with `DASHBOARD_PASSWORD`. The dashboard discovers user and agent entities from active memories, plus user IDs from stored graph entities and saved aliases. It never uses the service API key in the browser.

The dashboard offers:

- **Search memory** performs semantic recall for the selected user or agent.
- **All memories** displays the selected entity's active memories, newest first, with pagination and a detail inspector.
- **Deduplicate memories** is scoped to the selected user or agent and removes only active memories with exactly identical content. It preserves the oldest memory in each duplicate group, requires explicit confirmation, and soft-deletes the redundant memories so their history remains available. Re-running cleanup after an interrupted vector cleanup repairs the remaining vector cleanup without deleting additional memories.
- **Memory graph** displays a selected user's stored entities and relationships as a bounded interactive graph; it is unavailable for agent entities.
- **Import from Mem0** queues a `RawMemoryMigrationExport` for a chosen user or agent target.

The adjacent **Edit** control saves a dashboard-managed alias in D1. Once set, the selector displays the alias rather than the raw user ID; aliases do not alter API ownership, Hermes identities, or stored memory data. Apply the latest D1 migration after upgrading to create the alias table.

### Import from Mem0

The dashboard's **Import from Mem0** view accepts the same `RawMemoryMigrationExport` source either by selecting a `.json` file or by pasting JSON into the textarea. Choose whether the target is a **User** or an **Agent** before queueing it. Selecting a `.json` file loads its contents into that textarea. Its filename base becomes the target entity ID until the target-ID field is manually edited; a manual value is never replaced by later file selections.

The accepted export is exactly this JSON Schema:

```json
{
  "type": "object",
  "title": "RawMemoryMigrationExport",
  "required": ["memories"],
  "properties": {
    "memories": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["memory"],
        "properties": {
          "memory": { "type": "string", "description": "The exact original memory text, preserved verbatim." },
          "created_at": { "anyOf": [{ "type": "string" }, { "type": "null" }], "description": "Original creation timestamp if available; otherwise null." },
          "updated_at": { "anyOf": [{ "type": "string" }, { "type": "null" }], "description": "Original update timestamp if available; otherwise null." }
        }
      },
      "description": "All matching memories. Preserve every source memory as a separate item. Do not merge, summarize, infer, rewrite, or omit memories."
    }
  }
}
```

Submitting posts `{ "entity_type": "user" | "agent", "entity_id": "...", "export": { ... } }` to the signed-session dashboard endpoint `/dashboard/api/imports/mem0`. It returns a queued count and processing continues asynchronously through Cloudflare Queues. Each item is persisted first in the D1 `mem0_import_requests` ledger. The consumer reads the canonical payload from that ledger, waits for Vectorize to accept the upsert, then atomically publishes the memory, history, and completed status in a lease-fenced D1 batch. A scheduled dispatcher recovers rows left unpublished by a producer interruption. Vectorize query visibility can lag briefly after completion, but an upsert failure cannot leave the import permanently present only in D1.

Each source `memory` is stored as exact text with valid source timestamps preserved (missing timestamps use import time). Import processing embeds the text directly, is retry-idempotent, and performs no LLM extraction or graph inference. The Dashboard does not yet show per-import progress or DLQ failures; cross-message Vectorize batching and durable deduplication maintenance are also not part of this first consistency pass.

### Add a memory

```sh
curl -X POST "$MEM0_URL/v1/memories" \
  -H "Authorization: Bearer $MEM0_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "user-123",
    "messages": [{"role": "user", "content": "I prefer concise deployment docs."}],
    "metadata": {"source": "readme"},
    "async": true
  }'
```

### Search memories

```sh
curl -X POST "$MEM0_URL/v1/memories/search" \
  -H "Authorization: Bearer $MEM0_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "user-123",
    "query": "What documentation style do I prefer?",
    "limit": 10
  }'
```

## Local development

Prerequisite: a current Node.js/npm installation and a Cloudflare account for remote resources.

```sh
npm install
```

Create `.dev.vars` (do not commit it):

```dotenv
LLM_API_KEY=replace-with-the-extraction-provider-key
EMBEDDING_API_KEY=replace-with-the-embedding-provider-key
MEM0_API_KEY=replace-with-a-long-random-api-key
DASHBOARD_PASSWORD=replace-with-a-strong-dashboard-password
```

Models and endpoints are normal Worker variables, not secrets. Set their deployed values in the Cloudflare dashboard under **Workers & Pages > your Worker > Settings > Variables and Secrets**, or change the defaults in `wrangler.toml`:

```toml
LLM_MODEL=gpt-4o-mini
EMBEDDING_MODEL=text-embedding-3-small
LLM_API_BASE_URL=https://openrouter.ai/api/v1
EMBEDDING_API_BASE_URL=https://openrouter.ai/api/v1
GRAPH_LLM_API_BASE_URL=https://openrouter.ai/api/v1
GRAPH_LLM_MODEL=deepseek/deepseek-v4-flash
GRAPH_LLM_THINKING_LEVEL=low
```

`LLM_MODEL` and `EMBEDDING_MODEL` are configurable independently. Ensure the selected embedding model returns **1,536 dimensions or fewer**: Cloudflare Vectorize currently caps vectors at 1,536 float32 dimensions. This Worker rejects larger embedding responses before attempting an upsert. [Cloudflare Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/)

For Hermes, configure the Worker URL and shared key in the gateway environment:

```dotenv
MEM0_HOST=https://your-worker.example.workers.dev
MEM0_API_KEY=the-same-value-configured-as-the-Worker-secret
MEM0_USER_ID=stable-user-identifier
MEM0_AGENT_ID=hermes
```

Then run the Worker:

```sh
npm run dev
```

Use the local URL printed by Wrangler, typically `http://localhost:8787`. Visit `/dashboard` and log in with `DASHBOARD_PASSWORD`.

### Remote read-only dashboard preview

Run `npm run dev:remote-readonly` to execute local dashboard code with the configured remote D1 and Vectorize resources; queue bindings remain local. The preview reads remote data but the server rejects dashboard alias, deduplication, import, and agent-reclassification mutations with `403`; it does not change the deployed Worker configuration.

Open the local URL printed by Wrangler, sign in with `DASHBOARD_PASSWORD`, select `User: curl-403-probe-user-5940ad806c8e4792a38908c026b276e3`, and open **Memory graph** to inspect the retained graph probe data.

Run checks with:

```sh
npm test
npm run typecheck
```

## Provision Cloudflare resources

`wrangler.toml` is intentionally checked in with an all-zero D1 `database_id`. Replace it before deploying.

1. Create D1 and copy the reported `database_id` into `wrangler.toml`:

   ```sh
   npx wrangler d1 create mem0-edge
   ```

2. Create the Vectorize index with the dimensions and metric expected by the configured embedding model:

   ```sh
   npx wrangler vectorize create mem0-edge --dimensions=1536 --metric=cosine
   npx wrangler vectorize create mem0-edge-entities --dimensions=1536 --metric=cosine
   ```

3. Create the configured Queue:

   ```sh
   npx wrangler queues create mem0-edge-memory-jobs
   ```

4. Before using semantic-search filters, add Vectorize metadata indexes for every identity field the Worker filters on:

   ```sh
   npx wrangler vectorize create-metadata-index mem0-edge --property-name=user_id --type=string
   npx wrangler vectorize create-metadata-index mem0-edge --property-name=agent_id --type=string
   npx wrangler vectorize create-metadata-index mem0-edge --property-name=run_id --type=string
   npx wrangler vectorize create-metadata-index mem0-edge --property-name=actor_id --type=string
   npx wrangler vectorize create-metadata-index mem0-edge-entities --property-name=user_id --type=string
   ```

5. Apply the D1 migrations from the configured `src/migrations` directory. Migration `0005_reflect_graph_indexes.sql` must be applied before deploying graph reflection:

   ```sh
   npx wrangler d1 migrations apply mem0-edge --remote
   ```

6. Set deployment secrets. Use strong, distinct values for the service API key and dashboard password:

   ```sh
   npx wrangler secret put LLM_API_KEY
   npx wrangler secret put EMBEDDING_API_KEY
   npx wrangler secret put MEM0_API_KEY
   npx wrangler secret put DASHBOARD_PASSWORD
   npx wrangler secret put GRAPH_LLM_API_KEY
   ```

For an existing deployment, create both `LLM_API_KEY` and `EMBEDDING_API_KEY` before deploying this version. `GRAPH_LLM_API_KEY` remains the separate graph reflection credential. The legacy `OPENAI_API_KEY` is no longer read and can be removed after the deployment succeeds.

`EMBEDDING_MODEL` and `LLM_MODEL` are runtime settings. `VECTOR_DIMENSIONS` and `MEM0_INDEX_NAME` document the deployment convention; the effective Vectorize resource is the `[[vectorize]]` binding, and its dimensions must match the embedding model response.

## Manual deployment

After provisioning, setting secrets, and replacing the all-zero D1 ID:

```sh
npm run deploy
```

Wrangler prints the deployed Worker URL. Set it as `MEM0_URL` for the examples above, and open `$MEM0_URL/dashboard` to log in.

## Edge-runtime boundaries

- Extraction persists graph-lite entities, memory links, and relationships in D1; the graph API intentionally remains bounded read functionality, not Mem0's full graph system.
- The LLM integration is limited to the implemented OpenAI-compatible provider flow, not the full provider ecosystem available in Python Mem0.
- This standalone Worker intentionally does not promise full Python Mem0 API or behavior parity.
