/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as workerEnv, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import {
  DedupLlmConfigurationError,
  getSemanticDedupEnabled,
  setSemanticDedupEnabled,
} from '../src/settings/service';

const env = workerEnv as unknown as Env;
const configuredEnv = {
  ...env,
  DEDUP_LLM_API_BASE_URL: 'https://dedup.example/v1',
  DEDUP_LLM_MODEL: 'dedup-model',
  DEDUP_LLM_API_KEY: 'dedup-secret',
} as Env;

beforeEach(async () => {
  await env.DB.prepare(`
    CREATE TABLE service_settings (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      semantic_dedup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (semantic_dedup_enabled IN (0, 1)),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `).run();
  await env.DB.prepare(
    'INSERT INTO service_settings (id, semantic_dedup_enabled) VALUES (1, 0)',
  ).run();
});

afterEach(async () => {
  await reset();
});

describe('semantic deduplication setting', () => {
  it('reads the singleton default as disabled', async () => {
    await expect(getSemanticDedupEnabled(env)).resolves.toBe(false);
  });

  it('returns disabled when the singleton row is missing', async () => {
    await env.DB.prepare('DELETE FROM service_settings WHERE id = 1').run();

    await expect(getSemanticDedupEnabled(env)).resolves.toBe(false);
  });

  it('persists numeric 1 when enabled with dedicated LLM configuration', async () => {
    await expect(setSemanticDedupEnabled(configuredEnv, true)).resolves.toBeUndefined();

    await expect(env.DB.prepare(
      'SELECT semantic_dedup_enabled FROM service_settings WHERE id = 1',
    ).first()).resolves.toEqual({ semantic_dedup_enabled: 1 });
  });

  it('reads enabled after enabling and persists numeric 0 after disabling', async () => {
    await setSemanticDedupEnabled(configuredEnv, true);

    await expect(getSemanticDedupEnabled(env)).resolves.toBe(true);

    await setSemanticDedupEnabled(env, false);

    await expect(env.DB.prepare(
      'SELECT semantic_dedup_enabled FROM service_settings WHERE id = 1',
    ).first()).resolves.toEqual({ semantic_dedup_enabled: 0 });
    await expect(getSemanticDedupEnabled(env)).resolves.toBe(false);
  });

  it.each([
    ['DEDUP_LLM_API_BASE_URL', undefined],
    ['DEDUP_LLM_API_BASE_URL', ''],
    ['DEDUP_LLM_API_BASE_URL', '   '],
    ['DEDUP_LLM_MODEL', undefined],
    ['DEDUP_LLM_MODEL', ''],
    ['DEDUP_LLM_MODEL', '\t\n'],
    ['DEDUP_LLM_API_KEY', undefined],
    ['DEDUP_LLM_API_KEY', ''],
    ['DEDUP_LLM_API_KEY', ' \t '],
  ] as const)('rejects enabling when %s is %j', async (name, value) => {
    await expect(setSemanticDedupEnabled({
      ...configuredEnv,
      [name]: value,
    }, true)).rejects.toThrow(name);

    await expect(getSemanticDedupEnabled(env)).resolves.toBe(false);
  });

  it('does not require dedicated LLM configuration when disabling', async () => {
    await expect(setSemanticDedupEnabled({
      ...configuredEnv,
      DEDUP_LLM_API_BASE_URL: undefined,
      DEDUP_LLM_MODEL: undefined,
      DEDUP_LLM_API_KEY: undefined,
    }, false)).resolves.toBeUndefined();
  });

  it('retains missing variable names in the configuration error for server logs', async () => {
    const result = setSemanticDedupEnabled({
      ...configuredEnv,
      DEDUP_LLM_API_BASE_URL: ' ',
      DEDUP_LLM_MODEL: undefined,
      DEDUP_LLM_API_KEY: '',
    }, true);

    await expect(result).rejects.toBeInstanceOf(DedupLlmConfigurationError);
    await expect(result).rejects.toMatchObject({
      name: 'DedupLlmConfigurationError',
      missingVariables: [
        'DEDUP_LLM_API_BASE_URL',
        'DEDUP_LLM_MODEL',
        'DEDUP_LLM_API_KEY',
      ],
    });
    await expect(result).rejects.toThrow(
      'Missing semantic deduplication configuration: DEDUP_LLM_API_BASE_URL, DEDUP_LLM_MODEL, DEDUP_LLM_API_KEY',
    );
    await expect(result).rejects.not.toThrow('dedup-secret');
  });
});
