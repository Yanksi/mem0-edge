CREATE TABLE mem0_import_requests (
  request_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('user', 'agent')),
  entity_id TEXT NOT NULL,
  item_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token INTEGER NOT NULL DEFAULT 0,
  publish_token INTEGER NOT NULL DEFAULT 0,
  publish_attempted_at INTEGER,
  published_at INTEGER,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);

CREATE INDEX mem0_import_requests_status_updated_at_idx
  ON mem0_import_requests (status, updated_at);

CREATE INDEX mem0_import_requests_dispatch_idx
  ON mem0_import_requests (status, published_at, publish_attempted_at);
