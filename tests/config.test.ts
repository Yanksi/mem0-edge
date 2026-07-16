import { describe, expect, it } from 'vitest';
// Vite supplies raw assets at test runtime; this project does not include Vite's ambient declarations.
// @ts-expect-error Raw asset module declarations are intentionally absent from tsconfig.
import devVarsExample from '../.dev.vars.example?raw';
// @ts-expect-error Raw asset module declarations are intentionally absent from tsconfig.
import readme from '../README.md?raw';
// @ts-expect-error Raw asset module declarations are intentionally absent from tsconfig.
import wranglerConfig from '../wrangler.toml?raw';
// @ts-expect-error Raw asset module declarations are intentionally absent from tsconfig.
import remotePreviewConfig from '../wrangler.remote-preview.toml?raw';

const dedupDefaults = {
  DEDUP_LLM_API_BASE_URL: 'https://openrouter.ai/api/v1',
  DEDUP_LLM_MODEL: 'openai/gpt-4o-mini',
  DEDUP_SIMILARITY_THRESHOLD: '0.85',
  DEDUP_CANDIDATE_LIMIT: '8',
};

function parseVars(source: string): Record<string, string> {
  const header = source.search(/^\[vars\]\s*$/m);
  if (header < 0) throw new Error('Wrangler configuration does not contain [vars]');

  const bodyStart = source.indexOf('\n', header) + 1;
  const remainder = source.slice(bodyStart);
  const nextHeader = remainder.search(/^\s*\[/m);
  const body = nextHeader < 0 ? remainder : remainder.slice(0, nextHeader);

  return Object.fromEntries(body
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
    .map((line) => {
      const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"\s*(?:#.*)?$/);
      if (match === null) throw new Error(`Unsupported Wrangler variable: ${line}`);
      return [match[1], match[2]];
    }));
}

describe.each([
  ['production', wranglerConfig],
  ['remote preview', remotePreviewConfig],
])('%s Wrangler configuration', (_name, config) => {
  it('declares the semantic deduplication plaintext defaults', () => {
    const variables = parseVars(config);

    expect(Object.keys(variables).filter((name) => name.startsWith('DEDUP_')).sort()).toEqual(
      Object.keys(dedupDefaults).sort(),
    );
    for (const [name, value] of Object.entries(dedupDefaults)) {
      expect(variables[name], name).toBe(value);
    }
  });

  it('does not declare any API key secret in plaintext vars', () => {
    const variableNames = Object.keys(parseVars(config));

    expect(variableNames.filter((name) => name.endsWith('_API_KEY'))).toEqual([]);
    for (const secretName of [
      'LLM_API_KEY',
      'EMBEDDING_API_KEY',
      'GRAPH_LLM_API_KEY',
      'DEDUP_LLM_API_KEY',
      'OPENAI_API_KEY',
    ]) {
      expect(variableNames).not.toContain(secretName);
    }
  });
});

describe('local secret template', () => {
  it('declares independent model credentials without a shared fallback', () => {
    const keys = devVarsExample
      .split(/\r?\n/)
      .filter((line: string) => line.trim() !== '' && !line.trimStart().startsWith('#'))
      .map((line: string) => line.split('=', 1)[0]);

    expect(keys).toEqual([
      'LLM_API_KEY',
      'EMBEDDING_API_KEY',
      'GRAPH_LLM_API_KEY',
      'DEDUP_LLM_API_KEY',
      'MEM0_API_KEY',
      'DASHBOARD_PASSWORD',
    ]);
    expect(devVarsExample).not.toContain('OPENAI_API_KEY');
  });
});

describe('semantic deduplication documentation', () => {
  it('describes the guided deployment flow without promising resource provisioning', () => {
    expect(readme).toContain("The Deploy button opens Cloudflare's guided deployment and fork flow.");
    expect(readme).toContain('Operators must still create or select the required D1, Vectorize, Queue, and DLQ resources');
    expect(readme).not.toContain("Cloudflare's deploy button provisions the declared D1, Vectorize, and Queue bindings");
  });

  it('describes the checked-in D1 binding without treating it as a placeholder', () => {
    expect(readme).toContain('contains the current deployment\'s concrete D1 binding as a reference configuration');
    expect(readme).toContain('ensure `database_id` points to a D1 database in their own Cloudflare account');
    expect(readme).toContain('keep the valid checked-in binding when it already names the intended database');
    expect(readme).not.toMatch(/all-zero D1/i);
  });

  it('documents both supported API-key headers for protected routes', () => {
    expect(readme).toContain('Protected memory and graph routes accept either `Authorization: Bearer <MEM0_API_KEY>` or `X-API-Key: <MEM0_API_KEY>`.');
    expect(readme).toContain('The `/health` endpoint is public.');
    expect(readme).not.toContain('All `/v1/*` routes require');
  });

  it('keeps repository and write-time behavior accurate', () => {
    expect(readme).toContain('https://github.com/Yanksi/mem-worker');
    expect(readme).toContain('Exact write-time deduplication is always enabled.');
    expect(readme).toContain('full (`user_id`, `agent_id`) scope, including every null/value combination');
    expect(readme).toContain('raw memory text after the hash lookup, guarding against hash collisions');
    expect(readme).toContain('Semantic write-time deduplication defaults to **off**.');
    expect(readme).toContain('Dashboard > System settings');
    expect(readme).toContain('Only new writes are checked semantically');
    expect(readme).toContain('existing memories are not semantically consolidated');
  });

  it('documents semantic decisions and concurrency limits', () => {
    for (const statement of [
      'Contradictions, temporal or state changes, material additions, subsets, supersets, and uncertain matches remain distinct memories.',
      'A duplicate paraphrase discards the new write and leaves the older canonical memory unchanged.',
      'Simultaneous paraphrased writes are not serialized, so both writes can survive.',
    ]) {
      expect(readme).toContain(statement);
    }
  });

  it('documents four independent model paths and the Dashboard boundary', () => {
    for (const key of [
      '`LLM_API_KEY`',
      '`EMBEDDING_API_KEY`',
      '`GRAPH_LLM_API_KEY`',
      '`DEDUP_LLM_API_KEY`',
    ]) {
      expect(readme).toContain(key);
    }
    expect(readme).toContain('never falls back to another model path\'s key');
    expect(readme).toContain('Structured-output adaptation for semantic deduplication is currently OpenRouter-only.');
    expect(readme).toContain('The Dashboard API and UI expose only the on/off setting; they do not expose the deduplication key, endpoint, or model.');
    expect(readme).toContain('npx wrangler secret put DEDUP_LLM_API_KEY');
  });

  it('documents plaintext deduplication defaults', () => {
    expect(readme).toContain('| `DEDUP_LLM_API_BASE_URL` | `https://openrouter.ai/api/v1` |');
    expect(readme).toContain('| `DEDUP_LLM_MODEL` | `openai/gpt-4o-mini` |');
    expect(readme).toContain('| `DEDUP_SIMILARITY_THRESHOLD` | `0.85` |');
    expect(readme).toContain('| `DEDUP_CANDIDATE_LIMIT` | `8` |');
    expect(readme).toContain('The endpoint, model, similarity threshold, and candidate limit are plaintext Worker variables.');
  });

  it('documents Vectorize metadata and dimension constraints', () => {
    expect(readme).toContain('npx wrangler vectorize create-metadata-index mem0-edge --property-name=scope_key --type=string');
    expect(readme).toContain('Create the string `scope_key` metadata index before maintenance reindex/backfill.');
    expect(readme).toContain('Cloudflare Vectorize supports at most 1,536 dimensions.');
    expect(readme).toContain('embedding output, Vectorize index, and `VECTOR_DIMENSIONS` configuration must match');
    expect(readme).toContain('Vectorize dimensions are immutable; changing dimensions requires recreating the indexes.');
  });

  it('documents the maintenance commands and security boundary', () => {
    for (const command of [
      'npm run maintenance:dedup -- inspect',
      'npm run maintenance:dedup -- apply --confirm',
      'npm run maintenance:dedup -- verify',
      'node --env-file=.env scripts/migrate-memory-deduplication.mjs inspect',
      'node --env-file=.env scripts/migrate-memory-deduplication.mjs apply --confirm',
      'node --env-file=.env scripts/migrate-memory-deduplication.mjs verify',
    ]) {
      expect(readme).toContain(command);
    }
    expect(readme).toContain('Inspection backups contain memory contents and must be protected as sensitive data');
  });

  it('requires production verification between migration phases', () => {
    const deploy0007 = readme.indexOf('Deploy the application code and apply migration `0007_memory_deduplication_prepare.sql` only.');
    const inspect = readme.indexOf('Run `inspect` and review its report and backup.');
    const pause = readme.indexOf('Pause writers and drain the queue according to your operator workflow.');
    const apply = readme.indexOf('Run `apply --confirm`.');
    const verify = readme.indexOf('Run `verify` and confirm that it succeeds in production.');
    const create0008 = readme.indexOf('Only after successful production verification, create and apply migration `0008`');

    expect([deploy0007, inspect, pause, apply, verify, create0008].every((index) => index >= 0)).toBe(true);
    expect(deploy0007).toBeLessThan(inspect);
    expect(inspect).toBeLessThan(pause);
    expect(pause).toBeLessThan(apply);
    expect(apply).toBeLessThan(verify);
    expect(verify).toBeLessThan(create0008);
  });

  it('does not describe the removed manual cleanup control or API', () => {
    expect(readme).not.toContain('Deduplicate memories');
    expect(readme).not.toMatch(/\/dashboard\/api\/[^\s`]*dedup/i);
    expect(readme).not.toMatch(/manual(?:ly)?\s+(?:semantic\s+)?dedup/i);
  });
});
