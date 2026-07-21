import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
// Vite supplies this raw asset transform during Vitest execution.
// @ts-expect-error -- this scaffold does not include Vite's client asset declarations.
import initialMigration from '../src/migrations/0001_initial.sql?raw';
// @ts-expect-error -- this scaffold does not include Vite's client asset declarations.
import idempotencyRequestsMigration from '../src/migrations/0002_idempotency_requests.sql?raw';
// @ts-expect-error -- this scaffold does not include Vite's client asset declarations.
import memoryRequestLeasesMigration from '../src/migrations/0003_memory_request_leases.sql?raw';
// @ts-expect-error -- this scaffold does not include Vite's client asset declarations.
import agentScopedMemoriesMigration from '../src/migrations/0004_agent_scoped_memories.sql?raw';
// @ts-expect-error -- this scaffold does not include Vite's client asset declarations.
import reflectGraphIndexesMigration from '../src/migrations/0005_reflect_graph_indexes.sql?raw';
// @ts-expect-error -- this scaffold does not include Vite's client asset declarations.
import mem0ImportRequestsMigration from '../src/migrations/0006_mem0_import_requests.sql?raw';
// @ts-expect-error -- this scaffold does not include Vite's client asset declarations.
import memoryDeduplicationPrepareMigration from '../src/migrations/0007_memory_deduplication_prepare.sql?raw';
// @ts-expect-error -- this scaffold does not include Vite's client asset declarations.
import memoryDeduplicationEnforceMigration from '../src/migrations/0008_memory_deduplication_enforce.sql?raw';
// @ts-expect-error -- this scaffold does not include Vite's client asset declarations.
import memoryUpdateMutationsMigration from '../src/migrations/0009_memory_update_mutations.sql?raw';
import {
  apiKeys,
  entities,
  mem0ImportRequests,
  memories,
  memoryRequests,
  memoryEntityLinks,
  memoryHistory,
  memoryUpdateMutations,
  memoryUpdateVectorIntents,
  relationships,
  serviceSettings,
} from '../src/db/schema';

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

describe('database schema', () => {
  it('exposes the core database column names', () => {
    expect(apiKeys.id.name).toBe('id');
    expect(memories.id.name).toBe('id');
    expect(entities.name.name).toBe('name');
    expect(relationships.relationType.name).toBe('relation_type');
    expect(memoryHistory.memoryId.name).toBe('memory_id');
  });

  it('uses memory and entity IDs as the composite link primary key', () => {
    const [primaryKey] = getTableConfig(memoryEntityLinks).primaryKeys;

    expect(primaryKey.columns.map((column) => column.name)).toEqual([
      'memory_id',
      'entity_id',
    ]);
  });

  it('uses the user ID and idempotency key as the request ledger primary key', () => {
    const [primaryKey] = getTableConfig(memoryRequests).primaryKeys;

    expect(primaryKey.columns.map((column) => column.name)).toEqual([
      'user_id',
      'idempotency_key',
    ]);
  });

  it('declares the named unique indexes in the Drizzle schema', () => {
    const apiKeyIndexes = getTableConfig(apiKeys).indexes.map((index) => index.config);
    const entityIndexes = getTableConfig(entities).indexes.map((index) => index.config);

    expect(apiKeyIndexes).toContainEqual(
      expect.objectContaining({ name: 'api_keys_key_hash_idx', unique: true }),
    );
    expect(entityIndexes).toContainEqual(
      expect.objectContaining({ name: 'entities_user_name_type_idx', unique: true }),
    );
  });

  it('declares the request ledger status index in the Drizzle schema', () => {
    const indexes = getTableConfig(memoryRequests).indexes.map((index) => index.config);

    expect(indexes).toContainEqual(
      expect.objectContaining({
        name: 'memory_requests_status_updated_at_idx',
        unique: false,
      }),
    );
  });

  it('declares the durable Mem0 import request ledger in the Drizzle schema', () => {
    const config = getTableConfig(mem0ImportRequests);

    expect(mem0ImportRequests.requestId.name).toBe('request_id');
    expect(mem0ImportRequests.requestId.getSQLType()).toBe('text');
    expect(mem0ImportRequests.requestId.primary).toBe(true);
    expect(Object.values(mem0ImportRequests).map((column) => column.name)).toEqual([
      'request_id',
      'entity_type',
      'entity_id',
      'item_json',
      'status',
      'attempt_count',
      'lease_token',
      'publish_token',
      'publish_attempted_at',
      'published_at',
      'error_message',
      'created_at',
      'updated_at',
      'completed_at',
      'cleanup_vector_id',
      'cleanup_vector_generation',
    ]);
    expect(mem0ImportRequests.entityType.notNull).toBe(true);
    expect(mem0ImportRequests.entityId.notNull).toBe(true);
    expect(mem0ImportRequests.itemJson.notNull).toBe(true);
    expect(mem0ImportRequests.status.notNull).toBe(true);
    expect(mem0ImportRequests.errorMessage.notNull).toBe(false);
    expect(mem0ImportRequests.attemptCount.default).toBe(0);
    expect(mem0ImportRequests.leaseToken.default).toBe(0);
    expect(mem0ImportRequests.publishToken.default).toBe(0);
    expect(mem0ImportRequests.publishAttemptedAt.notNull).toBe(false);
    expect(mem0ImportRequests.publishedAt.notNull).toBe(false);
    expect(mem0ImportRequests.createdAt.notNull).toBe(true);
    expect(mem0ImportRequests.updatedAt.notNull).toBe(true);
    expect(mem0ImportRequests.completedAt.notNull).toBe(false);
    expect(mem0ImportRequests.cleanupVectorGeneration.default).toBe(0);
    expect(config.indexes.map((index) => index.config)).toContainEqual(
      expect.objectContaining({
        name: 'mem0_import_requests_status_updated_at_idx',
        unique: false,
      }),
    );
    expect(config.indexes.map((index) => index.config)).toContainEqual(
      expect.objectContaining({
        name: 'mem0_import_requests_dispatch_idx',
        unique: false,
      }),
    );
  });

  it('creates the durable Mem0 import request ledger in migration 0006', () => {
    expect(mem0ImportRequestsMigration).toContain('CREATE TABLE mem0_import_requests (');
    expect(mem0ImportRequestsMigration).toContain('request_id TEXT PRIMARY KEY');
    expect(mem0ImportRequestsMigration).toContain(
      "entity_type TEXT NOT NULL CHECK (entity_type IN ('user', 'agent'))",
    );
    expect(mem0ImportRequestsMigration).toContain('entity_id TEXT NOT NULL');
    expect(mem0ImportRequestsMigration).toContain('item_json TEXT NOT NULL');
    expect(mem0ImportRequestsMigration).toContain(
      "status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed'))",
    );
    expect(mem0ImportRequestsMigration).toContain(
      'attempt_count INTEGER NOT NULL DEFAULT 0',
    );
    expect(mem0ImportRequestsMigration).toContain('lease_token INTEGER NOT NULL DEFAULT 0');
    expect(mem0ImportRequestsMigration).toContain(
      'publish_token INTEGER NOT NULL DEFAULT 0',
    );
    expect(mem0ImportRequestsMigration).toContain('publish_attempted_at INTEGER');
    expect(mem0ImportRequestsMigration).toContain('published_at INTEGER');
    expect(mem0ImportRequestsMigration).toContain('error_message TEXT');
    expect(mem0ImportRequestsMigration).toContain(
      'created_at INTEGER NOT NULL DEFAULT (unixepoch())',
    );
    expect(mem0ImportRequestsMigration).toContain(
      'updated_at INTEGER NOT NULL DEFAULT (unixepoch())',
    );
    expect(mem0ImportRequestsMigration).toContain('completed_at INTEGER');
    expect(mem0ImportRequestsMigration).toContain(
      'CREATE INDEX mem0_import_requests_status_updated_at_idx',
    );
    expect(mem0ImportRequestsMigration).toContain(
      'ON mem0_import_requests (status, updated_at);',
    );
    expect(mem0ImportRequestsMigration).toContain(
      'CREATE INDEX mem0_import_requests_dispatch_idx',
    );
    expect(mem0ImportRequestsMigration).toContain(
      'ON mem0_import_requests (status, published_at, publish_attempted_at);',
    );
  });

  it('declares owner-scoped relationship traversal indexes in the schema and migration', () => {
    const indexes = getTableConfig(relationships).indexes.map((index) => index.config);

    expect(indexes).toContainEqual(expect.objectContaining({
      name: 'relationships_user_source_idx',
      unique: false,
    }));
    expect(indexes).toContainEqual(expect.objectContaining({
      name: 'relationships_user_target_idx',
      unique: false,
    }));
    expect(normalizeLineEndings(reflectGraphIndexesMigration)).toBe(
      'CREATE INDEX relationships_user_source_idx ON relationships (user_id, source_entity_id);\nCREATE INDEX relationships_user_target_idx ON relationships (user_id, target_entity_id);\n',
    );
  });

  it('declares the required named unique indexes and composite link key in the migration', () => {
    expect(initialMigration).toContain(
      'CREATE UNIQUE INDEX api_keys_key_hash_idx ON api_keys (key_hash);',
    );
    expect(initialMigration).toContain(
      'CREATE UNIQUE INDEX entities_user_name_type_idx ON entities (user_id, name, type);',
    );
    expect(initialMigration).toContain('PRIMARY KEY (memory_id, entity_id)');
  });

  it('keeps the idempotency request migration aligned with the Drizzle schema', () => {
    expect(Object.values(memoryRequests).map((column) => column.name)).toEqual([
      'user_id',
      'idempotency_key',
      'agent_id',
      'run_id',
      'status',
      'result_json',
      'error_message',
      'created_at',
      'updated_at',
      'completed_at',
      'lease_token',
      'candidates_json',
      'cleanup_vector_ids_json',
    ]);
    expect(idempotencyRequestsMigration).toContain('CREATE TABLE memory_requests (');
    expect(idempotencyRequestsMigration).toContain('PRIMARY KEY (user_id, idempotency_key)');
    expect(idempotencyRequestsMigration).toContain(
      'CREATE INDEX memory_requests_status_updated_at_idx ON memory_requests (status, updated_at);',
    );
    expect(idempotencyRequestsMigration).toContain(
      "status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed'))",
    );
  });

  it('declares fenced-processing columns with the lease default in the Drizzle schema', () => {
    expect(memoryRequests.leaseToken.name).toBe('lease_token');
    expect(memoryRequests.leaseToken.notNull).toBe(true);
    expect(memoryRequests.leaseToken.default).toBe(0);
    expect(memoryRequests.candidatesJson.name).toBe('candidates_json');
    expect(memoryRequests.candidatesJson.notNull).toBe(false);
    expect(memoryRequests.candidatesJson.default).toBeUndefined();
  });

  it('keeps the lease migration aligned with the Drizzle schema', () => {
    expect(memoryRequestLeasesMigration).toContain(
      'ALTER TABLE memory_requests ADD COLUMN lease_token INTEGER NOT NULL DEFAULT 0;',
    );
    expect(memoryRequestLeasesMigration).toContain(
      'ALTER TABLE memory_requests ADD COLUMN candidates_json TEXT;',
    );
  });

  it('makes memory user ownership nullable for agent-only records', () => {
    expect(memories.userId.notNull).toBe(false);
    expect(agentScopedMemoriesMigration).toContain('PRAGMA defer_foreign_keys = on;');
    expect(agentScopedMemoriesMigration).toContain('user_id TEXT,');
    expect(agentScopedMemoriesMigration).toContain('CREATE TABLE memory_history_rebuild');
    expect(agentScopedMemoriesMigration).toContain('CREATE TABLE relationships_rebuild');
    expect(agentScopedMemoriesMigration).toContain('CREATE TABLE memory_entity_links_rebuild');
  });

  it('prepares nullable deduplication and vector-cleanup columns in migration 0007', () => {
    const migration = normalizeLineEndings(memoryDeduplicationPrepareMigration);

    expect(migration).toContain(
      'ALTER TABLE memories ADD COLUMN content_hash TEXT;',
    );
    expect(migration).toContain(
      'ALTER TABLE memory_requests ADD COLUMN cleanup_vector_ids_json TEXT;',
    );
    expect(migration).toContain(
      'ALTER TABLE mem0_import_requests ADD COLUMN cleanup_vector_id TEXT;',
    );
    expect(migration).toContain(
      'ALTER TABLE mem0_import_requests ADD COLUMN cleanup_vector_generation INTEGER NOT NULL DEFAULT 0;',
    );
    expect(migration).toContain(
      'CREATE INDEX memories_active_user_agent_content_hash_lookup_idx\n  ON memories (user_id, agent_id, content_hash)\n  WHERE deleted_at IS NULL AND user_id IS NOT NULL AND agent_id IS NOT NULL;',
    );
    expect(migration).toContain(
      'CREATE INDEX memories_active_user_content_hash_lookup_idx\n  ON memories (user_id, content_hash)\n  WHERE deleted_at IS NULL AND user_id IS NOT NULL AND agent_id IS NULL;',
    );
    expect(migration).toContain(
      'CREATE INDEX memories_active_agent_content_hash_lookup_idx\n  ON memories (agent_id, content_hash)\n  WHERE deleted_at IS NULL AND user_id IS NULL AND agent_id IS NOT NULL;',
    );
  });

  it('creates a disabled singleton semantic-deduplication setting in migration 0007', () => {
    expect(memoryDeduplicationPrepareMigration).toContain('CREATE TABLE service_settings (');
    expect(memoryDeduplicationPrepareMigration).toContain(
      'id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1)',
    );
    expect(memoryDeduplicationPrepareMigration).toContain(
      'semantic_dedup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (semantic_dedup_enabled IN (0, 1))',
    );
    expect(memoryDeduplicationPrepareMigration).toContain(
      'updated_at INTEGER NOT NULL DEFAULT (unixepoch())',
    );
    expect(memoryDeduplicationPrepareMigration).toContain(
      'INSERT INTO service_settings (id, semantic_dedup_enabled) VALUES (1, 0);',
    );
  });

  it('declares final deduplication fields and service settings in Drizzle', () => {
    expect(memories.contentHash.name).toBe('content_hash');
    expect(memories.contentHash.notNull).toBe(true);
    expect(memoryRequests.cleanupVectorIdsJson.name).toBe('cleanup_vector_ids_json');
    expect(memoryRequests.cleanupVectorIdsJson.notNull).toBe(false);
    expect(mem0ImportRequests.cleanupVectorId.name).toBe('cleanup_vector_id');
    expect(mem0ImportRequests.cleanupVectorId.notNull).toBe(false);
    expect(mem0ImportRequests.cleanupVectorGeneration.name).toBe('cleanup_vector_generation');
    expect(mem0ImportRequests.cleanupVectorGeneration.notNull).toBe(true);

    expect(serviceSettings.id.name).toBe('id');
    expect(serviceSettings.id.primary).toBe(true);
    expect(serviceSettings.semanticDedupEnabled.name).toBe('semantic_dedup_enabled');
    expect(serviceSettings.semanticDedupEnabled.notNull).toBe(true);
    expect(serviceSettings.semanticDedupEnabled.default).toBe(false);
    expect(serviceSettings.updatedAt.name).toBe('updated_at');
    expect(serviceSettings.updatedAt.notNull).toBe(true);
  });

  it('enforces exact active-memory uniqueness in migration 0008 and Drizzle', () => {
    const migration = normalizeLineEndings(memoryDeduplicationEnforceMigration);
    const indexes = getTableConfig(memories).indexes.map((index) => index.config);

    expect(migration).toContain('content_hash TEXT NOT NULL');
    expect(migration).toContain('CREATE TABLE memory_history_rebuild (');
    expect(migration).toContain('CREATE TABLE relationships_rebuild (');
    expect(migration).toContain('CREATE TABLE memory_entity_links_rebuild (');
    expect(migration).not.toContain('memories_active_user_agent_content_hash_lookup_idx');
    expect(migration).not.toContain('memories_active_user_content_hash_lookup_idx');
    expect(migration).not.toContain('memories_active_agent_content_hash_lookup_idx');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX memories_active_user_agent_content_idx\n  ON memories (user_id, agent_id, content_hash, content)\n  WHERE deleted_at IS NULL AND user_id IS NOT NULL AND agent_id IS NOT NULL;',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX memories_active_user_content_idx\n  ON memories (user_id, content_hash, content)\n  WHERE deleted_at IS NULL AND user_id IS NOT NULL AND agent_id IS NULL;',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX memories_active_agent_content_idx\n  ON memories (agent_id, content_hash, content)\n  WHERE deleted_at IS NULL AND user_id IS NULL AND agent_id IS NOT NULL;',
    );
    for (const name of [
      'memories_active_user_agent_content_idx',
      'memories_active_user_content_idx',
      'memories_active_agent_content_idx',
    ]) {
      expect(indexes).toContainEqual(expect.objectContaining({ name, unique: true }));
    }
  });

  it('declares recoverable versioned memory update mutations in migration 0009 and Drizzle', () => {
    expect(memories.mutationVersion.name).toBe('mutation_version');
    expect(memories.mutationVersion.default).toBe(0);
    expect(memories.lastMutationId.name).toBe('last_mutation_id');
    expect(memoryUpdateMutations.mutationId.primary).toBe(true);
    expect(memoryUpdateMutations.memoryId.name).toBe('memory_id');
    expect(memoryUpdateMutations.baseVersion.name).toBe('base_version');
    expect(memoryUpdateMutations.leaseExpiresAt.name).toBe('lease_expires_at');
    expect(memoryUpdateVectorIntents.mutationId.name).toBe('mutation_id');
    expect(memoryUpdateVectorIntents.indexKind.name).toBe('index_kind');
    expect(memoryUpdateMutations.status.notNull).toBe(true);

    const mutationIndexes = getTableConfig(memoryUpdateMutations).indexes.map((index) => index.config);
    expect(mutationIndexes).toContainEqual(expect.objectContaining({
      name: 'memory_update_mutations_dispatch_idx', unique: false,
    }));
    expect(mutationIndexes).toContainEqual(expect.objectContaining({
      name: 'memory_update_mutations_active_memory_idx', unique: true,
    }));

    expect(memoryUpdateMutationsMigration).toContain(
      'ALTER TABLE memories ADD COLUMN mutation_version INTEGER NOT NULL DEFAULT 0;',
    );
    expect(memoryUpdateMutationsMigration).toContain('ALTER TABLE memories ADD COLUMN last_mutation_id TEXT;');
    expect(memoryUpdateMutationsMigration).toContain('CREATE TABLE memory_update_mutations (');
    expect(memoryUpdateMutationsMigration).toContain('CREATE TABLE memory_update_vector_intents (');
    expect(memoryUpdateMutationsMigration).toContain('CREATE UNIQUE INDEX memory_update_mutations_active_memory_idx');
    expect(memoryUpdateMutationsMigration).toContain('CREATE INDEX memory_update_mutations_dispatch_idx');
  });
});
