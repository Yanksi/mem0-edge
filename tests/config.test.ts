import { describe, expect, it } from 'vitest';
// Vite supplies raw assets at test runtime; this project does not include Vite's ambient declarations.
// @ts-expect-error Raw asset module declarations are intentionally absent from tsconfig.
import devVarsExample from '../.dev.vars.example?raw';
// @ts-expect-error Raw asset module declarations are intentionally absent from tsconfig.
import implementationPlan from '../docs/superpowers/plans/2026-07-15-write-time-memory-deduplication.md?raw';
// @ts-expect-error Raw asset module declarations are intentionally absent from tsconfig.
import packageJsonSource from '../package.json?raw';
// @ts-expect-error Raw asset module declarations are intentionally absent from tsconfig.
import readme from '../README.md?raw';
// @ts-expect-error Raw asset module declarations are intentionally absent from tsconfig.
import wranglerConfig from '../wrangler.toml?raw';
// @ts-expect-error Raw asset module declarations are intentionally absent from tsconfig.
import remotePreviewConfig from '../wrangler.remote-preview.toml?raw';

// @ts-expect-error Vite supplies import.meta.glob at test runtime.
const migrationFiles = Object.keys(import.meta.glob('../src/migrations/*.sql'));
const packageJson = JSON.parse(packageJsonSource) as { scripts: Record<string, string> };

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
  it('describes automatic supported-resource provisioning and manual operator duties', () => {
    expect(readme).toContain("The Deploy button opens Cloudflare's guided deployment and fork flow.");
    expect(readme).toContain('Cloudflare can automatically provision supported D1, Vectorize, Queue, and DLQ resources.');
    expect(readme).toContain('Operators must verify every resulting binding targets the intended resource.');
    expect(readme).toContain('The manual commands below are an alternative');
    expect(readme).toContain('D1 migrations, Vectorize metadata indexes, and secrets remain manual.');
    expect(readme).not.toContain('Operators must still create or select the required D1, Vectorize, Queue, and DLQ resources');
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
    expect(readme).toContain('Phase-one exact matching runs on every write, but it is race-prone before migration `0008`');
    expect(readme).toContain('Concurrency-safe exact uniqueness begins only after production verification succeeds and the reviewed migration `0008` is created and applied.');
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

  it('uses the D1 binding name for migration commands', () => {
    expect(readme).toContain('npx wrangler d1 migrations apply DB --remote');
    expect(implementationPlan).toContain('npx.cmd wrangler d1 migrations apply DB --remote');
    expect(readme).not.toContain('npx wrangler d1 migrations apply mem0-edge --remote');
    expect(implementationPlan).not.toContain('npx.cmd wrangler d1 migrations apply mem0-edge --remote');
  });

  it('documents Hermes base URL and identity ownership', () => {
    expect(readme).toContain('"host": "https://your-worker.example/v1"');
    expect(readme).toContain('MEM0_HOST=https://your-worker.example.workers.dev/v1');
    expect(readme).toContain('`user_id` is supplied by the caller');
    expect(readme).toContain('`agent_id` further partitions search and deduplication scope');
  });

  it('documents Windows command shims', () => {
    expect(readme).toContain('use `npm.cmd` and `npx.cmd`');
    expect(readme).toContain('PowerShell execution policy blocks the `npm.ps1` or `npx.ps1` shims');
  });

  it('documents the maintenance commands and security boundary', () => {
    for (const command of [
      'npm run maintenance:dedup -- inspect',
      'npm run maintenance:dedup -- apply --confirm backups/memory-deduplication-<timestamp>.json',
      'npm run maintenance:dedup -- verify',
      'node --env-file=.env scripts/migrate-memory-deduplication.mjs inspect',
      'node --env-file=.env scripts/migrate-memory-deduplication.mjs apply --confirm backups/memory-deduplication-<timestamp>.json',
      'node --env-file=.env scripts/migrate-memory-deduplication.mjs verify',
    ]) {
      expect(readme).toContain(command);
    }
    expect(readme).toContain('Inspection backups contain memory contents and must be protected as sensitive data');
    expect(readme).toContain('artifact schema, exact target configuration, inspected rows, planned mappings, and SHA-256 integrity fingerprint');
    expect(readme).toContain('Apply rejects target drift, artifact corruption, and any D1 state not reachable from the inspected rows through this artifact');
    expect(readme).toContain('waits until `processedUpToMutation` equals the last submitted maintenance mutation');
    expect(readme).toContain('`vector_state_hash`');
    expect(readme).toContain('[user ID, agent ID, run ID, actor ID, raw metadata JSON, content hash]');
    expect(readme).toContain('repairs and audits every reviewed duplicate mapping before any Vectorize mutation');
  });

  it('runs maintenance tests from the normal npm test lifecycle while preserving focused Vitest arguments', () => {
    expect(packageJson.scripts.test).toContain('vitest run');
    expect(packageJson.scripts.test).toContain('--exclude scripts/lib/memory-deduplication.test.mjs');
    expect(packageJson.scripts.posttest).toBe('npm run test:maintenance');
    expect(packageJson.scripts['test:maintenance']).toBe('node --test scripts/lib/memory-deduplication.test.mjs');
    expect(readme).toContain('`npm test -- tests/config.test.ts` still runs the focused Vitest target and then the maintenance suite');
  });

  it('keeps every write ingress paused from maintenance through migration 0008', () => {
    const apply0007 = readme.indexOf('Apply migration `0007_memory_deduplication_prepare.sql` only');
    const scopeKey = readme.indexOf('then create and verify the string `scope_key` Vectorize metadata index');
    const deploy = readme.indexOf('Deploy phase-one code with semantic deduplication still off.');
    const pause = readme.indexOf('Pause every write ingress');
    const drain = readme.indexOf('Drain the Queue completely, including active deliveries, retries, delayed messages, and backlog');
    const inspect = readme.indexOf('Run `inspect`, review its report and backup, and record the exact backup path.');
    const apply = readme.indexOf('Run `apply --confirm <inspection-artifact>` using that reviewed backup.');
    const verify = readme.indexOf('Run `verify` and confirm that it succeeds in production.');
    const create0008 = readme.indexOf('Only after successful production verification, create and apply migration `0008`');
    const resume = readme.indexOf('Resume writers only after migration `0008` has been applied');

    expect([
      apply0007, scopeKey, deploy, pause, drain, inspect, apply, verify, create0008, resume,
    ].every((index) => index >= 0)).toBe(true);
    expect(apply0007).toBeLessThan(scopeKey);
    expect(scopeKey).toBeLessThan(deploy);
    expect(deploy).toBeLessThan(pause);
    expect(pause).toBeLessThan(drain);
    expect(drain).toBeLessThan(inspect);
    expect(inspect).toBeLessThan(apply);
    expect(apply).toBeLessThan(verify);
    expect(verify).toBeLessThan(create0008);
    expect(create0008).toBeLessThan(resume);
  });

  it('keeps the implementation plan pause boundary aligned with the rollout', () => {
    const rollout = implementationPlan.slice(implementationPlan.indexOf('## Task 11:'));
    const apply0007 = rollout.indexOf('**Step 3: Apply migration `0007` and create the metadata index**');
    const deploy = rollout.indexOf('**Step 4: Deploy phase-one code with semantic deduplication off**');
    const pause = rollout.indexOf('**Step 5: Pause every write ingress and drain Queue work**');
    const task12 = rollout.indexOf('## Task 12:');
    const confirmPaused = rollout.indexOf('**Step 1: Confirm writers remain paused and Queue work remains drained**');
    const inspect = rollout.indexOf('**Step 2: Inspect production without mutation**');
    const applyAndVerify = rollout.indexOf('**Step 3: Require explicit operator confirmation, then apply and verify**');
    const enforce = rollout.indexOf('**Step 8: Commit and apply final enforcement while writers remain paused**');
    const resume = rollout.indexOf('**Step 10: Resume writers only after migration `0008`**');

    expect([
      apply0007, deploy, pause, task12, confirmPaused, inspect, applyAndVerify, enforce, resume,
    ].every((index) => index >= 0)).toBe(true);
    expect(apply0007).toBeLessThan(deploy);
    expect(deploy).toBeLessThan(pause);
    expect(pause).toBeLessThan(task12);
    expect(task12).toBeLessThan(confirmPaused);
    expect(confirmPaused).toBeLessThan(inspect);
    expect(inspect).toBeLessThan(applyAndVerify);
    expect(applyAndVerify).toBeLessThan(enforce);
    expect(enforce).toBeLessThan(resume);
    expect(implementationPlan).toContain('phase-one exact matching runs on every write but remains race-prone until production-verified migration `0008` adds database uniqueness');
    expect(implementationPlan).toContain('npm run maintenance:dedup -- apply --confirm backups/memory-deduplication-<timestamp>.json');
    expect(implementationPlan).toContain('processedUpToMutation');
    expect(implementationPlan).toContain('memory_vector_schema');
    expect(implementationPlan).toContain('vector_state_hash');
    expect(implementationPlan).toContain('graph convergence');
    expect(implementationPlan).toContain('artifact schema');
  });

  it('asserts migration 0008 is not in the phase-one inventory', () => {
    expect(migrationFiles).toContain('../src/migrations/0007_memory_deduplication_prepare.sql');
    expect(migrationFiles.filter((path) => /\/0008[^/]*\.sql$/.test(path))).toEqual([]);
  });

  it('does not present pending database uniqueness as included before migration 0008 exists', () => {
    const hasMigration0008 = migrationFiles.some((path) => /\/0008[^/]*\.sql$/.test(path));
    const includedStart = readme.indexOf('## Included');
    const notIncludedStart = readme.indexOf('## Not Included');
    const notIncludedEnd = readme.indexOf('## Architecture');

    expect(includedStart).toBeGreaterThanOrEqual(0);
    expect(notIncludedStart).toBeGreaterThan(includedStart);
    expect(notIncludedEnd).toBeGreaterThan(notIncludedStart);

    const included = readme.slice(includedStart, notIncludedStart);
    const notIncluded = readme.slice(notIncludedStart, notIncludedEnd);

    expect(hasMigration0008).toBe(false);
    if (!hasMigration0008) {
      expect(included).not.toMatch(/final database-enforced exact uniqueness/i);
      expect(notIncluded).toContain('Final database-enforced exact uniqueness is pending production verification and the reviewed migration `0008`');
    }
  });

  it('does not describe the removed manual cleanup control or API', () => {
    expect(readme).not.toContain('Deduplicate memories');
    expect(readme).not.toMatch(/\/dashboard\/api\/[^\s`]*dedup/i);
    expect(readme).not.toMatch(/manual(?:ly)?\s+(?:semantic\s+)?dedup/i);
  });
});
