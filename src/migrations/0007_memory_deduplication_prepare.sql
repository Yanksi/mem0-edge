ALTER TABLE memories ADD COLUMN content_hash TEXT;
ALTER TABLE memory_requests ADD COLUMN cleanup_vector_ids_json TEXT;
ALTER TABLE mem0_import_requests ADD COLUMN cleanup_vector_id TEXT;

CREATE INDEX memories_active_user_agent_content_hash_lookup_idx
  ON memories (user_id, agent_id, content_hash)
  WHERE deleted_at IS NULL AND user_id IS NOT NULL AND agent_id IS NOT NULL;
CREATE INDEX memories_active_user_content_hash_lookup_idx
  ON memories (user_id, content_hash)
  WHERE deleted_at IS NULL AND user_id IS NOT NULL AND agent_id IS NULL;
CREATE INDEX memories_active_agent_content_hash_lookup_idx
  ON memories (agent_id, content_hash)
  WHERE deleted_at IS NULL AND user_id IS NULL AND agent_id IS NOT NULL;

CREATE TABLE service_settings (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  semantic_dedup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (semantic_dedup_enabled IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO service_settings (id, semantic_dedup_enabled) VALUES (1, 0);
