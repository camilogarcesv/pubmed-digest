import { readFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { deployWorker } from '../src/operations/deploy-worker.js';
import { businessTables, migrations } from '../src/operations/release-checks.js';
import { formatReleaseFailure } from '../src/operations/release-diagnostics.js';

const previous = '22222222-2222-4222-8222-222222222222';
const next = '33333333-3333-4333-8333-333333333333';
const input = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-api-token-only',
  D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111', VOTES_KV_ID: 'b'.repeat(32),
  WORKER_EXPECTED_VERSION: previous, DIGEST_SERVICE_SECRET: 'c'.repeat(64), VOTES_READ_SECRET: 'synthetic-export-secret',
  VOTES_URL: 'https://pubmed-digest-votes.test.workers.dev/votes',
  GITHUB_SHA: 'd'.repeat(40), EXPECTED_SHA: 'd'.repeat(40), GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_ACTIONS: 'true',
};

function fixture(options: { populated?: boolean; smokeFailure?: boolean; deployUncertain?: boolean; drift?: boolean; rollbackDrift?: boolean; migrateFailure?: boolean; partial?: boolean; rollbackFailure?: boolean; accessDenied?: boolean } = {}) {
  let current = options.drift ? next : previous;
  let migrated = false;
  let configPath = '';
  const command = vi.fn(async (args: string[]) => {
    configPath = args[args.indexOf('--config') + 1];
    if (args[0] === 'deployments') return JSON.stringify([{ created_on: '2026-09-15', versions: [{ version_id: current, percentage: 100 }] }]);
    if (args[0] === 'rollback') {
      if (options.rollbackFailure) throw new Error('private rollback details');
      current = previous; return '';
    }
    if (args[0] === 'deploy') {
      if (args.includes('--dry-run')) return '';
      current = next;
      if (options.deployUncertain) throw new Error('private provider error');
      return '';
    }
    if (args.includes('migrations')) {
      if (options.migrateFailure) throw Object.assign(new Error('private migration details'), {
        stdout: `Migration failed for private-id: incomplete input: SQLITE_ERROR [code: 7500] ${input.CLOUDFLARE_API_TOKEN}`,
        stderr: `private SQL ${input.VOTES_URL} ${input.DIGEST_SERVICE_SECRET}`,
      });
      migrated = true;
      return '';
    }
    const query = args[args.indexOf('--command') + 1];
    let results: unknown[] = [];
    if (query.includes('sqlite_schema')) results = migrated || options.populated || options.partial ? [...businessTables, 'system_controls', 'd1_migrations'].map(name => ({ name })) : [];
    else if (query.includes('SELECT name FROM d1_migrations')) results = (migrated ? migrations : migrations.slice(0, 1)).map(name => ({ name }));
    else if (query.includes('SELECT singleton')) results = [{ singleton: 1, mode: 'legacy' }];
    else if (query.includes('count(*)')) results = [{ n: options.populated ? 1 : 0 }];
    else if (!query.includes('foreign_key_check')) throw new Error(`Unexpected SQL: ${query}`);
    return JSON.stringify([{ success: true, results }]);
  });
  const fetcher: typeof fetch = vi.fn(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (options.accessDenied) return new Response('private provider details', { status: 403 });
    if (path.endsWith('/settings')) return Response.json({ success: true, result: { bindings: [
      { name: 'VOTES', type: 'kv_namespace', namespace_id: input.VOTES_KV_ID },
      ...['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'VOTES_READ_SECRET'].map(name => ({ name, type: 'secret_text' })),
      ...(current === next ? [{ name: 'DB', type: 'd1', id: input.D1_DATABASE_ID }, { name: 'DIGEST_SERVICE_SECRET', type: 'secret_text' }] : []),
    ] } });
    if (path.includes('/d1/database/')) return Response.json({ success: true, result: { uuid: input.D1_DATABASE_ID, name: 'pubmed-digest' } });
    if (path.endsWith('/subdomain')) return Response.json({ success: true, result: { subdomain: 'test' } });
    if (path.includes('/versions/')) return Response.json({ success: true, result: { annotations: { 'workers/tag': options.rollbackDrift ? 'another-sha' : input.GITHUB_SHA } } });
    const auth = new Headers(init?.headers).get('authorization');
    if (path === '/votes') return auth === `Bearer ${input.VOTES_READ_SECRET}` ? Response.json({ votes: [] }) : new Response('', { status: 403 });
    if (options.smokeFailure) return new Response('', { status: 500 });
    if (auth !== `Bearer ${input.DIGEST_SERVICE_SECRET}`) return new Response('', { status: 401 });
    const data = path.endsWith('/mode') ? { mode: 'legacy' } : path.endsWith('/seen/check') ? { seen: [false] }
      : path.endsWith('/eval-context') ? { votes: [] } : { users: [] };
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  });
  return { command, fetch: fetcher, configPath: () => configPath, current: () => current };
}

it('validates resources, migrates only schema and deploys additively with private config', async () => {
  const f = fixture();
  await deployWorker(input, f);
  expect(f.current()).toBe(next);
  const config = JSON.parse(await readFile(f.configPath(), 'utf8'));
  expect(config.d1_databases[0].database_id).toBe(input.D1_DATABASE_ID);
  expect(config.kv_namespaces[0].id).toBe(input.VOTES_KV_ID);
  expect(config.main).toBe(resolve('worker/worker.ts'));
  expect(JSON.stringify(config)).not.toContain(input.DIGEST_SERVICE_SECRET);
  await expect(access(resolve(dirname(f.configPath()), 'secrets.json'))).rejects.toThrow();
  expect(f.command.mock.calls.some(([args]) => args.includes('--secrets-file') && args.includes('--keep-vars'))).toBe(true);
  expect(f.command.mock.calls.some(([args]) => args[0] === 'rollback')).toBe(false);
});
it.each([{ populated: true }, { drift: true }, { migrateFailure: true }])('refuses to deploy after failed prerequisite %j', async options => {
  const f = fixture(options);
  await expect(deployWorker(input, f)).rejects.toThrow();
  expect(f.command.mock.calls.some(([args]) => args[0] === 'deploy' && !args.includes('--dry-run'))).toBe(false);
});
it.each([{ smokeFailure: true }, { deployUncertain: true }])('restores the previous Worker on failure %j without deleting D1', async options => {
  const f = fixture(options);
  await expect(deployWorker(input, f)).rejects.toMatchObject({ recovery: 'previous_restored' });
  expect(f.current()).toBe(previous);
  expect(f.command.mock.calls.some(([args]) => args[0] === 'rollback' && args[1] === previous)).toBe(true);
  expect(f.command.mock.calls.some(([args]) => args.includes('delete'))).toBe(false);
});
it('never rolls back an unknown concurrently published version', async () => {
  const f = fixture({ smokeFailure: true, rollbackDrift: true });
  await expect(deployWorker(input, f)).rejects.toMatchObject({ recovery: 'manual_reconciliation', stage: 'smoke' });
  expect(f.command.mock.calls.some(([args]) => args[0] === 'rollback')).toBe(false);
});

it('resumes an empty partially migrated database without clearing existing schema', async () => {
  const f = fixture({ partial: true });
  await deployWorker(input, f);
  expect(f.current()).toBe(next);
  const commands = f.command.mock.calls.map(([args]) => args);
  expect(commands.filter(args => args.includes('migrations'))).toHaveLength(1);
  expect(commands.some(args => /DROP|DELETE|TRUNCATE/.test(args.join(' ')))).toBe(false);
});

it('reports a safe migration failure and never publishes or rolls back the Worker', async () => {
  const f = fixture({ partial: true, migrateFailure: true });
  const error = await deployWorker(input, f).catch(error => error);
  expect(JSON.parse(formatReleaseFailure(error))).toEqual({
    event: 'worker_release_failed', stage: 'migrate', code: 'sql_incomplete_input', recovery: 'not_attempted',
  });
  expect(f.current()).toBe(previous);
  expect(f.command.mock.calls.some(([args]) => args[0] === 'rollback' || (args[0] === 'deploy' && !args.includes('--dry-run')))).toBe(false);
});

it.each([
  [{ accessDenied: true }, 'inventory', 'provider_access_denied', 'not_attempted'],
  [{ smokeFailure: true }, 'smoke', 'step_failed', 'previous_restored'],
  [{ smokeFailure: true, rollbackFailure: true }, 'rollback', 'provider_command_failed', 'manual_reconciliation'],
  [{ deployUncertain: true }, 'publish', 'provider_command_failed', 'previous_restored'],
] as const)('keeps failure stage and recovery accurate for %j', async (options, stage, code, recovery) => {
  const f = fixture(options);
  const error = await deployWorker(input, f).catch(error => error);
  expect(JSON.parse(formatReleaseFailure(error))).toEqual({ event: 'worker_release_failed', stage, code, recovery });
});
