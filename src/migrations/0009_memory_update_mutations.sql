ALTER TABLE memories ADD COLUMN mutation_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_mutation_id TEXT;

CREATE TABLE memory_update_mutations (
  mutation_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  target_version INTEGER NOT NULL,
  target_content TEXT NOT NULL,
  target_content_hash TEXT NOT NULL,
  target_metadata_json TEXT NOT NULL,
  graph_json TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'preparing', 'prepared', 'd1_committed', 'vectors_committed',
    'completed', 'superseded', 'failed_conflict'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  publish_token INTEGER NOT NULL DEFAULT 0,
  publish_attempted_at INTEGER,
  published_at INTEGER,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);

CREATE UNIQUE INDEX memory_update_mutations_active_memory_idx
  ON memory_update_mutations (memory_id)
  WHERE status NOT IN ('completed', 'superseded', 'failed_conflict');

CREATE INDEX memory_update_mutations_dispatch_idx
  ON memory_update_mutations (status, published_at, publish_attempted_at, updated_at);

CREATE TABLE memory_update_vector_intents (
  mutation_id TEXT NOT NULL REFERENCES memory_update_mutations(mutation_id) ON DELETE CASCADE,
  index_kind TEXT NOT NULL CHECK (index_kind IN ('memory', 'entity')),
  vector_id TEXT NOT NULL,
  values_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied')),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (mutation_id, index_kind, vector_id)
);

CREATE INDEX memory_update_vector_intents_pending_idx
  ON memory_update_vector_intents (mutation_id, status, index_kind, vector_id);
