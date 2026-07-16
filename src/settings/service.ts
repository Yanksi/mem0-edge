import type { Env } from '../env';

export interface RetryableDedupLlmError {
  readonly retryable: true;
}

export class DedupLlmConfigurationError extends Error implements RetryableDedupLlmError {
  readonly retryable: true = true;
  readonly missingVariables: readonly string[];

  constructor(missingVariables: readonly string[]) {
    super(`Missing semantic deduplication configuration: ${missingVariables.join(', ')}`);
    this.name = 'DedupLlmConfigurationError';
    this.missingVariables = missingVariables;
  }
}

export function assertDedupLlmConfigured(env: Env): void {
  const configuration: Array<readonly [string, string | undefined]> = [
    ['DEDUP_LLM_API_BASE_URL', env.DEDUP_LLM_API_BASE_URL],
    ['DEDUP_LLM_MODEL', env.DEDUP_LLM_MODEL],
    ['DEDUP_LLM_API_KEY', env.DEDUP_LLM_API_KEY],
  ];
  const missingVariables = configuration
    .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
    .map(([name]) => name);

  if (missingVariables.length > 0) {
    throw new DedupLlmConfigurationError(missingVariables);
  }
}

export async function getSemanticDedupEnabled(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT semantic_dedup_enabled FROM service_settings WHERE id = 1',
  ).first<{ semantic_dedup_enabled: number }>();

  return row?.semantic_dedup_enabled === 1;
}

export async function setSemanticDedupEnabled(env: Env, enabled: boolean): Promise<void> {
  if (enabled) {
    assertDedupLlmConfigured(env);
  }

  await env.DB.prepare(`
    INSERT INTO service_settings (id, semantic_dedup_enabled, updated_at)
    VALUES (1, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      semantic_dedup_enabled = excluded.semantic_dedup_enabled,
      updated_at = excluded.updated_at
  `).bind(enabled ? 1 : 0).run();
}
