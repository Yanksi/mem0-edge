# Hermes V1 Compatibility Design

## Goal

Make the `/v1` Worker surface compatible with Hermes Agent's self-hosted Mem0 client without changing memory storage, extraction, or Vectorize behavior.

## Design

`/v1/memories` remains the native API. Its search and item handlers accept the Hermes request vocabulary in addition to the native vocabulary:

- `POST /v1/memories/search` accepts either native `user_id` and `limit`, or Hermes `filters.user_id` and `top_k`.
- `POST /v1/search` is an alias that only accepts the Hermes search contract.
- `PUT /v1/memories/:id` accepts Hermes `{ "text": "..." }` and resolves the stored user owner before calling the existing update service.
- `DELETE /v1/memories/:id` without `user_id` resolves the stored owner before calling the existing delete service. The native query-scoped delete behavior is unchanged.

IDs remain opaque non-empty path values. No UUID or other format validation is introduced.

## Scope

The change covers Hermes add, search, update, and delete under a `/v1` base URL. It does not alter D1 schema, Vectorize metadata, user isolation, or graph behavior. Agent-only records keep returning a conflict for owner-resolved update/delete because those service operations remain user-scoped.

## Verification

Route tests use Hermes's exact search and update payloads, SHA-256-like memory IDs, and the existing native request forms. After deployment, the existing `compatibility-test` probe is deleted through the repaired endpoint.
