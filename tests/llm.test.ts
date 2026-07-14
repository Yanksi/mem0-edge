import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { embedText, extractMemories, UpstreamServiceError } from '../src/llm';

const env = {
  OPENAI_API_KEY: 'openai-key',
  EMBEDDING_MODEL: 'text-embedding-3-small',
  LLM_MODEL: 'gpt-4.1-mini',
} as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('embedText', () => {
  it('posts the configured embedding model and returns the first embedding', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(embedText(env, 'Remember the launch date.')).resolves.toEqual([0.1, 0.2]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer openai-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: 'Remember the launch date.' }),
      }),
    );
  });

  it('uses the dedicated embedding endpoint when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await embedText({ ...env, LLM_API_BASE_URL: 'https://extract.example/v1', EMBEDDING_API_BASE_URL: 'https://embed.example/v1/' }, 'text');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://embed.example/v1/embeddings',
      expect.anything(),
    );
  });

  it('does not inherit the extraction endpoint when the embedding endpoint is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await embedText({ ...env, LLM_API_BASE_URL: 'https://extract.example/v1' }, 'text');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/embeddings',
      expect.anything(),
    );
  });

  it('throws descriptive errors for failed embedding responses, malformed JSON, and missing embeddings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('rate limited', { status: 429, statusText: 'Too Many Requests' })));
    await expect(embedText(env, 'text')).rejects.toThrow('OpenAI embeddings request failed (429 Too Many Requests)');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('unauthorized', { status: 401, statusText: 'Unauthorized' })));
    await expect(embedText(env, 'text')).rejects.toMatchObject({
      name: 'UpstreamServiceError', status: 401,
    } satisfies Partial<UpstreamServiceError>);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('not json', { status: 200 })));
    await expect(embedText(env, 'text')).rejects.toThrow('OpenAI embeddings response contained invalid JSON');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 })));
    await expect(embedText(env, 'text')).rejects.toThrow('OpenAI embeddings response did not contain an embedding');
  });

  it('rejects embeddings that exceed the Cloudflare Vectorize dimension limit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 1537 }, () => 0.1) }] }), { status: 200 }),
    ));

    await expect(embedText(env, 'text')).rejects.toThrow('Cloudflare Vectorize supports at most 1536 embedding dimensions');
  });
});

describe('extractMemories', () => {
  const request = {
    user_id: 'user-123',
    metadata: {},
    infer: true,
    async: false,
    messages: [
      { role: 'user' as const, content: 'I live in Zurich.' },
      { role: 'assistant' as const, content: 'Noted.' },
    ],
  };

  it('posts a durable-memory JSON instruction with the transcript and returns extracted memories', async () => {
    const memories = [{
      memory: 'User lives in Zurich.',
      entities: [{ name: 'Zurich', type: 'city' }],
      relationships: [{ source: 'User', target: 'Zurich', relation_type: 'lives_in', confidence: 0.9 }],
    }];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ memories }) } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(extractMemories(env, request)).resolves.toEqual(memories);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer openai-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4.1-mini',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'Extract only durable memories from the transcript. Return a JSON object with this exact shape: {"memories":[{"memory":"string","entities":[{"name":"string","type":"string","summary":"string"}],"relationships":[{"source":"string","target":"string","relation_type":"string","confidence":0.5}]}]}.',
            },
            { role: 'user', content: 'user: I live in Zurich.\nassistant: Noted.' },
          ],
        }),
      }),
    );
  });

  it('uses the extraction endpoint when no embedding endpoint is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ memories: [] }) } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(extractMemories({ ...env, LLM_API_BASE_URL: 'https://extract.example/v1/' }, request)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://extract.example/v1/chat/completions',
      expect.anything(),
    );
  });

  it('rejects relationships that do not use relation_type', async () => {
    const memories = [{
      memory: 'User lives in Zurich.',
      entities: [],
      relationships: [{ source: 'User', target: 'Zurich', relationship: 'lives_in' }],
    }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ memories }) } }] }), { status: 200 }),
    ));

    await expect(extractMemories(env, request)).rejects.toThrow('OpenAI memory extraction response contained an invalid memory');
  });

  it('throws descriptive errors for transport, status, malformed response JSON, missing content, and invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network unavailable')));
    await expect(extractMemories(env, request)).rejects.toThrow('OpenAI memory extraction request failed: network unavailable');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' })));
    await expect(extractMemories(env, request)).rejects.toThrow('OpenAI memory extraction request failed (502 Bad Gateway)');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('not json', { status: 200 })));
    await expect(extractMemories(env, request)).rejects.toThrow('OpenAI memory extraction response contained invalid JSON');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 })));
    await expect(extractMemories(env, request)).rejects.toThrow('OpenAI memory extraction response did not contain message content');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 })));
    await expect(extractMemories(env, request)).rejects.toThrow('OpenAI memory extraction response contained invalid JSON');
  });
});
