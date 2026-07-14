import type { Env } from './env';
import type { AddMemoryRequest } from './memory/types';

export interface ExtractedMemory {
  memory: string;
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

export interface ExtractedEntity { name: string; type?: string; summary?: string }
export interface ExtractedRelationship { source: string; target: string; relation_type: string; confidence?: number }

export class UpstreamServiceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'UpstreamServiceError';
  }
}

const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
const MAX_VECTORIZE_DIMENSIONS = 1536;
const MEMORY_EXTRACTION_INSTRUCTION = 'Extract only durable memories from the transcript. Return a JSON object with this exact shape: {"memories":[{"memory":"string","entities":[{"name":"string","type":"string","summary":"string"}],"relationships":[{"source":"string","target":"string","relation_type":"string","confidence":0.5}]}]}.';

function openAiHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

export async function embedText(env: Env, input: string): Promise<number[]> {
  let response: Response;

  try {
    response = await fetch(`${embeddingBaseUrl(env)}/embeddings`, {
      method: 'POST',
      headers: openAiHeaders(env.OPENAI_API_KEY),
      body: JSON.stringify({ model: env.EMBEDDING_MODEL, input }),
    });
  } catch (error) {
    throw new Error(`OpenAI embeddings request failed: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    throw new UpstreamServiceError(`OpenAI embeddings request failed (${response.status} ${response.statusText})`, response.status);
  }

  const payload = await responseJson<{ data?: Array<{ embedding?: unknown }> }>(
    response,
    'OpenAI embeddings response contained invalid JSON',
  );
  const embedding = payload.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === 'number')) {
    throw new Error('OpenAI embeddings response did not contain an embedding');
  }
  if (embedding.length > MAX_VECTORIZE_DIMENSIONS) {
    throw new Error(`Cloudflare Vectorize supports at most ${MAX_VECTORIZE_DIMENSIONS} embedding dimensions`);
  }

  return embedding;
}

export async function extractMemories(env: Env, request: AddMemoryRequest): Promise<ExtractedMemory[]> {
  const transcript = request.messages.map(({ role, content }) => `${role}: ${content}`).join('\n');
  let response: Response;

  try {
    response = await fetch(`${extractionBaseUrl(env)}/chat/completions`, {
      method: 'POST',
      headers: openAiHeaders(env.OPENAI_API_KEY),
      body: JSON.stringify({
        model: env.LLM_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: MEMORY_EXTRACTION_INSTRUCTION },
          { role: 'user', content: transcript },
        ],
      }),
    });
  } catch (error) {
    throw new Error(`OpenAI memory extraction request failed: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    throw new UpstreamServiceError(`OpenAI memory extraction request failed (${response.status} ${response.statusText})`, response.status);
  }

  const payload = await responseJson<{ choices?: Array<{ message?: { content?: unknown } }> }>(
    response,
    'OpenAI memory extraction response contained invalid JSON',
  );
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('OpenAI memory extraction response did not contain message content');
  }

  let extracted: unknown;
  try {
    extracted = JSON.parse(content);
  } catch {
    throw new Error('OpenAI memory extraction response contained invalid JSON');
  }

  if (!hasMemories(extracted)) {
    throw new Error('OpenAI memory extraction response did not contain memories');
  }

  return extracted.memories.map((memory) => {
    if (!isExtractedMemory(memory)) {
      throw new Error('OpenAI memory extraction response contained an invalid memory');
    }

    return {
      memory: memory.memory,
      entities: memory.entities,
      relationships: memory.relationships,
    };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractionBaseUrl(env: Env): string {
  return normalizeBaseUrl(env.LLM_API_BASE_URL || DEFAULT_OPENAI_API_BASE_URL);
}

function embeddingBaseUrl(env: Env): string {
  return normalizeBaseUrl(env.EMBEDDING_API_BASE_URL || DEFAULT_OPENAI_API_BASE_URL);
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

async function responseJson<T>(response: Response, message: string): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new Error(message);
  }
}

function hasMemories(value: unknown): value is { memories: unknown[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { memories?: unknown }).memories);
}

function isExtractedMemory(value: unknown): value is ExtractedMemory {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const memory = value as Partial<ExtractedMemory>;
  return typeof memory.memory === 'string'
    && Array.isArray(memory.entities) && memory.entities.every(isExtractedEntity)
    && Array.isArray(memory.relationships) && memory.relationships.every(isExtractedRelationship);
}

function isExtractedEntity(value: unknown): value is ExtractedEntity {
  if (typeof value !== 'object' || value === null) return false;
  const entity = value as Partial<ExtractedEntity>;
  return typeof entity.name === 'string'
    && (entity.type === undefined || typeof entity.type === 'string')
    && (entity.summary === undefined || typeof entity.summary === 'string');
}

function isExtractedRelationship(value: unknown): value is ExtractedRelationship {
  if (typeof value !== 'object' || value === null) return false;
  const relationship = value as Partial<ExtractedRelationship>;
  return typeof relationship.source === 'string'
    && typeof relationship.target === 'string'
    && typeof relationship.relation_type === 'string'
    && (relationship.confidence === undefined || typeof relationship.confidence === 'number');
}
