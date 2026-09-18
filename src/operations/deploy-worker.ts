import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { activeVersion, assertBindings, assertEmptySchema, releaseEnvironment } from './release-checks.js';
import { commandFailure, formatReleaseFailure, ProviderFailure, ReleaseFailure, releaseFailure, type ReleaseStage } from './release-diagnostics.js';

const exec = promisify(execFile);

// This entrypoint is intentionally limited to the initial, empty-D1 release.
// Capture provider output privately: CLI errors may contain identifiers or credentials.
type Runtime = {
  command?: (args: string[]) => Promise<string>;
  fetch?: typeof fetch;
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
    assertEmptySchema(tables, tables.map(() => 0), 'legacy', tables.length ? ['0001_multiuser.sql'] : [], false);
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
    assertEmptySchema(tables, counts, mode, applied, complete);
    if ((await sql('PRAGMA foreign_key_check')).length !== 0) throw new Error('Foreign key check failed');
  };
  const origin = new URL(config.VOTES_URL).origin;
  const get = async (path: string, secret?: string, body?: unknown) => (runtime.fetch ?? fetch)(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  const verifyLegacy = async () => {
    const response = await get('/votes', config.VOTES_READ_SECRET);
    if (response.status !== 200) throw new Error('Legacy export failed');
    z.object({ votes: z.array(z.object({ pmid: z.string(), value: z.union([z.literal(0), z.literal(1)]), chatId: z.string(), votedAt: z.string() })) }).parse(await response.json());
  };
  const smoke = async () => {
    for (const path of ['/internal/v1/mode', '/internal/v1/contexts']) {
      for (const secret of [undefined, config.VOTES_READ_SECRET]) {
        if ((await get(path, secret)).status !== 401) throw new Error('Internal auth smoke failed');
      }
      const response = await get(path, config.DIGEST_SERVICE_SECRET);
      if (response.status !== 200 || response.headers.get('cache-control') !== 'no-store') throw new Error('Internal API smoke failed');
      const body: unknown = await response.json();
      if (path.endsWith('/mode')) z.object({ mode: z.literal('legacy') }).strict().parse(body);
      else z.object({ users: z.array(z.unknown()).length(0) }).strict().parse(body);
    }
    const probeUser = crypto.randomUUID();
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
  await checkDatabase(false);
  progress.stage = 'checkpoint';
  await writeFile(resolve(directory, 'checkpoint.json'), JSON.stringify({ previousVersion: previous, sha: config.GITHUB_SHA }), { mode: 0o600 });
  progress.stage = 'bundle';
  await wrangler(['deploy', '--dry-run']);
  progress.stage = 'migrate';
  await wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
  progress.stage = 'schema_postcheck';
  await checkDatabase(true);
  progress.stage = 'drift_check';
  if (await deployment() !== previous) throw new Error('Concurrent deployment detected');
  progress.stage = 'secrets_prepare';
  await writeFile(secretsPath, JSON.stringify({ DIGEST_SERVICE_SECRET: config.DIGEST_SERVICE_SECRET }), { mode: 0o600 });
  let published: string | undefined;
  try {
    progress.stage = 'publish';
    await wrangler(['deploy', '--strict', '--keep-vars', '--secrets-file', secretsPath, '--tag', config.GITHUB_SHA]);
    progress.stage = 'activation_check';
    published = await deployment();
    if (published === previous) throw new Error('New version was not activated');
    progress.stage = 'bindings_check';
    await settings(true);
    progress.stage = 'smoke';
    await smoke();
    progress.stage = 'schema_final_check';
    await checkDatabase(true);
    console.log('Worker release verified; legacy operation preserved.');
  } catch (error) {
    const failedStage = progress.stage;
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
    }
    throw releaseFailure(failedStage, error, current === previous ? 'previous_retained' : 'previous_restored');
  } finally {
    await unlink(secretsPath).catch(() => { console.error('Private secret-file cleanup failed; remove it before reusing this runner.'); });
  }
}

// Never print provider responses, validation inputs, stack traces or raw exception text.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  deployWorker().catch(error => { console.error(formatReleaseFailure(error)); process.exitCode = 1; });
}
