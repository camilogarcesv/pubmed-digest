import { z } from 'zod';

export const businessTables = [
  'users', 'profile_versions', 'profile_sources', 'destinations', 'articles',
  'digest_runs', 'digest_chunks', 'digest_items', 'user_articles',
  'delivery_messages', 'delivery_resolutions', 'votes', 'data_imports', 'vote_reconciliations',
] as const;
export const migrations = ['0001_multiuser.sql', '0002_draft_guards.sql', '0003_source_order.sql', '0004_operation_lock.sql', '0005_import_sessions.sql', '0006_vote_reconciliations.sql'];
export const operationTables = ['operation_lock', 'operation_assertions', 'import_sessions', 'import_blocks'];
const hexId = z.string().regex(/^[a-f0-9]{32}$/).refine(s => !/^0+$/.test(s));
const uuid = z.uuid().refine(s => s !== '00000000-0000-0000-0000-000000000000');

export function releaseEnvironment(input: NodeJS.ProcessEnv) {
  return z.object({
    CLOUDFLARE_ACCOUNT_ID: hexId,
    CLOUDFLARE_API_TOKEN: z.string().min(20),
    D1_DATABASE_ID: uuid,
    VOTES_KV_ID: hexId,
    WORKER_EXPECTED_VERSION: uuid,
    DIGEST_SERVICE_SECRET: z.string().regex(/^[a-f0-9]{64}$/),
    IMPORT_SERVICE_SECRET: z.string().regex(/^[a-f0-9]{64}$/),
    VOTES_READ_SECRET: z.string().min(16),
    VOTES_URL: z.url().refine(s => {
      const u = new URL(s);
      return u.protocol === 'https:' && u.pathname === '/votes' && !u.username && !u.password && !u.search && !u.hash && !u.port;
    }),
    GITHUB_SHA: z.string().regex(/^[a-f0-9]{40}$/),
    EXPECTED_SHA: z.string().regex(/^[a-f0-9]{40}$/),
    GITHUB_REF: z.literal('refs/heads/main'),
    GITHUB_EVENT_NAME: z.literal('workflow_dispatch'),
    GITHUB_ACTIONS: z.literal('true'),
  }).refine(v => v.GITHUB_SHA === v.EXPECTED_SHA, 'SHA mismatch')
    .refine(v => new Set([v.DIGEST_SERVICE_SECRET, v.IMPORT_SERVICE_SECRET, v.VOTES_READ_SECRET]).size === 3, 'Credentials must differ').parse(input);
}

export function activeVersion(input: unknown): string {
  const deployments = z.array(z.object({ created_on: z.string(), versions: z.array(z.object({
    version_id: uuid, percentage: z.number(),
  })) })).parse(input);
  const latest = deployments.sort((a, b) => b.created_on.localeCompare(a.created_on))[0];
  if (!latest || latest.versions.length !== 1 || latest.versions[0].percentage !== 100) {
    throw new Error('Expected a single fully deployed version');
  }
  return latest.versions[0].version_id;
}

export function assertBindings(input: unknown, kvId: string, databaseId: string, requireD1 = false): void {
  const bindings = z.array(z.object({ name: z.string(), type: z.string(), namespace_id: z.string().optional(), id: z.string().optional() })).parse(input);
  const names = new Set(bindings.map(b => b.name));
  if (names.size !== bindings.length) throw new Error('Duplicate binding');
  const kv = bindings.find(b => b.name === 'VOTES');
  if (kv?.type !== 'kv_namespace' || kv.namespace_id !== kvId) throw new Error('KV binding mismatch');
  for (const name of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'VOTES_READ_SECRET']) {
    if (!bindings.some(b => b.name === name && b.type === 'secret_text')) throw new Error('Legacy secret missing');
  }
  for (const b of bindings) {
    if (b.name === 'DB' && b.type === 'd1' && b.id === databaseId) continue;
    if (b.name === 'VOTES' && b.type === 'kv_namespace') continue;
    if (['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'VOTES_READ_SECRET', 'DIGEST_SERVICE_SECRET', 'IMPORT_SERVICE_SECRET'].includes(b.name) && b.type === 'secret_text') continue;
    throw new Error('Unexpected binding');
  }
  if (requireD1 && (!names.has('DB') || !names.has('DIGEST_SERVICE_SECRET'))) throw new Error('Internal API binding missing');
}

export function assertEmptySchema(tables: string[], counts: number[], mode: unknown, applied: string[], complete: boolean): void {
  const allowed = new Set<string>([...businessTables, ...operationTables, 'system_controls']);
  if (tables.some(t => !allowed.has(t))) throw new Error('Unexpected database table');
  if (counts.length !== tables.length || counts.some(n => !Number.isInteger(n) || n !== 0)) throw new Error('Database contains unexpected data');
  if (applied.some((name, i) => name !== migrations[i])) throw new Error('Unexpected migrations');
  if (tables.includes('system_controls') && mode !== 'legacy') throw new Error('Database is not in legacy mode');
  if (tables.length > 0 && applied.length === 0) throw new Error('Untracked database schema');
  if (complete && (tables.length !== allowed.size || applied.length !== migrations.length || mode !== 'legacy')) {
    throw new Error('Incomplete database schema');
  }
}

export function assertCompatibleSchema(tables: string[], counts: number[], mode: unknown, applied: string[], complete: boolean): void {
  assertEmptySchema(tables, tables.map(() => 0), mode, applied, complete);
  if (counts.length !== tables.length || counts.some(n => !Number.isInteger(n) || n < 0)) throw new Error('Invalid counts');
  if (counts.some(n => n > 0) && !tables.includes('operation_lock')) throw new Error('Populated database lacks fencing');
}
