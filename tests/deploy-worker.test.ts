import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { readFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { deployWorker } from '../src/operations/deploy-worker.js';
import { migrations } from '../src/operations/release-checks.js';
import { formatReleaseFailure } from '../src/operations/release-diagnostics.js';

const previous = '22222222-2222-4222-8222-222222222222';
const next = '33333333-3333-4333-8333-333333333333';
const input = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-api-token-only',
  D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111', VOTES_KV_ID: 'b'.repeat(32),
  WORKER_EXPECTED_VERSION: previous, IMPORT_SERVICE_SECRET: 'f'.repeat(64), DIGEST_SERVICE_SECRET: 'c'.repeat(64), VOTES_READ_SECRET: 'synthetic-export-secret',
  VOTES_URL: 'https://pubmed-digest-votes.test.workers.dev/votes',
  GITHUB_SHA: 'd'.repeat(40), EXPECTED_SHA: 'd'.repeat(40), GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_ACTIONS: 'true',
};

function fixture(options: { maintenance?: boolean; populated?: boolean; upgrade?: boolean; smokeFailure?: boolean; deployUncertain?: boolean; drift?: boolean; rollbackDrift?: boolean; migrateFailure?: boolean; partial?: boolean; rollbackFailure?: boolean; accessDenied?: boolean; beforeCommand?: (db: DatabaseSync, args: string[]) => void;
  // Which authenticated mode reads still reach the previous version, and whether it already holds the digest secret.
  previousAnswers?: (read: number) => boolean; previousKeepsSecret?: boolean } = {}) {
  let current = options.drift ? next : previous;
  let modeReads = 0;
  const db = new DatabaseSync(':memory:');
  const migrate = (names: string[], directory = 'worker/migrations') => {
    db.exec('CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY,name TEXT)');
    for (const name of names) {
      if (db.prepare('SELECT 1 FROM d1_migrations WHERE name=?').get(name)) continue;
      db.exec('BEGIN');
      try {
        db.exec(readFileSync(`${directory}/${name}`, 'utf8'));
        db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
  if (options.partial) migrate(migrations.slice(0, 1));
  if (options.populated || options.upgrade) {
    migrate(options.upgrade ? migrations.slice(0, 4) : migrations);
    db.exec("INSERT INTO users(id,slug,email,timezone,status,created_at) VALUES('test','test','test@example.test','UTC','paused','2026-09-15')");
  }
  if (options.maintenance) {
    migrate(migrations);
    db.exec("UPDATE system_controls SET mode='maintenance'");
    db.exec("UPDATE users SET status='active'");
  }
  let configPath = '';
  const command = vi.fn(async (args: string[]) => {
    configPath = args[args.indexOf('--config') + 1];
    options.beforeCommand?.(db, args);
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
      migrate(migrations, JSON.parse(readFileSync(configPath, 'utf8')).d1_databases[0].migrations_dir);
      return '';
    }
    const query = args[args.indexOf('--command') + 1];
    const results = db.prepare(query).all();
    return JSON.stringify([{ success: true, results }]);
  });
  const fetcher: typeof fetch = vi.fn(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (options.accessDenied) return new Response('private provider details', { status: 403 });
    if (path.endsWith('/settings')) return Response.json({ success: true, result: { bindings: [
      { name: 'VOTES', type: 'kv_namespace', namespace_id: input.VOTES_KV_ID },
      ...['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'VOTES_READ_SECRET'].map(name => ({ name, type: 'secret_text' })),
      ...(current === next ? [{ name: 'DB', type: 'd1', id: input.D1_DATABASE_ID }, { name: 'DIGEST_SERVICE_SECRET', type: 'secret_text' },
        { name: 'CF_VERSION_METADATA', type: 'version_metadata' }] : []),
    ] } });
    if (path.includes('/d1/database/')) return Response.json({ success: true, result: { uuid: input.D1_DATABASE_ID, name: 'pubmed-digest' } });
    if (path.endsWith('/subdomain')) return Response.json({ success: true, result: { subdomain: 'test' } });
    if (path.includes('/versions/')) return Response.json({ success: true, result: { annotations: { 'workers/tag': options.rollbackDrift ? 'another-sha' : input.GITHUB_SHA } } });
    const auth = new Headers(init?.headers).get('authorization');
    if (path === '/votes') return auth === `Bearer ${input.VOTES_READ_SECRET}` ? Response.json({ votes: [] }) : new Response('', { status: 403 });
    if (path === '/internal/v1/imports' || path.startsWith('/internal/v1/imports/')) return new Response('', { status: auth === `Bearer ${input.IMPORT_SERVICE_SECRET}` ? 400 : 401 });
    if (path === '/internal/v1/admin/authority' && options.maintenance && auth === `Bearer ${input.IMPORT_SERVICE_SECRET}`) {
      const count = (sql: string) => Number(db.prepare(sql).get()?.n);
      return Response.json({ mode: 'maintenance', sending: count("SELECT count(*) AS n FROM delivery_messages WHERE status='sending'"),
        legacyWrites: count('SELECT count(*) AS n FROM legacy_vote_inflight') }, { headers: { 'cache-control': 'no-store' } });
    }
    if (path.startsWith('/internal/v1/admin/')) return new Response('', { status: auth === `Bearer ${input.IMPORT_SERVICE_SECRET}` ? 409 : 401 });
    if (path.endsWith('/mode') && auth === `Bearer ${input.DIGEST_SERVICE_SECRET}` && options.previousAnswers?.(modeReads++)) {
      // The previous version predates the version field.
      return options.previousKeepsSecret ? Response.json({ mode: 'legacy' }, { headers: { 'cache-control': 'no-store' } }) : new Response('', { status: 401 });
    }
    if (options.smokeFailure && !path.endsWith('/mode')) return new Response('', { status: 500 });
    if (auth !== `Bearer ${input.DIGEST_SERVICE_SECRET}`) return new Response('', { status: 401 });
    if (path.includes('/by-slug/')) return new Response('', { status: 404, headers: { 'cache-control': 'no-store' } });
    if (path.includes('/digest-runs') || path.endsWith('/ops/alerts')) {
      return init?.method === 'GET' ? Response.json({ runs: [] }, { headers: { 'cache-control': 'no-store' } }) : new Response('', { status: 409 });
    }
    const data = path.endsWith('/mode') ? { mode: options.maintenance ? 'maintenance' : 'legacy', version: current } : path.endsWith('/seen/check') ? { seen: [false] }
      : path.endsWith('/eval-context') ? { votes: [] } : { users: [] };
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  });
  return { command, fetch: fetcher, wait: vi.fn(async (_ms: number) => {}), configPath: () => configPath, current: () => current, db };
}

it('deploys with active users under maintenance and rolls back code while preserving their data', async () => {
  for (const smokeFailure of [false, true]) {
    const f = fixture({ populated: true, maintenance: true, smokeFailure });
    const before = f.db.prepare('SELECT * FROM users').all();
    if (smokeFailure) await expect(deployWorker({ ...input, WORKER_EXPECTED_MODE: 'maintenance' }, f)).rejects.toMatchObject({ recovery: 'previous_restored' });
    else await deployWorker({ ...input, WORKER_EXPECTED_MODE: 'maintenance' }, f);
    expect(f.db.prepare('SELECT * FROM users').all()).toEqual(before);
    expect(f.db.prepare('SELECT mode FROM system_controls').get()?.mode).toBe('maintenance');
  }
});

it('keeps a legacy release verified while a vote comes and goes', async () => {
  // A legacy vote holds a claim for the length of one KV write; it must not fail the release.
  let claimed = false;
  const f = fixture({ populated: true, beforeCommand: (db, args) => {
    if (!claimed) { db.exec("INSERT INTO legacy_vote_inflight VALUES('vote','2026-09-26T12:00:00.000Z')"); claimed = true; }
    if (args[0] === 'deploy' && !args.includes('--dry-run')) db.exec('DELETE FROM legacy_vote_inflight');
  } });
  await deployWorker(input, f);
  expect(f.current()).toBe(next);
  expect(f.command.mock.calls.some(([args]) => args[0] === 'rollback')).toBe(false);
});

it('refuses a maintenance release while a legacy vote is still in flight', async () => {
  const f = fixture({ populated: true, maintenance: true });
  f.db.exec("UPDATE system_controls SET mode='legacy'");
  f.db.exec("INSERT INTO legacy_vote_inflight VALUES('vote','2026-09-26T12:00:00.000Z')");
  f.db.exec("UPDATE system_controls SET mode='maintenance'");
  await expect(deployWorker({ ...input, WORKER_EXPECTED_MODE: 'maintenance' }, f)).rejects.toMatchObject({ stage: 'schema_precheck', recovery: 'not_attempted' });
  expect(f.command.mock.calls.some(([args]) => args.includes('migrations') || (args[0] === 'deploy' && !args.includes('--dry-run')))).toBe(false);
});

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
it.each([{ drift: true }, { migrateFailure: true }])('refuses to deploy after failed prerequisite %j', async options => {
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
it('waits until the published version serves before smoke testing a rotated secret', async () => {
  const f = fixture({ previousAnswers: read => read < 4 });
  await deployWorker(input, f);
  expect(f.current()).toBe(next);
  // Four stale reads, then three consecutive answers from the published version.
  expect(f.wait.mock.calls).toEqual(Array(6).fill([2_000]));
  expect(f.command.mock.calls.some(([args]) => args[0] === 'rollback')).toBe(false);
});
it('restarts the wait when the previous version answers again', async () => {
  const f = fixture({ previousAnswers: read => read === 1 });
  await deployWorker(input, f);
  expect(f.wait).toHaveBeenCalledTimes(4);
});
it('restores the previous Worker when the published version never serves, even if the previous one answers', async () => {
  const f = fixture({ previousAnswers: () => true, previousKeepsSecret: true });
  await expect(deployWorker(input, f)).rejects.toMatchObject({ stage: 'propagation', recovery: 'previous_restored' });
  expect(f.wait).toHaveBeenCalledTimes(60);
  expect(f.current()).toBe(previous);
});
it('restores the previous Worker when the smoke reaches another version', async () => {
  const f = fixture({ previousAnswers: read => read === 3, previousKeepsSecret: true });
  await expect(deployWorker(input, f)).rejects.toMatchObject({ stage: 'smoke', recovery: 'previous_restored' });
  expect(f.current()).toBe(previous);
});
it('restores the previous Worker when reconciliation is reachable without the import credential', async () => {
  const f = fixture();
  const original = f.fetch;
  f.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => new URL(String(url)).pathname.includes('/vote-reconciliations/')
    ? new Response('', { status: 400 }) : original(url, init)) as typeof fetch;
  await expect(deployWorker(input, f)).rejects.toMatchObject({ stage: 'smoke', recovery: 'previous_restored' });
  expect(f.current()).toBe(previous);
});
it('restores the previous Worker when a digest write is not inert in legacy mode', async () => {
  const f = fixture();
  const original = f.fetch;
  f.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => new URL(String(url)).pathname.endsWith('/prepare')
    && new Headers(init?.headers).get('authorization') === `Bearer ${input.DIGEST_SERVICE_SECRET}` ? Response.json({}) : original(url, init)) as typeof fetch;
  await expect(deployWorker(input, f)).rejects.toMatchObject({ stage: 'smoke', recovery: 'previous_restored' });
  expect(f.current()).toBe(previous);
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
  expect(commands.some(args => /DROP|TRUNCATE/.test(args.join(' ')))).toBe(false);
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

it('preserves populated paused legacy databases during upgrades', async () => { await deployWorker(input, fixture({ populated: true })); });

it.each([
  "UPDATE operation_lock SET expires_at=unixepoch()-1",
  "UPDATE operation_lock SET owner='another-import',kind='import',expires_at=unixepoch()-1",
  'DELETE FROM operation_lock',
])('stops before migration instead of reacquiring a lost lease: %s', async loss => {
  const f = fixture({ populated: true, beforeCommand(db, args) {
    if (args[0] === 'deploy' && args.includes('--dry-run')) db.exec(loss);
  } });
  await expect(deployWorker(input, f)).rejects.toMatchObject({ stage: 'migrate' });
  expect(f.command.mock.calls.some(([args]) => args.includes('migrations'))).toBe(false);
  expect(f.command.mock.calls.some(([args]) => args[0] === 'deploy' && !args.includes('--dry-run'))).toBe(false);
});

it('retains the active version for reconciliation when a post-publish lease is lost', async () => {
  const f = fixture({ populated: true, beforeCommand(db, args) {
    if (args[0] === 'deploy' && !args.includes('--dry-run')) {
      db.exec("UPDATE operation_lock SET owner='another-import',kind='import',expires_at=unixepoch()+900");
    }
  } });
  await expect(deployWorker(input, f)).rejects.toMatchObject({ stage: 'schema_final_check', recovery: 'manual_reconciliation' });
  expect(f.current()).toBe(next);
  expect(f.command.mock.calls.some(([args]) => args[0] === 'rollback')).toBe(false);
  expect(f.db.prepare('SELECT owner FROM operation_lock').get()?.owner).toBe('another-import');
});

it('detects changes to existing content before publishing without deleting that content', async () => {
  const f = fixture({ populated: true, beforeCommand(db, args) {
    if (args.includes('migrations')) db.exec("UPDATE users SET email='changed@example.test' WHERE id='test'");
  } });
  await expect(deployWorker(input, f)).rejects.toMatchObject({ stage: 'schema_postcheck' });
  expect(f.current()).toBe(previous);
  expect(f.db.prepare("SELECT email FROM users WHERE id='test'").get()?.email).toBe('changed@example.test');
  expect(f.command.mock.calls.some(([args]) => args[0] === 'rollback')).toBe(false);
});

it('rejects schema drift even when migration names and row counts match', async () => {
  const f = fixture({ populated: true });
  f.db.exec('DROP INDEX votes_user_time');
  await expect(deployWorker(input, f)).rejects.toMatchObject({ stage: 'schema_precheck' });
  expect(f.command.mock.calls.some(([args]) => args.includes('migrations'))).toBe(false);
});

it('rolls back migration content and its checkpoint when the final transactional lease guard fails', async () => {
  const f = fixture({ populated: true });
  await deployWorker(input, f);
  const config = JSON.parse(await readFile(f.configPath(), 'utf8'));
  const source = await readFile('worker/migrations/0001_multiuser.sql', 'utf8');
  const wrapped = await readFile(resolve(config.d1_databases[0].migrations_dir, '0001_multiuser.sql'), 'utf8');
  const [before, after] = wrapped.split(source);
  expect(before).toContain('INSERT INTO operation_assertions');
  expect(after).toContain('INSERT INTO operation_assertions');
  const owner = /VALUES\('([^']+)'/.exec(before)?.[1];
  expect(owner).toBeDefined();
  f.db.prepare("INSERT INTO operation_lock VALUES(1,?,'deploy',unixepoch()+900)").run(owner!);
  f.db.exec('BEGIN');
  try {
    expect(() => f.db.exec(`${before}
      UPDATE users SET email='changed@example.test' WHERE id='test';
      INSERT INTO d1_migrations(name) VALUES('synthetic_additive.sql');
      UPDATE operation_lock SET expires_at=unixepoch()-1;
      ${after}`)).toThrow('operation lease lost');
  } finally {
    f.db.exec('ROLLBACK');
  }
  expect(f.db.prepare("SELECT email FROM users WHERE id='test'").get()?.email).toBe('test@example.test');
  expect(f.db.prepare("SELECT name FROM d1_migrations WHERE name='synthetic_additive.sql'").get()).toBeUndefined();
  expect(f.db.prepare('SELECT * FROM operation_assertions').all()).toEqual([]);
});

it('upgrades populated prior schema while preserving pre-existing fields and rollback compatibility', async () => {
  const f = fixture({ upgrade: true, smokeFailure: true });
  f.db.exec("INSERT INTO articles VALUES('123','Original',NULL,NULL,'2026-09-15'); INSERT INTO user_articles VALUES('test','123','2026-09-15',0,NULL,NULL,NULL,1,NULL)");
  await expect(deployWorker(input, f)).rejects.toMatchObject({ recovery: 'previous_restored' });
  expect(f.current()).toBe(previous);
  expect(f.db.prepare('SELECT pmid,first_seen,relevance,delivered,delivered_at FROM user_articles').get()).toEqual({ pmid: '123', first_seen: '2026-09-15', relevance: 0, delivered: 1, delivered_at: null });
  expect(f.db.prepare("SELECT name FROM d1_migrations WHERE name='0005_import_sessions.sql'").get()).toBeDefined();
});
