import type { RawMemoryMigrationItem } from './import/types';

export interface ExtractMemoryJob {
  type: 'extract-and-store';
  requestId: string;
  body: unknown;
}

export interface Mem0ImportJob {
  type: 'import-mem0-memory';
  requestId: string;
  entityType?: 'user' | 'agent';
  entityId?: string;
  // Kept while jobs queued by pre-entity deployments drain safely.
  userId?: string;
  item: RawMemoryMigrationItem;
  body?: never;
}

export interface ReclassifyMem0AgentJob {
  type: 'reclassify-mem0-agent';
  id: string;
  sourceUserId: string;
  agentId: string;
  content: string;
  metadataJson: string;
}

export type MemoryJob = ExtractMemoryJob | Mem0ImportJob | ReclassifyMem0AgentJob;

export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  ENTITY_VECTORIZE: VectorizeIndex;
  MEMORY_JOBS: Queue<MemoryJob>;
  OPENAI_API_KEY: string;
  MEM0_API_KEY: string;
  DASHBOARD_PASSWORD: string;
  DASHBOARD_READ_ONLY?: string;
  EMBEDDING_MODEL: string;
  LLM_MODEL: string;
  LLM_API_BASE_URL?: string;
  EMBEDDING_API_BASE_URL?: string;
  GRAPH_LLM_API_BASE_URL?: string;
  GRAPH_LLM_MODEL?: string;
  GRAPH_LLM_API_KEY?: string;
  GRAPH_LLM_THINKING_LEVEL?: string;
  VECTOR_DIMENSIONS: string;
  MEM0_INDEX_NAME: string;
}
