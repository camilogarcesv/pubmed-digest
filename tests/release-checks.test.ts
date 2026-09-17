import { describe, expect, it } from 'vitest';
import { activeVersion, assertBindings, assertEmptySchema, businessTables, migrations, releaseEnvironment } from '../src/operations/release-checks.js';

const releaseEnv = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-api-token-only',
  D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111', VOTES_KV_ID: 'b'.repeat(32),
  WORKER_EXPECTED_VERSION: '22222222-2222-4222-8222-222222222222',
  DIGEST_SERVICE_SECRET: 'c'.repeat(64), VOTES_READ_SECRET: 'synthetic-export-secret',
  VOTES_URL: 'https://pubmed-digest.test.workers.dev/votes',
  GITHUB_SHA: 'd'.repeat(40), EXPECTED_SHA: 'd'.repeat(40), GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_ACTIONS: 'true',
};
const legacyBindings = [
  { name: 'VOTES', type: 'kv_namespace', namespace_id: releaseEnv.VOTES_KV_ID },
  ...['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'VOTES_READ_SECRET'].map(name => ({ name, type: 'secret_text' })),
];

describe('release safety gates', () => {
  it('requires a manual main SHA and explicit non-placeholder resource identifiers', () => {
    expect(releaseEnvironment(releaseEnv).GITHUB_SHA).toBe(releaseEnv.GITHUB_SHA);
    for (const change of [
      { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'pull_request' },
      { EXPECTED_SHA: 'e'.repeat(40) }, { GITHUB_ACTIONS: 'false' },
      { D1_DATABASE_ID: '00000000-0000-0000-0000-000000000000' }, { CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32) },
      { VOTES_KV_ID: '' }, { CLOUDFLARE_API_TOKEN: '' }, { WORKER_EXPECTED_VERSION: '' },
      { VOTES_URL: 'http://example.test/votes' }, { VOTES_URL: 'https://example.test/votes?token=secret' },
      { VOTES_READ_SECRET: releaseEnv.DIGEST_SERVICE_SECRET },
    ]) expect(() => releaseEnvironment({ ...releaseEnv, ...change })).toThrow();
  });
  it('rejects missing, split or malformed deployment state and chooses latest version', () => {
    const latest = { created_on: '2026-09-15', versions: [{ version_id: releaseEnv.WORKER_EXPECTED_VERSION, percentage: 100 }] };
    expect(activeVersion([latest, { ...latest, created_on: '2026-09-01' }])).toBe(releaseEnv.WORKER_EXPECTED_VERSION);
    for (const invalid of [[], [{}], [{ ...latest, versions: [] }], [{ ...latest, versions: [{ ...latest.versions[0], percentage: 50 }] }]]) {
      expect(() => activeVersion(invalid)).toThrow();
    }
  });
  it('checks KV, all legacy secret bindings and the exact D1 binding', () => {
    const check = (bindings: unknown, ready = false) => assertBindings(bindings, releaseEnv.VOTES_KV_ID, releaseEnv.D1_DATABASE_ID, ready);
    expect(() => check(legacyBindings)).not.toThrow();
    expect(() => check(legacyBindings, true)).toThrow();
    expect(() => check(legacyBindings.slice(1))).toThrow();
    expect(() => check([...legacyBindings, { name: 'OTHER', type: 'plain_text' }])).toThrow();
    expect(() => check([...legacyBindings, { name: 'DB', type: 'd1', id: 'wrong' }])).toThrow();
    expect(() => check([...legacyBindings, legacyBindings[0]])).toThrow();
    expect(() => check([...legacyBindings, { name: 'DB', type: 'd1', id: releaseEnv.D1_DATABASE_ID },
      { name: 'DIGEST_SERVICE_SECRET', type: 'secret_text' }], true)).not.toThrow();
  });
  it('allows only an empty or tracked partial schema before migration, complete empty legacy after', () => {
    expect(() => assertEmptySchema([], [], undefined, [], false)).not.toThrow();
    const tables = [...businessTables, 'system_controls'];
    const counts = tables.map(() => 0);
    expect(() => assertEmptySchema(tables, counts, 'legacy', migrations, true)).not.toThrow();
    expect(() => assertEmptySchema(tables, counts, 'legacy', migrations.slice(0, 1), false)).not.toThrow();
    expect(() => assertEmptySchema(tables, counts, 'legacy', migrations.slice(0, 1), true)).toThrow();
    expect(() => assertEmptySchema(tables, [1, ...counts.slice(1)], 'legacy', migrations, true)).toThrow();
    expect(() => assertEmptySchema(tables, counts, 'd1', migrations, true)).toThrow();
    expect(() => assertEmptySchema(tables, counts, 'legacy', [], false)).toThrow();
    expect(() => assertEmptySchema(['unexpected'], [0], 'legacy', migrations, false)).toThrow();
    expect(() => assertEmptySchema(tables, counts, 'legacy', [...migrations, 'future.sql'], true)).toThrow();
  });
});
