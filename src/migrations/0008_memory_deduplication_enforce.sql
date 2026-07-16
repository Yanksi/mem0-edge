PRAGMA defer_foreign_keys = on;

CREATE TABLE memories_rebuild (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  agent_id TEXT,
  run_id TEXT,
  actor_id TEXT,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER
);

CREATE TABLE memory_history_rebuild (
  id TEXT PRIMARY KEY NOT NULL,
  memory_id TEXT NOT NULL REFERENCES memories_rebuild(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE relationships_rebuild (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  source_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  confidence REAL,
  evidence_memory_id TEXT REFERENCES memories_rebuild(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE memory_entity_links_rebuild (
  memory_id TEXT NOT NULL REFERENCES memories_rebuild(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (memory_id, entity_id)
);

INSERT INTO memories_rebuild (
  id, user_id, agent_id, run_id, actor_id, content, metadata_json, hash,
  content_hash, created_at, updated_at, deleted_at
)
SELECT id, user_id, agent_id, run_id, actor_id, content, metadata_json, hash,
  content_hash, created_at, updated_at, deleted_at
FROM memories;

INSERT INTO memory_history_rebuild
  (id, memory_id, operation, content, metadata_json, hash, created_at)
SELECT id, memory_id, operation, content, metadata_json, hash, created_at
FROM memory_history;

INSERT INTO relationships_rebuild (
  id, user_id, source_entity_id, target_entity_id, relation_type, confidence,
  evidence_memory_id, metadata_json, created_at, updated_at
)
SELECT id, user_id, source_entity_id, target_entity_id, relation_type,
  confidence, evidence_memory_id, metadata_json, created_at, updated_at
FROM relationships;

INSERT INTO memory_entity_links_rebuild (memory_id, entity_id, created_at)
SELECT memory_id, entity_id, created_at FROM memory_entity_links;

DROP TABLE memory_history;
DROP TABLE memory_entity_links;
DROP TABLE relationships;
DROP TABLE memories;
ALTER TABLE memories_rebuild RENAME TO memories;
ALTER TABLE memory_history_rebuild RENAME TO memory_history;
ALTER TABLE relationships_rebuild RENAME TO relationships;
ALTER TABLE memory_entity_links_rebuild RENAME TO memory_entity_links;

CREATE INDEX memories_user_agent_deleted_at_idx
  ON memories (user_id, agent_id, deleted_at);
CREATE INDEX memories_hash_idx ON memories (hash);
CREATE UNIQUE INDEX memories_active_user_agent_content_idx
  ON memories (user_id, agent_id, content_hash, content)
  WHERE deleted_at IS NULL AND user_id IS NOT NULL AND agent_id IS NOT NULL;
CREATE UNIQUE INDEX memories_active_user_content_idx
  ON memories (user_id, content_hash, content)
  WHERE deleted_at IS NULL AND user_id IS NOT NULL AND agent_id IS NULL;
CREATE UNIQUE INDEX memories_active_agent_content_idx
  ON memories (agent_id, content_hash, content)
  WHERE deleted_at IS NULL AND user_id IS NULL AND agent_id IS NOT NULL;
CREATE INDEX memory_history_memory_created_at_idx
  ON memory_history (memory_id, created_at);
CREATE INDEX relationships_user_source_idx
  ON relationships (user_id, source_entity_id);
CREATE INDEX relationships_user_target_idx
  ON relationships (user_id, target_entity_id);
CREATE INDEX relationships_source_entity_idx
  ON relationships (source_entity_id);
CREATE INDEX relationships_target_entity_idx
  ON relationships (target_entity_id);
CREATE INDEX relationships_evidence_memory_idx
  ON relationships (evidence_memory_id);
CREATE INDEX memory_entity_links_entity_memory_idx
  ON memory_entity_links (entity_id, memory_id);
