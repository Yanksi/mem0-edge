import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import {
  GraphModelResponseSchema,
  ReflectCandidateEvidenceSchema,
  ReflectRequestSchema,
} from '../src/reflect/types';
import {
  embedText,
  extractMemories,
  GraphLlmConfigurationError,
  reflectWithGraphModel,
  UpstreamServiceError,
} from '../src/llm';

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

describe('reflectWithGraphModel', () => {
  const input = {
    query: 'Who manages Ada?',
    evidence: [{
      id: 'memory-1',
      memory: 'Ada works with Benoit.',
      role: 'semantic_seed' as const,
    }],
  };

  const graphEnv = {
    ...env,
    GRAPH_LLM_API_BASE_URL: 'https://graph.example/v1/',
    GRAPH_LLM_MODEL: 'graph-reasoner',
    GRAPH_LLM_API_KEY: 'graph-key',
  };

  it('uses only configured graph credentials, model, endpoint, and default low reasoning', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          answer: 'The supplied evidence does not say who manages Ada.',
          uncertainty: 'high',
          evidence_ids: ['memory-1'],
        }) } }],
      }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(reflectWithGraphModel(graphEnv, input)).resolves.toEqual({
      answer: 'The supplied evidence does not say who manages Ada.',
      uncertainty: 'high',
      evidence_ids: ['memory-1'],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.example/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer graph-key', 'Content-Type': 'application/json' },
        signal: expect.any(AbortSignal),
        body: expect.stringContaining('"model":"graph-reasoner"'),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: 'graph-reasoner',
      response_format: { type: 'json_object' },
      reasoning_effort: 'low',
    });
    expect(fetchMock.mock.calls[0][1].body).toContain('untrusted evidence');
    expect(fetchMock.mock.calls[0][1].body).toContain('memory-1');
  });

  it('uses the configured graph thinking level', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: 'Benoit is connected to Ada.', uncertainty: 'medium', evidence_ids: ['memory-1'],
      }) } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await reflectWithGraphModel({ ...graphEnv, GRAPH_LLM_THINKING_LEVEL: 'high' }, input);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ reasoning_effort: 'high' });
  });

  it.each([
    ['GRAPH_LLM_API_BASE_URL', { ...graphEnv, GRAPH_LLM_API_BASE_URL: undefined }],
    ['GRAPH_LLM_MODEL', { ...graphEnv, GRAPH_LLM_MODEL: undefined }],
    ['GRAPH_LLM_API_KEY', { ...graphEnv, GRAPH_LLM_API_KEY: undefined }],
    ['GRAPH_LLM_THINKING_LEVEL', { ...graphEnv, GRAPH_LLM_THINKING_LEVEL: 'max' }],
  ])('rejects missing or invalid %s configuration', async (_field, invalidEnv) => {
    await expect(reflectWithGraphModel(invalidEnv, input)).rejects.toBeInstanceOf(GraphLlmConfigurationError);
  });

  it('retains upstream status errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('unavailable', { status: 503, statusText: 'Service Unavailable' }),
    ));

    await expect(reflectWithGraphModel(graphEnv, input)).rejects.toMatchObject({
      name: 'UpstreamServiceError', status: 503,
    } satisfies Partial<UpstreamServiceError>);
  });

  it('rejects invalid graph response uncertainty values', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: 'Ada is managed by Benoit.', uncertainty: 'certain', evidence_ids: ['memory-1'],
      }) } }] }), { status: 200 }),
    ));

    await expect(reflectWithGraphModel(graphEnv, input)).rejects.toThrow();
  });

  it('rejects malformed outer API response JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })));

    await expect(reflectWithGraphModel(graphEnv, input)).rejects.toThrow(
      'Graph LLM reflection response contained invalid JSON',
    );
  });

  it('rejects an API response without message content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 }),
    ));

    await expect(reflectWithGraphModel(graphEnv, input)).rejects.toThrow(
      'Graph LLM reflection response did not contain message content',
    );
  });

  it('rejects invalid JSON in message content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 }),
    ));

    await expect(reflectWithGraphModel(graphEnv, input)).rejects.toThrow(
      'Graph LLM reflection response contained invalid JSON',
    );
  });

  it('rejects a model JSON result missing required fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answer: 'Benoit manages Ada.', uncertainty: 'low',
      }) } }] }), { status: 200 }),
    ));

    await expect(reflectWithGraphModel(graphEnv, input)).rejects.toThrow(
      'Graph LLM reflection response contained an invalid result',
    );
  });
});

describe('graph reflection schemas', () => {
  it('requires a nonempty query of at most 4000 characters and both identity fields', () => {
    expect(ReflectRequestSchema.safeParse({
      query: 'What connects Ada and Chandra?', user_id: 'user-1', agent_id: 'agent-1',
    }).success).toBe(true);
    expect(ReflectRequestSchema.safeParse({ query: '', user_id: 'user-1', agent_id: 'agent-1' }).success).toBe(false);
    expect(ReflectRequestSchema.safeParse({
      query: 'x'.repeat(4001), user_id: 'user-1', agent_id: 'agent-1',
    }).success).toBe(false);
    expect(ReflectRequestSchema.safeParse({ query: 'Question', agent_id: 'agent-1' }).success).toBe(false);
    expect(ReflectRequestSchema.safeParse({ query: 'Question', user_id: 'user-1' }).success).toBe(false);
  });

  it('accepts only supported candidate evidence roles', () => {
    expect(ReflectCandidateEvidenceSchema.safeParse({
      id: 'memory-1', memory: 'Ada works with Benoit.', role: 'semantic_seed',
    }).success).toBe(true);
    expect(ReflectCandidateEvidenceSchema.safeParse({
      id: 'memory-1', memory: 'Ada works with Benoit.', role: 'unsupported_role',
    }).success).toBe(false);
  });

  it('validates optional limitations and limits selected evidence IDs to twenty', () => {
    expect(GraphModelResponseSchema.safeParse({
      answer: 'Benoit works with Ada.', uncertainty: 'medium', evidence_ids: ['memory-1'], limitations: 'No manager evidence.',
    }).success).toBe(true);
    expect(GraphModelResponseSchema.safeParse({
      answer: 'Benoit works with Ada.', uncertainty: 'medium', evidence_ids: ['memory-1'], limitations: '',
    }).success).toBe(false);
    expect(GraphModelResponseSchema.safeParse({
      answer: 'Benoit works with Ada.', uncertainty: 'medium', evidence_ids: Array.from({ length: 21 }, (_, index) => `memory-${index}`),
    }).success).toBe(false);
  });
});
