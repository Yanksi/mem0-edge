# Hermes Explicit Graph Reflection Integration Contract

## Purpose

The Mem0 Worker exposes an explicit, read-only graph reflection API for
questions that require relationships across multiple memories. Hermes should
expose this capability as a dedicated agent tool, separate from ordinary
semantic memory search.

Recommended tool name:

```text
mem0_reflect
```

The endpoint:

- reads semantic memories and graph records;
- performs bounded graph traversal;
- uses the configured graph LLM to synthesize an answer;
- returns complete supporting entities, relationships, memories, and paths;
- does not create, update, or delete any memory or graph record.

## Endpoint

```http
POST /v1/reflect
Content-Type: application/json
```

Current deployment:
# Mem0 Cloudflare `POST /v1/reflect` 测试报告

- **测试时间**：2026-07-15（UTC；请求响应头时间约 23:21–23:26 UTC）
- **测试目标**：`https://mem0.yanksi.li/v1/reflect`
- **方法**：从 Hermes 容器通过既有 `env-tool` 注入 `MEM0_API_KEY`，以 `curl` 发送只读 `POST` 请求。
- **安全说明**：本报告不包含 API key、请求认证头或其他凭证。
- **数据安全说明**：所有请求均为 read-only；没有写入、更新、删除 memory 或 graph 数据。

---

## 1. 结论摘要

接口已经从“路由不存在”推进到“路由可达”：之前该路径返回 `404`，本次已能命中 Worker。

但是当前实现还**不具备 Hermes 接入条件**：

1. 空 memory namespace 可以正常返回 `200 OK`；
2. 主人的真实、非空 memory namespace 在中英文 query 下均返回 `500 Internal server error`；
3. 当前成功响应的 `result` / `evidences` 字段与后续提供的正式 API contract 一致；
4. 因此暂时不要启用 Hermes 侧的 `mem0_reflect` 工具或切换 memory provider。

这表明认证、路由、基本参数解析和“没有候选记忆”的降级分支已经工作；故障更可能位于**非空 corpus 的检索、graph expansion、evidence 组装、graph LLM synthesis 或响应序列化**分支。

---

## 2. 测试环境与请求形状

所有请求使用：

```http
POST /v1/reflect
Content-Type: application/json
Accept: application/json
X-API-Key: <injected; not printed>
```

请求体遵循：

```json
{
  "query": "...",
  "user_id": "...",
  "agent_id": "..."
}
```

认证凭证通过本机 credential relay 的 `env-tool run MEM0_API_KEY -- ...` 注入到子进程环境中；终端没有输出 key。

---

## 3. 测试结果

| 编号 | user namespace | Query | HTTP 结果 | 结论 |
|---:|---|---|---:|---|
| A | 临时、空 namespace `reflect-readonly-probe-20260715` | `What is known about this user?` | `200 OK` | 空候选集降级路径正常 |
| B | 主人的实际 namespace `288035119623569418` | 中文的“当前长期 memory system 方案选择”问题 | `500` | 非空 corpus 路径失败 |
| C | 主人的实际 namespace `288035119623569418` | 英文的同类 memory-system preference 问题 | `500` | 不是语言特有问题；与 B 一致 |
| D | 主人的实际 namespace `288035119623569418` | 与 C 相同；改用 `Authorization: Bearer` | `500` | 不是 `X-API-Key` 与 Bearer header 的差异 |

### A — 空 namespace：成功

请求使用一个此前不存在的临时 `user_id`，不会读到真实用户的 memory。返回：

```http
HTTP/2 200
content-type: application/json
cf-ray: a1bc8321c845dc8b-ZRH
```

```json
{
  "result": "I cannot answer reliably from the retrieved memories.",
  "uncertainty": "high",
  "evidences": [],
  "relation_paths": [],
  "limitations": "No relevant stored memory evidence was found.",
  "request_id": "SXg1hmXrK2yDTOCXW5zex"
}
```

确认的正向行为：

- endpoint route 已部署；
- 认证通过；
- JSON body 被接受；
- 缺少相关记忆时会返回可解释的高不确定性结果，而不是 hallucinate；
- 返回 `relation_paths`、`limitations`、`request_id` 等可观测字段。

### B — 真实 namespace，中文 query：失败

```http
HTTP/2 500
content-type: application/json
cf-ray: a1bc8070c983039b-ZRH
```

```json
{
  "error": "Internal server error"
}
```

### C — 真实 namespace，英文 query：失败

```http
HTTP/2 500
content-type: application/json
cf-ray: a1bc87771fa34f9a-ZRH
```

```json
{
  "error": "Internal server error"
}
```

B/C 的 query 语言不同，但都对同一真实、非空 namespace 失败。因此目前没有证据支持“中文 prompt 或特定 query 文本导致失败”的假设；更优先的假设是：只有在取到 memory / entity / relation / evidence 后才触发的服务端代码路径有异常。

---

### D — 真实 namespace，Bearer auth：仍失败

按照正式 contract 推荐的认证方式，使用同一有效 key 改为：

```http
Authorization: Bearer <injected key>
```

请求仍返回：

```http
HTTP/2 500
cf-ray: a1bc8e6ccb914f9a-ZRH
```

因此不是认证 header 选择造成的问题。

---

## 4. 与正式 API contract 的核对

用户随后提供的正式 contract 指定成功响应使用：

```json
{
  "result": "string",
  "uncertainty": "low | medium | high",
  "evidences": [],
  "relation_paths": [],
  "request_id": "string"
}
```

空 namespace 的实际 `200` 响应与该 contract 一致：它正确返回了 `result`、`uncertainty`、`evidences`、`relation_paths`、`limitations` 和 `request_id`。

先前报告中的“应为 `answer` / `evidence`”来自较早的草案，已经根据这份正式 contract 更正。当前失败不属于 response 字段命名或客户端 request shape 问题。

Hermes 后续 adapter 应严格采用本 contract：成功时保留完整 structured response；`uncertainty: "high"` 是合法无证据结果；非 `2xx` 才是 tool error。

---

## 5. Codex 排查建议

请使用上面的 `cf-ray` 及成功响应中的 `request_id` 关联 Worker 日志，优先比较：

```text
空 namespace（200）
vs.
真实、非空 namespace（500）
```

优先检查顺序：

1. `/reflect` 的语义检索返回结构是否与 endpoint 的解析逻辑一致；
2. 由 candidate memories 到 entities / relations / graph neighbors 的查询是否对空值、缺失字段、非预期 ID 形状健壮；
3. 所有 graph / relation 查询是否严格带 `user_id` 过滤；
4. evidence 构造时是否假设了每条 memory 都存在 entity、relation 或 metadata；
5. 非空 evidence 进入 LLM synthesis 后，prompt 组装、LLM response JSON parse、schema validation 是否抛异常；
6. Worker 是否将真实异常仅吞成通用 `500`。生产响应可继续保持通用错误，但内部 log 应记录 request ID、阶段名和 stack trace；
7. 将空-result 和有-evidence 的 response 字段统一到稳定 API contract。

推荐在 Worker 内部记录非敏感阶段标识，例如：

```text
reflect.auth_ok
reflect.semantic_search_done (candidate_count)
reflect.graph_expand_done (node_count, edge_count)
reflect.evidence_bounded (evidence_count)
reflect.llm_done
reflect.response_validated
```

日志中不要记录 API key 或完整用户 memory 正文。

---

## 6. 下一步验收条件

修复后，应使用新的临时、唯一 test `user_id` 写入两条 `infer: true` 的关系事实，并验证：

1. `/v1/reflect` 返回 `200`；
2. `answer` 可以从两条关系事实得出，或诚实说明证据不足；
3. 返回的 evidence IDs 都能在该临时 namespace 中找到；
4. `relation_paths`（若返回）不越过 `user_id` 隔离边界；
5. 相同 endpoint 对空 namespace 仍返回 `200 + uncertainty: high`；
6. 无论成功或失败，调用前后 memory / graph 数据都不发生写入；
7. Hermes 侧在 endpoint 与字段 contract 均通过后，才实现并启用 feature-gated `mem0_reflect`。

---

## 7. 当前 rollout 状态

```text
Worker route:          已部署，部分路径可用
Authenticated probe:   成功
Empty-namespace path:  通过
Non-empty corpus path: 失败（500）
Hermes integration:    未启用；应保持未启用
Production readiness:  未通过
```

```text
https://mem0.yanksi.li/v1/reflect
```

### Base URL normalization

If the configured Mem0 host already ends with `/v1`, append `/reflect`.
Otherwise, append `/v1/reflect`. The implementation must not produce a path
such as `/v1/v1/reflect`.

## Authentication

Either authentication header is accepted:

```http
Authorization: Bearer {MEM0_API_KEY}
```

```http
X-API-Key: {MEM0_API_KEY}
```

Bearer authentication is recommended for Hermes. The API key must never be
included in tool output, logs, model-visible arguments, or error messages.

## Request Contract

```ts
interface ReflectRequest {
  /** Natural-language question. Trimmed length must be 1-4000 characters. */
  query: string;

  /** Required non-empty Mem0 user identity. */
  user_id: string;

  /** Required non-empty Mem0 agent identity. */
  agent_id: string;
}
```

Both `user_id` and `agent_id` are required by the current endpoint.

Example:

```json
{
  "query": "Who manages Ada's collaborator?",
  "user_id": "discord-user-123",
  "agent_id": "hermes"
}
```

## Hermes Tool Interface

The agent-facing tool should expose only the question:

```ts
mem0_reflect({
  query: string
}): Promise<ReflectResponse>
```

Hermes should inject the following values from the active Mem0 profile:

- `user_id`;
- `agent_id`;
- Mem0 host;
- Mem0 API key.

The model must not manually provide or override identity or authentication
fields. If either identity is absent, Hermes should fail locally with a clear
configuration error instead of sending an incomplete request.

## Successful Response Contract

A successful request returns HTTP `200`.

```ts
interface ReflectResponse {
  /** Answer synthesized from graph evidence. */
  result: string;

  /**
   * Current Worker behavior:
   * - "medium": graph evidence was selected successfully
   * - "high": no reliable graph evidence was found
   *
   * Clients should accept "low" for forward compatibility.
   */
  uncertainty: "low" | "medium" | "high";

  /** Complete graph records selected as evidence. */
  evidences: ReflectEvidence[];

  /** Ordered graph paths supporting the result. */
  relation_paths: RelationPath[];

  /** Usually present when no reliable evidence was found. */
  limitations?: string;

  /** Opaque per-request identifier for diagnostics. */
  request_id: string;
}

interface ReflectEvidence {
  relationship: Relationship;
  source_entity: Entity;
  target_entity: Entity;
  evidence_memory?: Memory;
}

interface Entity {
  id: string;
  user_id: string;
  name: string;
  type: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface Relationship {
  id: string;
  user_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  confidence?: number;
  evidence_memory_id?: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface Memory {
  id: string;
  memory: string;
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  actor_id?: string;
  score?: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface RelationPath {
  /** Ordered entity IDs visited by this path. */
  entity_ids: string[];

  /** Ordered relationship IDs connecting the entities. */
  relationship_ids: string[];
}
```

`created_at` and `updated_at` are ISO 8601 timestamps. The `score` field is
part of the general memory response contract but is not guaranteed to be
present in reflection evidence.

## Evidence-backed Response Example

```json
{
  "result": "Chandra manages Ada's collaborator Benoit.",
  "uncertainty": "medium",
  "evidences": [
    {
      "relationship": {
        "id": "relationship-ada-benoit",
        "user_id": "user-123",
        "source_entity_id": "entity-ada",
        "target_entity_id": "entity-benoit",
        "relation_type": "works_with",
        "confidence": 0.94,
        "evidence_memory_id": "memory-ada",
        "metadata": {},
        "created_at": "2026-07-15T00:00:00.000Z",
        "updated_at": "2026-07-15T00:00:00.000Z"
      },
      "source_entity": {
        "id": "entity-ada",
        "user_id": "user-123",
        "name": "Ada",
        "type": "person",
        "metadata": {},
        "created_at": "2026-07-15T00:00:00.000Z",
        "updated_at": "2026-07-15T00:00:00.000Z"
      },
      "target_entity": {
        "id": "entity-benoit",
        "user_id": "user-123",
        "name": "Benoit",
        "type": "person",
        "metadata": {},
        "created_at": "2026-07-15T00:00:00.000Z",
        "updated_at": "2026-07-15T00:00:00.000Z"
      },
      "evidence_memory": {
        "id": "memory-ada",
        "memory": "Ada works with Benoit.",
        "user_id": "user-123",
        "agent_id": "hermes",
        "metadata": {},
        "created_at": "2026-07-15T00:00:00.000Z",
        "updated_at": "2026-07-15T00:00:00.000Z"
      }
    },
    {
      "relationship": {
        "id": "relationship-benoit-chandra",
        "user_id": "user-123",
        "source_entity_id": "entity-benoit",
        "target_entity_id": "entity-chandra",
        "relation_type": "reports_to",
        "confidence": 0.91,
        "evidence_memory_id": "memory-benoit",
        "metadata": {},
        "created_at": "2026-07-15T00:00:01.000Z",
        "updated_at": "2026-07-15T00:00:01.000Z"
      },
      "source_entity": {
        "id": "entity-benoit",
        "user_id": "user-123",
        "name": "Benoit",
        "type": "person",
        "metadata": {},
        "created_at": "2026-07-15T00:00:00.000Z",
        "updated_at": "2026-07-15T00:00:00.000Z"
      },
      "target_entity": {
        "id": "entity-chandra",
        "user_id": "user-123",
        "name": "Chandra",
        "type": "person",
        "metadata": {},
        "created_at": "2026-07-15T00:00:01.000Z",
        "updated_at": "2026-07-15T00:00:01.000Z"
      },
      "evidence_memory": {
        "id": "memory-benoit",
        "memory": "Benoit reports to Chandra.",
        "user_id": "user-123",
        "agent_id": "hermes",
        "metadata": {},
        "created_at": "2026-07-15T00:00:01.000Z",
        "updated_at": "2026-07-15T00:00:01.000Z"
      }
    }
  ],
  "relation_paths": [
    {
      "entity_ids": [
        "entity-ada",
        "entity-benoit",
        "entity-chandra"
      ],
      "relationship_ids": [
        "relationship-ada-benoit",
        "relationship-benoit-chandra"
      ]
    }
  ],
  "request_id": "V1StGXR8_Z5jdHi6B-myT"
}
```

## No-evidence Response

A lack of reliable graph evidence is not an HTTP error. The Worker returns HTTP
`200` with:

```json
{
  "result": "I cannot answer reliably from the retrieved memories.",
  "uncertainty": "high",
  "evidences": [],
  "relation_paths": [],
  "limitations": "No relevant stored memory evidence was found.",
  "request_id": "V1StGXR8_Z5jdHi6B-myT"
}
```

Hermes must treat this as:

- a successful tool invocation;
- an explicit indication that no reliable answer was found;
- not a provider failure;
- not a new fact;
- not a memory that should be written back into Mem0.

Hermes should preserve `uncertainty` and `limitations` when presenting the
result to the agent.

## Error Contract

All API errors return a JSON object with an `error` field:

```ts
interface ReflectErrorResponse {
  error: string;
}
```

### Validation failure

HTTP `400`:

```json
{ "error": "Validation failed" }
```

This includes malformed JSON, an invalid query, or missing identity fields.

### Authentication failure

HTTP `401`:

```json
{ "error": "Unauthorized" }
```

### Graph provider failure

HTTP `502`:

```json
{ "error": "Graph reflection provider request failed" }
```

### Missing graph configuration

HTTP `503`:

```json
{ "error": "Graph reflection is not configured" }
```

### Unexpected Worker failure

HTTP `500`:

```json
{ "error": "Internal server error" }
```

Hermes should treat every non-`2xx` response as a tool error and retain the HTTP
status and returned error text for diagnostics.

## Timeout and Retry Behavior

The Worker allows the graph reflection model up to 20 seconds to respond. The
Hermes HTTP client should use a timeout of at least 30 seconds.

Recommended behavior:

- do not retry `400` or `401`;
- do not retry `503` caused by missing configuration;
- allow at most one bounded retry for a transient network failure or `502`;
- do not retry indefinitely;
- do not convert a failed reflection request into a memory write.

Because `/v1/reflect` is read-only, retrying a transient request cannot create
duplicate records.

## Response Parsing Requirements

Required top-level fields:

```text
result
uncertainty
evidences
relation_paths
request_id
```

`limitations` is optional.

Required fields inside every evidence item:

```text
relationship
source_entity
target_entity
```

`evidence_memory` is optional.

For forward compatibility, the Hermes parser should:

- accept unknown additional fields;
- preserve fields it understands;
- reject responses missing required fields;
- reject invalid `uncertainty` values;
- reject non-array `evidences` or `relation_paths`;
- treat memory text, entity names, predicates, and metadata as untrusted data.

## Recommended Agent-facing Representation

Hermes should return the complete structured response to the agent rather than
reducing it to only `result`. A model-friendly rendering may be:

```text
Result:
Chandra manages Ada's collaborator Benoit.

Uncertainty:
medium

Evidence:
1. Ada --works_with--> Benoit
   Supporting memory: "Ada works with Benoit."

2. Benoit --reports_to--> Chandra
   Supporting memory: "Benoit reports to Chandra."

Paths:
Ada -> Benoit -> Chandra

Request ID:
V1StGXR8_Z5jdHi6B-myT
```

The raw structured response should remain available to the provider and tool
implementation.

## Recommended Tool Description

```text
Use graph-aware long-term memory to answer a question that may require
connecting entities and relationships across multiple stored memories.

This tool is read-only. It returns an answer, uncertainty, complete supporting
relationships and entities, optional source memories, and graph paths.

Use it when ordinary semantic memory search is insufficient, especially for
questions involving people, organizations, ownership, reporting structure,
collaboration, chronology, dependencies, or multi-step relationships.

Do not use it to add, update, or delete memories.
```

Recommended agent-facing argument schema:

```json
{
  "type": "object",
  "required": ["query"],
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000,
      "description": "A natural-language question to answer from graph-connected long-term memories."
    }
  },
  "additionalProperties": false
}
```

## Provider Integration Requirements

The Hermes Mem0 provider patch should:

1. Add a dedicated `mem0_reflect` tool.
2. Expose only `query` to the agent.
3. Load `host`, `user_id`, `agent_id`, and the API key from the active Mem0 profile.
4. Require both `user_id` and `agent_id`.
5. Normalize the host without creating a duplicate `/v1` segment.
6. Send an authenticated `POST /v1/reflect` request.
7. Use a client timeout of at least 30 seconds.
8. Parse and retain the complete structured response.
9. Treat HTTP `200` with `uncertainty: "high"` as a valid no-evidence result.
10. Treat non-`2xx` responses as tool errors.
11. Never write a reflection result back into memory automatically.
12. Never expose authentication credentials to the agent.
13. Preserve `request_id` for diagnostics.
14. Accept unknown response fields for forward compatibility.

## Current Server-side Retrieval Bounds

```text
Semantic memory seeds: 12
Graph traversal depth: 2 hops
Maximum entities: 24
Maximum relationships: 32
Maximum evidence memories: 20
Maximum evidence text: 24,000 characters
Graph LLM calls per request: 1
Graph LLM timeout: 20 seconds
```

These are server-side limits. Hermes does not need to send or configure them.

## Scope and Isolation

The request includes both `user_id` and `agent_id`. The current service uses
both values when retrieving semantic seed memories. Stored graph entities and
relationships are isolated by `user_id`.

Hermes must send identity values from the active Mem0 profile and must not let
the model select arbitrary identity values.

The endpoint is designed for explicit graph reasoning. It does not replace:

```text
POST /v1/search
POST /v1/memories
PUT /v1/memories/{id}
DELETE /v1/memories/{id}
```

Ordinary memory search and graph reflection should remain separate agent tools.
