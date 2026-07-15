# Remote Read-only Dashboard Preview

## Goal

Allow local Dashboard UI development against the existing Cloudflare test data without allowing the local preview to mutate remote state. Resolve the confusing empty graph state when an agent entity is selected or the selected entity changes while the graph view is open.

## Local Preview

Add an `npm run dev:remote-readonly` command that starts `wrangler dev --remote` with a local-only `DASHBOARD_READ_ONLY=true` variable. The preview uses the configured remote D1, Vectorize, Queue, and Worker secrets, so it can inspect the current Cloudflare test users such as `curl-403-probe-*`.

The local-only variable must not be added to `wrangler.toml`; production deployments must retain their current behavior.

## Read-only Enforcement

When `DASHBOARD_READ_ONLY` is `true`:

- The Dashboard shows a persistent remote read-only preview notice.
- The Dashboard disables controls for alias changes, exact-text deduplication, Mem0 imports, and agent reclassification.
- The corresponding Dashboard API mutation routes return `403` before any database, Vectorize, or Queue work begins.
- Read operations remain available: user discovery, memory browsing, semantic search, and graph reads.

Server-side checks are authoritative. Disabled browser controls are only a usability safeguard.

## Graph View

The graph view is available only for user entities because graph entities and relationships are stored by `user_id`.

- Selecting an agent replaces the graph canvas with an explicit message explaining that graph data belongs to the corresponding user entity.
- Changing the selected entity while the graph view is active reloads the graph immediately.
- A user graph response with entities and relationships renders its SVG normally; the graph status shows the returned counts.

## Verification

Tests cover:

- Each protected Dashboard mutation returns `403` in read-only mode and does not invoke its underlying service.
- Dashboard HTML exposes the preview state needed to disable mutation controls.
- Switching the selected entity in an active graph view reloads it, and an agent selection renders the explicit unavailable state.

Manual local acceptance uses `npm run dev:remote-readonly`, Dashboard login, and the retained `curl-403-probe-user-*` graph data. No production deploy occurs until the local preview is verified.
