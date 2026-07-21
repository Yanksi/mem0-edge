import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const createdAt = integer('created_at').notNull().default(sql`(unixepoch())`);
const updatedAt = integer('updated_at').notNull().default(sql`(unixepoch())`);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    scopesJson: text('scopes_json').notNull().default('[]'),
    createdAt,
    expiresAt: integer('expires_at'),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
  },
  (table) => [uniqueIndex('api_keys_key_hash_idx').on(table.keyHash)],
);

export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    userId: text('user_id'),
    agentId: text('agent_id'),
    runId: text('run_id'),
    actorId: text('actor_id'),
    content: text('content').notNull(),
    metadataJson: text('metadata_json').notNull().default('{}'),
    hash: text('hash').notNull(),
    contentHash: text('content_hash').notNull(),
    createdAt,
    updatedAt,
    deletedAt: integer('deleted_at'),
    mutationVersion: integer('mutation_version').notNull().default(0),
    lastMutationId: text('last_mutation_id'),
  },
  (table) => [
    index('memories_user_agent_deleted_at_idx').on(
      table.userId,
      table.agentId,
      table.deletedAt,
    ),
    index('memories_hash_idx').on(table.hash),
    uniqueIndex('memories_active_user_agent_content_idx')
      .on(table.userId, table.agentId, table.contentHash, table.content)
      .where(sql`${table.deletedAt} IS NULL AND ${table.userId} IS NOT NULL AND ${table.agentId} IS NOT NULL`),
    uniqueIndex('memories_active_user_content_idx')
      .on(table.userId, table.contentHash, table.content)
      .where(sql`${table.deletedAt} IS NULL AND ${table.userId} IS NOT NULL AND ${table.agentId} IS NULL`),
    uniqueIndex('memories_active_agent_content_idx')
      .on(table.agentId, table.contentHash, table.content)
      .where(sql`${table.deletedAt} IS NULL AND ${table.userId} IS NULL AND ${table.agentId} IS NOT NULL`),
  ],
);

export const memoryHistory = sqliteTable(
  'memory_history',
  {
    id: text('id').primaryKey(),
    memoryId: text('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    content: text('content').notNull(),
    metadataJson: text('metadata_json').notNull().default('{}'),
    hash: text('hash').notNull(),
    createdAt,
  },
  (table) => [index('memory_history_memory_created_at_idx').on(table.memoryId, table.createdAt)],
);

export const entities = sqliteTable(
  'entities',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex('entities_user_name_type_idx').on(table.userId, table.name, table.type)],
);

export const relationships = sqliteTable(
  'relationships',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    sourceEntityId: text('source_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    targetEntityId: text('target_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    relationType: text('relation_type').notNull(),
    confidence: real('confidence'),
    evidenceMemoryId: text('evidence_memory_id').references(() => memories.id, {
      onDelete: 'set null',
    }),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt,
    updatedAt,
  },
  (table) => [
    index('relationships_user_source_idx').on(table.userId, table.sourceEntityId),
    index('relationships_user_target_idx').on(table.userId, table.targetEntityId),
    index('relationships_source_entity_idx').on(table.sourceEntityId),
    index('relationships_target_entity_idx').on(table.targetEntityId),
    index('relationships_evidence_memory_idx').on(table.evidenceMemoryId),
  ],
);

export const memoryEntityLinks = sqliteTable(
  'memory_entity_links',
  {
    memoryId: text('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.memoryId, table.entityId] }),
    index('memory_entity_links_entity_memory_idx').on(table.entityId, table.memoryId),
  ],
);

export const memoryRequests = sqliteTable(
  'memory_requests',
  {
    userId: text('user_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    agentId: text('agent_id'),
    runId: text('run_id'),
    status: text('status').notNull(),
    resultJson: text('result_json'),
    errorMessage: text('error_message'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
    leaseToken: integer('lease_token').notNull().default(0),
    candidatesJson: text('candidates_json'),
    cleanupVectorIdsJson: text('cleanup_vector_ids_json'),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.idempotencyKey] }),
    index('memory_requests_status_updated_at_idx').on(table.status, table.updatedAt),
  ],
);

export const mem0ImportRequests = sqliteTable(
  'mem0_import_requests',
  {
    requestId: text('request_id').primaryKey(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    itemJson: text('item_json').notNull(),
    status: text('status').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    leaseToken: integer('lease_token').notNull().default(0),
    publishToken: integer('publish_token').notNull().default(0),
    publishAttemptedAt: integer('publish_attempted_at'),
    publishedAt: integer('published_at'),
    errorMessage: text('error_message'),
    createdAt,
    updatedAt,
    completedAt: integer('completed_at'),
    cleanupVectorId: text('cleanup_vector_id'),
    cleanupVectorGeneration: integer('cleanup_vector_generation').notNull().default(0),
  },
  (table) => [
    index('mem0_import_requests_status_updated_at_idx').on(table.status, table.updatedAt),
    index('mem0_import_requests_dispatch_idx').on(
      table.status,
      table.publishedAt,
      table.publishAttemptedAt,
    ),
  ],
);

export const memoryUpdateMutations = sqliteTable(
  'memory_update_mutations',
  {
    mutationId: text('mutation_id').primaryKey(),
    memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    baseVersion: integer('base_version').notNull(),
    targetVersion: integer('target_version').notNull(),
    targetContent: text('target_content').notNull(),
    targetContentHash: text('target_content_hash').notNull(),
    targetMetadataJson: text('target_metadata_json').notNull(),
    graphJson: text('graph_json'),
    status: text('status').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    leaseToken: integer('lease_token').notNull().default(0),
    leaseExpiresAt: integer('lease_expires_at'),
    publishToken: integer('publish_token').notNull().default(0),
    publishAttemptedAt: integer('publish_attempted_at'),
    publishedAt: integer('published_at'),
    errorMessage: text('error_message'),
    createdAt,
    updatedAt,
    completedAt: integer('completed_at'),
  },
  (table) => [
    uniqueIndex('memory_update_mutations_active_memory_idx')
      .on(table.memoryId)
      .where(sql`${table.status} NOT IN ('completed', 'superseded', 'failed_conflict')`),
    index('memory_update_mutations_dispatch_idx').on(
      table.status, table.publishedAt, table.publishAttemptedAt, table.updatedAt,
    ),
  ],
);

export const memoryUpdateVectorIntents = sqliteTable(
  'memory_update_vector_intents',
  {
    mutationId: text('mutation_id').notNull().references(() => memoryUpdateMutations.mutationId, { onDelete: 'cascade' }),
    indexKind: text('index_kind').notNull(),
    vectorId: text('vector_id').notNull(),
    valuesJson: text('values_json').notNull(),
    metadataJson: text('metadata_json').notNull(),
    targetHash: text('target_hash').notNull(),
    status: text('status').notNull().default('pending'),
    updatedAt,
  },
  (table) => [
    primaryKey({ columns: [table.mutationId, table.indexKind, table.vectorId] }),
    index('memory_update_vector_intents_pending_idx').on(
      table.mutationId, table.status, table.indexKind, table.vectorId,
    ),
  ],
);

export const userAliases = sqliteTable(
  'user_aliases',
  {
    userId: text('user_id').primaryKey(),
    alias: text('alias').notNull(),
    createdAt,
    updatedAt,
  },
);

export const serviceSettings = sqliteTable('service_settings', {
  id: integer('id').primaryKey(),
  semanticDedupEnabled: integer('semantic_dedup_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  updatedAt,
});
