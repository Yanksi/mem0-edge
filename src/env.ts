import type { RawMemoryMigrationItem } from './import/types';

export interface ExtractMemoryJob {
  type: 'extract-and-store';
  requestId: string;
  body: unknown;
}

export interface Mem0ImportJob {
  type: 'import-mem0-memory';
  requestId: string;
  userId: string;
  item: RawMemoryMigrationItem;
  body?: never;
}

export type MemoryJob = ExtractMemoryJob | Mem0ImportJob;

export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  MEMORY_JOBS: Queue<MemoryJob>;
  OPENAI_API_KEY: string;
  MEM0_API_KEY: string;
  DASHBOARD_PASSWORD: string;
  EMBEDDING_MODEL: string;
  LLM_MODEL: string;
  LLM_API_BASE_URL?: string;
  EMBEDDING_API_BASE_URL?: string;
  VECTOR_DIMENSIONS: string;
  MEM0_INDEX_NAME: string;
}
