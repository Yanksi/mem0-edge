CREATE INDEX relationships_user_source_idx ON relationships (user_id, source_entity_id);
CREATE INDEX relationships_user_target_idx ON relationships (user_id, target_entity_id);
