import { assertSchema, snapshot, assertPreserved } from './database-snapshot.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { activeVersion, assertBindings, assertCompatibleSchema, migrations, releaseEnvironment } from './release-checks.js';
import { commandFailure, formatReleaseFailure, ProviderFailure, ReleaseFailure, releaseFailure, type ReleaseStage } from './release-diagnostics.js';

const exec = promisify(execFile);

// Initial installation requires empty tables; upgrades preserve all existing content.
// Capture provider output privately: CLI errors may contain identifiers or credentials.
type Runtime = {
  command?: (args: string[]) => Promise<string>;
  fetch?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
};

export async function deployWorker(input = process.env, runtime: Runtime = {}): Promise<void> {
  const progress: { stage: ReleaseStage } = { stage: 'prepare' };
  try {
    await executeDeployment(input, runtime, progress);
  } catch (error) {
    if (error instanceof ReleaseFailure) throw error;
    throw releaseFailure(progress.stage, error, progress.stage === 'rollback' ? 'manual_reconciliation' : 'not_attempted');
  }
}

async function executeDeployment(input: NodeJS.ProcessEnv, runtime: Runtime, progress: { stage: ReleaseStage }): Promise<void> {
  const config = releaseEnvironment(input);
  const root = process.cwd();
  await mkdir('.local/releases', { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(resolve('.local/releases/worker-'));
  const configPath = resolve(directory, 'wrangler.json');
  const secretsPath = resolve(directory, 'secrets.json');
  const template = JSON.parse(await readFile('worker/wrangler.jsonc', 'utf8'));
  template.main = resolve('worker/worker.ts');
  template.account_id = config.CLOUDFLARE_ACCOUNT_ID;
  template.kv_namespaces[0].id = config.VOTES_KV_ID;
  template.d1_databases[0].database_id = config.D1_DATABASE_ID;
  template.d1_databases[0].migrations_dir = resolve('worker/migrations');
  await writeFile(configPath, JSON.stringify(template), { mode: 0o600 });

  const wrangler = async (args: string[]): Promise<string> => {
    try {
      if (runtime.command) return await runtime.command([...args, '--config', configPath]);
      const result = await exec('pnpm', ['exec', 'wrangler', ...args, '--config', configPath], {
        cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: 180_000,
        env: { ...input, WRANGLER_LOG_PATH: resolve(directory, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false', CI: 'true' },
      });
      return result.stdout;
    } catch (error) {
      throw commandFailure(error);
    }
  };
  const cloudflare = async (suffix: string): Promise<unknown> => {
    const response = await (runtime.fetch ?? fetch)(`https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}/${suffix}`, {
      headers: { authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    if (!response.ok) throw new ProviderFailure(response.status === 401 || response.status === 403 ? 'provider_access_denied' : 'step_failed');
    const body = z.object({ success: z.literal(true), result: z.unknown() }).parse(await response.json());
    return body.result;
  };
  const scriptPath = `workers/scripts/${template.name as string}`;
  const deployment = async () => activeVersion(JSON.parse(await wrangler(['deployments', 'list', '--json'])));
  const settings = async (requireD1 = false) => {
    const current = z.object({ bindings: z.unknown() }).parse(await cloudflare(`${scriptPath}/settings`));
    assertBindings(current.bindings, config.VOTES_KV_ID, config.D1_DATABASE_ID, requireD1);
  };
  const sql = async (query: string): Promise<Record<string, unknown>[]> => {
    const output = await wrangler(['d1', 'execute', 'DB', '--remote', '--json', '--command', query]);
    const result = z.array(z.object({ success: z.literal(true), results: z.array(z.record(z.string(), z.unknown())) })).length(1).parse(JSON.parse(output));
    return result[0].results;
  };
  const checkDatabase = async (complete: boolean) => {
    const rows = await sql("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name");
    const tables = rows.map(row => z.string().parse(row.name)).filter(name => name !== 'd1_migrations');
    // Validate identifiers against an allowlist before constructing COUNT queries.
    assertCompatibleSchema(tables, tables.map(() => 0), 'legacy', tables.length ? ['0001_multiuser.sql'] : [], false);
    const counts: number[] = [];
    let mode: unknown;
    for (const table of tables) {
      if (table === 'system_controls') {
        const modes = await sql('SELECT singleton,mode FROM system_controls');
        if (modes.length !== 1 || modes[0].singleton !== 1) throw new Error('Invalid system control');
        mode = modes[0].mode;
        counts.push(0);
      } else counts.push(z.number().parse((await sql(`SELECT count(*) AS n FROM ${table}`))[0]?.n));
    }
    const applied = rows.some(r => r.name === 'd1_migrations')
      ? (await sql('SELECT name FROM d1_migrations ORDER BY id')).map(r => z.string().parse(r.name)) : [];
    assertCompatibleSchema(tables, counts, mode, applied, complete, config.WORKER_EXPECTED_MODE);
    if ((await sql('PRAGMA foreign_key_check')).length !== 0) throw new Error('Foreign key check failed');
    await assertSchema(sql, applied);
    if (config.WORKER_EXPECTED_MODE === 'legacy' && tables.includes('users') && (await sql("SELECT id FROM users WHERE status!='paused'")).length) throw new Error('Expected paused users');
    // Legacy votes keep flowing during a legacy release; under maintenance none may be pending.
    if (config.WORKER_EXPECTED_MODE === 'maintenance' && tables.includes('legacy_vote_inflight') && (await sql('SELECT id FROM legacy_vote_inflight')).length) throw new Error('Legacy votes still in flight');
    if (tables.includes('delivery_messages') && (await sql("SELECT id FROM delivery_messages WHERE status='sending'")).length) throw new Error('Delivery still in flight');
    return tables;
  };
  const origin = new URL(config.VOTES_URL).origin;
  const get = async (path: string, secret?: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => (runtime.fetch ?? fetch)(`${origin}${path}`, {
    method,
    headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  const verifyLegacy = async () => {
    const response = await get('/votes', config.VOTES_READ_SECRET);
    if (response.status !== 200) throw new Error('Legacy export failed');
    z.object({ votes: z.array(z.object({ pmid: z.string(), value: z.union([z.literal(0), z.literal(1)]), chatId: z.string(), votedAt: z.string() })) }).parse(await response.json());
  };
  // Activation is not delivery: the edge keeps serving the previous version for a few seconds,
  // and a rotated secret gets 401 there. Wait until the published version answers consistently.
  const propagated = async (version: string) => {
    let streak = 0;
    for (let attempt = 0; attempt < 60 && streak < 3; attempt++) {
      const response = await get('/internal/v1/mode', config.DIGEST_SERVICE_SECRET);
      const body: unknown = response.status === 200 ? await response.json().catch(() => null) : null;
      streak = z.object({ version: z.literal(version) }).safeParse(body).success ? streak + 1 : 0;
      if (streak < 3) await (runtime.wait ?? (ms => new Promise(done => setTimeout(done, ms))))(2_000);
    }
    if (streak < 3) throw new Error('Published version is not serving');
  };
  const smoke = async (version: string) => {
    for (const path of ['/internal/v1/mode', '/internal/v1/contexts']) {
      for (const secret of [undefined, config.VOTES_READ_SECRET]) {
        if ((await get(path, secret)).status !== 401) throw new Error('Internal auth smoke failed');
      }
      const response = await get(path, config.DIGEST_SERVICE_SECRET);
      if (response.status !== 200 || response.headers.get('cache-control') !== 'no-store') throw new Error('Internal API smoke failed');
      const body: unknown = await response.json();
      if (path.endsWith('/mode')) z.object({ mode: z.literal(config.WORKER_EXPECTED_MODE), version: z.literal(version) }).strict().parse(body);
      else z.object({ users: config.WORKER_EXPECTED_MODE === 'legacy' ? z.array(z.unknown()).length(0) : z.array(z.unknown()) }).strict().parse(body);
    }
    for (const secret of [undefined, config.DIGEST_SERVICE_SECRET, config.VOTES_READ_SECRET]) {
      if ((await get('/internal/v1/imports', secret, {})).status !== 401) throw new Error('Import credential isolation failed');
    }
    if ((await get('/internal/v1/imports', config.IMPORT_SERVICE_SECRET, {})).status !== 400) throw new Error('Import credential unavailable');
    const probeUser = crypto.randomUUID();
    // Reconciliation is import-credential only; an empty body is rejected before any D1 read.
    const reconcile = `/internal/v1/imports/users/${probeUser}/vote-reconciliations/plan`;
    for (const secret of [undefined, config.DIGEST_SERVICE_SECRET, config.VOTES_READ_SECRET]) {
      if ((await get(reconcile, secret, {})).status !== 401) throw new Error('Reconciliation credential isolation failed');
    }
    if ((await get(reconcile, config.IMPORT_SERVICE_SECRET, {})).status !== 400) throw new Error('Reconciliation route unavailable');
    const ledger = `/internal/v1/imports/users/${probeUser}/ledger-extensions`;
    for (const secret of [undefined, config.DIGEST_SERVICE_SECRET, config.VOTES_READ_SECRET]) {
      if ((await get(ledger, secret, {})).status !== 401) throw new Error('Ledger credential isolation failed');
    }
    if ((await get(ledger, config.IMPORT_SERVICE_SECRET, {})).status !== 400) throw new Error('Ledger route unavailable');
    // Digest run writes, deliveries and alerts: digest credential only, and inert while legacy.
    const runs = `/internal/v1/users/${probeUser}/digest-runs`, probeRun = `${runs}/${crypto.randomUUID()}`;
    for (const [path, method] of [[runs, 'POST'], [`${probeRun}/items/0`, 'PUT'], [`${probeRun}/prepare`, 'POST'], [`${probeRun}/abort`, 'POST'],
      [`${probeRun}/destinations/${crypto.randomUUID()}/deliver`, 'POST'], ['/internal/v1/ops/alerts', 'POST']]) {
      for (const secret of [undefined, config.VOTES_READ_SECRET, config.IMPORT_SERVICE_SECRET]) {
        if ((await get(path, secret, {}, method)).status !== 401) throw new Error('Digest run credential isolation failed');
      }
      if ((await get(path, config.DIGEST_SERVICE_SECRET, {}, method)).status !== 409) throw new Error('Digest run writes are not inert');
    }
    const resolution = `/internal/v1/admin/users/${probeUser}/digest-runs/${crypto.randomUUID()}/messages/${crypto.randomUUID()}/resolve`;
    for (const secret of [undefined, config.DIGEST_SERVICE_SECRET, config.VOTES_READ_SECRET]) {
      if ((await get(resolution, secret, {})).status !== 401) throw new Error('Resolution credential isolation failed');
    }
    if ((await get(resolution, config.IMPORT_SERVICE_SECRET, {})).status !== 409) throw new Error('Resolution is not inert');
    const listed = await get(`${runs}?period=2026-W01`, config.DIGEST_SERVICE_SECRET);
    if (listed.status !== 200 || listed.headers.get('cache-control') !== 'no-store') throw new Error('Run list smoke failed');
    z.object({ runs: z.array(z.unknown()).length(0) }).strict().parse(await listed.json());
    if ((await get(`/internal/v1/users/by-slug/probe-${probeUser.slice(0, 8)}/context`, config.DIGEST_SERVICE_SECRET)).status !== 404) throw new Error('Context smoke failed');
    const seen = await get('/internal/v1/seen/check', config.DIGEST_SERVICE_SECRET, { pairs: [{ userId: probeUser, pmid: '1' }] });
    if (seen.status !== 200 || seen.headers.get('cache-control') !== 'no-store') throw new Error('Seen smoke failed');
    z.object({ seen: z.tuple([z.literal(false)]) }).strict().parse(await seen.json());
    const evaluation = await get(`/internal/v1/users/${probeUser}/eval-context`, config.DIGEST_SERVICE_SECRET);
    if (evaluation.status !== 200 || evaluation.headers.get('cache-control') !== 'no-store') throw new Error('Eval smoke failed');
    z.object({ votes: z.array(z.unknown()).length(0) }).strict().parse(await evaluation.json());
    if ((await get('/votes', config.DIGEST_SERVICE_SECRET)).status !== 403) throw new Error('Cross-credential smoke failed');
    await verifyLegacy();
  };

  progress.stage = 'inventory';
  const previous = await deployment();
  if (previous !== config.WORKER_EXPECTED_VERSION) throw new Error('Deployment drift; inventory again');
  await settings();
  const database = z.object({ uuid: z.string(), name: z.string() }).parse(await cloudflare(`d1/database/${config.D1_DATABASE_ID}`));
  if (database.uuid !== config.D1_DATABASE_ID || database.name !== template.d1_databases[0].database_name) throw new Error('Database identity mismatch');
  const subdomain = z.object({ subdomain: z.string() }).parse(await cloudflare('workers/subdomain'));
  if (origin !== `https://${template.name as string}.${subdomain.subdomain}.workers.dev`) throw new Error('Worker origin mismatch');
  progress.stage = 'legacy_check';
  await verifyLegacy();
  progress.stage = 'schema_precheck';
  if (config.WORKER_EXPECTED_MODE === 'maintenance') {
    const response = await get('/internal/v1/admin/authority', config.IMPORT_SERVICE_SECRET);
    if (!response.ok || response.headers.get('cache-control') !== 'no-store') throw new Error('Previous Worker does not support authority recovery');
    z.object({ mode: z.literal('maintenance'), sending: z.literal(0), legacyWrites: z.literal(0) }).parse(await response.json());
  }
  const tablesBefore = await checkDatabase(false);
  const owner = crypto.randomUUID();
  let locked = false;
  let leaseLost = false;
  const acquire = async () => {
    const rows = await sql(`INSERT INTO operation_lock(singleton,owner,kind,expires_at) VALUES(1,'${owner}','deploy',unixepoch()+900)
      ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner,kind=excluded.kind,expires_at=excluded.expires_at
      WHERE operation_lock.expires_at<=unixepoch() RETURNING owner`);
    if (rows[0]?.owner !== owner) throw new Error('Operation lease unavailable');
    locked = true;
  };
  const lease = async () => {
    if (leaseLost) throw new Error('Operation lease lost');
    const rows = await sql(`UPDATE operation_lock SET expires_at=unixepoch()+900
      WHERE singleton=1 AND owner='${owner}' AND kind='deploy' AND expires_at>unixepoch() RETURNING owner`);
    if (rows[0]?.owner !== owner) { leaseLost = true; throw new Error('Operation lease lost'); }
  };
  if (tablesBefore.includes('operation_lock')) await acquire();
  try {
  const before = await snapshot(sql, tablesBefore);
  progress.stage = 'checkpoint';
  await writeFile(resolve(directory, 'checkpoint.json'), JSON.stringify({ previousVersion: previous, sha: config.GITHUB_SHA, before }), { mode: 0o600 });
  progress.stage = 'bundle';
  await wrangler(['deploy', '--dry-run']);
  progress.stage = 'migrate';
  // Wrangler submits each migration plus its checkpoint as one D1 transaction.
  // Private copies add a lease assertion inside that same transaction, leaving tracked
  // migrations immutable. Bootstrap 0001–0004 runs before any import endpoint exists.
  const migrationDir = resolve(directory, 'migrations');
  await mkdir(migrationDir, { mode: 0o700 });
  const fence = `INSERT INTO operation_assertions(owner,kind,valid) VALUES('${owner}','deploy',1);`;
  for (const [index, name] of migrations.entries()) {
    const source = await readFile(resolve('worker/migrations', name), 'utf8');
    let wrapped = source;
    if (locked || index > 3) wrapped = `${fence}\n${source}\n${fence}\nDELETE FROM operation_assertions;`;
    else if (index === 3) wrapped = `${source}\nINSERT INTO operation_lock VALUES(1,'${owner}','deploy',unixepoch()+900);\n${fence}\nDELETE FROM operation_assertions;`;
    await writeFile(resolve(migrationDir, name), wrapped, { mode: 0o600 });
  }
  template.d1_databases[0].migrations_dir = migrationDir;
  await writeFile(configPath, JSON.stringify(template), { mode: 0o600 });
  if (locked) await lease();
  await wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
  locked = true;
  progress.stage = 'schema_postcheck';
  const tablesAfter = await checkDatabase(true);
  await lease();
  assertPreserved(before, await snapshot(sql, tablesAfter, before));
  progress.stage = 'drift_check';
  if (await deployment() !== previous) throw new Error('Concurrent deployment detected');
  progress.stage = 'secrets_prepare';
  await writeFile(secretsPath, JSON.stringify({ DIGEST_SERVICE_SECRET: config.DIGEST_SERVICE_SECRET, IMPORT_SERVICE_SECRET: config.IMPORT_SERVICE_SECRET }), { mode: 0o600 });
  let published: string | undefined;
  try {
    progress.stage = 'publish';
    await lease();
    await wrangler(['deploy', '--strict', '--keep-vars', '--secrets-file', secretsPath, '--tag', config.GITHUB_SHA]);
    progress.stage = 'activation_check';
    published = await deployment();
    if (published === previous) throw new Error('New version was not activated');
    progress.stage = 'bindings_check';
    await settings(true);
    progress.stage = 'propagation';
    await propagated(published);
    progress.stage = 'smoke';
    await smoke(published);
    progress.stage = 'schema_final_check';
    await lease();
    await checkDatabase(true);
    assertPreserved(before, await snapshot(sql, tablesAfter, before));
    console.log('Worker release verified; operating mode and data preserved.');
  } catch (error) {
    const failedStage = progress.stage;
    try { await lease(); } catch { throw releaseFailure(failedStage, error, 'manual_reconciliation'); }
    progress.stage = 'rollback';
    // A failed upload may still have activated a version. Only roll back our own SHA.
    const current = await deployment();
    if (current !== previous) {
      const version = z.object({ annotations: z.record(z.string(), z.string()).optional() }).parse(await cloudflare(`${scriptPath}/versions/${current}`));
      if (version.annotations?.['workers/tag'] !== config.GITHUB_SHA || (published && published !== current)) {
        throw releaseFailure(failedStage, error, 'manual_reconciliation');
      }
      await wrangler(['rollback', previous, '--yes', '--message', 'restore previous worker after failed verification']);
      if (await deployment() !== previous) throw new Error('Rollback verification failed');
      await verifyLegacy();
      if (config.WORKER_EXPECTED_MODE === 'maintenance') {
        await propagated(previous);
        const response = await get('/internal/v1/mode', config.DIGEST_SERVICE_SECRET);
        z.object({ mode: z.literal('maintenance'), version: z.literal(previous) }).parse(await response.json());
      }
    }
    throw releaseFailure(failedStage, error, current === previous ? 'previous_retained' : 'previous_restored');
  } finally {
    await unlink(secretsPath).catch(() => { console.error('Private secret-file cleanup failed; remove it before reusing this runner.'); });
  }
  } finally {
    if (locked && !leaseLost) await sql(`DELETE FROM operation_lock WHERE owner='${owner}' AND kind='deploy'`);
  }
}

// Never print provider responses, validation inputs, stack traces or raw exception text.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  deployWorker().catch(error => { console.error(formatReleaseFailure(error)); process.exitCode = 1; });
}
