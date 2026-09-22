import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ImportRepository } from '../multiuser/imports.js';
import { VoteReconciliationRepository } from '../multiuser/reconciliations.js';
import backend from '../multiuser/worker.js';
import { ImportManifest, checksum, counts, type Record } from '../../src/multiuser/import-contracts.js';
import type { CapturedVote } from '../../src/multiuser/vote-reconciliation.js';
import { alice, aliceDestination, profile, timestamp } from './fixtures.js';

const importSecret = 'a'.repeat(64);
const later = '2026-09-20T09:30:00.000Z';
const latest = '2026-09-21T18:05:00.000Z';
const earlier = '2026-09-10T08:00:00.000Z';
const article = (pmid: string): Record => ({ kind: 'article', pmid, title: `Paper ${pmid}`, firstSeen: timestamp, relevance: 8, delivered: true });
const imported = (pmid: string, value: 0 | 1): Record => ({ kind: 'vote', pmid, chatId: '100', value, votedAt: timestamp });
const vote = (pmid: string, value: 0 | 1, votedAt = later, chatId = '100'): CapturedVote => ({ pmid, chatId, value, votedAt });

/** A sealed import for alice: articles 123/456/789 in her ledger, votes on 123 (👍) and 456 (👎). */
async function sealedImport(extra: Record[] = []) {
  const records = [article('123'), article('456'), article('789'), ...extra, imported('123', 1), imported('456', 0)];
  const owner = crypto.randomUUID();
  const imports = new ImportRepository(env.DB);
  const blocks = await Promise.all(records.map(async (r, index) => ({ index, checksum: await checksum([r]), records: [r] })));
  const manifest = ImportManifest.parse({ format: 1, id: crypto.randomUUID(), capturedAt: timestamp, codeSha: 'a'.repeat(40), stateSha: 'b'.repeat(40),
    identity: { id: alice, destinationId: aliceDestination, chatId: '100', email: 'alice@example.test', slug: 'alice', timezone: 'UTC' },
    profile, sources: [{ kind: 'journal', value: 'AJNR' }],
    files: Object.fromEntries(['ledger', 'profile', 'config', 'votes', 'backup', 'identity'].map(k => [k, 'c'.repeat(64)])),
    counts: counts(records), blocks: blocks.map(b => ({ checksum: b.checksum, count: 1 })) });
  await imports.lease(owner);
  await imports.create(owner, manifest);
  for (const block of blocks) await imports.put(owner, manifest.id, block);
  await imports.verify(manifest.id, owner);
  return { owner, manifest, imports, reconciliations: new VoteReconciliationRepository(env.DB) };
}
async function capture(votes: CapturedVote[]) {
  return { format: 1, id: crypto.randomUUID(), capturedAt: latest, codeSha: 'e'.repeat(40), checksum: await checksum(votes), votes };
}
const votesTable = async () => (await env.DB.prepare('SELECT pmid,value,voted_at,source,destination_id FROM votes ORDER BY pmid').all()).results;
const steps = async () => (await env.DB.prepare('SELECT sequence,changes_json FROM vote_reconciliations ORDER BY sequence').all()).results;

describe('legacy vote reconciliation', () => {
  it('plans new, updated, unchanged, unresolved and unmapped votes without writing', async () => {
    const f = await sealedImport();
    const before = await votesTable();
    const plan = await f.reconciliations.plan(alice, await capture([
      vote('123', 1, timestamp), vote('456', 1), vote('789', 1), vote('999', 1), vote('123', 0, later, '200'),
    ]));
    expect(plan.counts).toEqual({ captured: 5, unmapped: 1, new: 1, update: 1, unchanged: 1, unresolved: 1, conflict: 0, d1Only: 0 });
    expect(plan.changes).toEqual([
      { pmid: '456', before: { value: 0, votedAt: timestamp }, after: { value: 1, votedAt: later } },
      { pmid: '789', before: null, after: { value: 1, votedAt: later } },
    ]);
    expect(plan.unresolved).toEqual(['999']);
    expect(await votesTable()).toEqual(before);
    expect(await steps()).toEqual([]);
  });

  it('seals each applied step, converges idempotently and keeps the import verifiable', async () => {
    const f = await sealedImport();
    const first = await capture([vote('123', 1, timestamp), vote('456', 1), vote('789', 1)]);
    expect(await f.reconciliations.apply(f.owner, alice, first)).toMatchObject({ applied: true, sequence: 1, changed: 2, remaining: 0 });
    // Retrying the same capture (unknown outcome) re-plans against D1 and changes nothing.
    expect(await f.reconciliations.apply(f.owner, alice, first)).toMatchObject({ applied: false, changed: 0, remaining: 0 });
    expect(await votesTable()).toEqual([
      { pmid: '123', value: 1, voted_at: timestamp, source: 'legacy_import', destination_id: aliceDestination },
      { pmid: '456', value: 1, voted_at: later, source: 'legacy_import', destination_id: aliceDestination },
      { pmid: '789', value: 1, voted_at: later, source: 'legacy_import', destination_id: aliceDestination },
    ]);

    const second = await capture([vote('123', 0, latest), vote('456', 1), vote('789', 1)]);
    expect(await f.reconciliations.apply(f.owner, alice, second)).toMatchObject({ applied: true, sequence: 2, changed: 1 });
    expect((await steps()).map(s => s.sequence)).toEqual([1, 2]);
    // The 2.3a acceptance check still verifies the import exactly, beneath both steps.
    expect(await f.imports.verify(f.manifest.id)).toMatchObject({ verified: true, counts: f.manifest.counts });
    expect(await f.reconciliations.verify(alice)).toEqual({ verified: true, reconciliations: 2, votes: 3 });
  });

  it.each([false, true])('refuses to extend unexplained D1 state (prior step: %s)', async priorStep => {
    const f = await sealedImport();
    if (priorStep) await f.reconciliations.apply(f.owner, alice, await capture([vote('123', 1, timestamp), vote('456', 1)]));
    await env.DB.prepare("UPDATE votes SET value=0 WHERE pmid='123'").run();
    const before = await votesTable(), checkpoints = await steps();
    await expect(f.reconciliations.apply(f.owner, alice, await capture([vote('123', 1, latest), vote('456', 1, latest), vote('789', 1)]))).rejects.toThrow();
    expect(await votesTable()).toEqual(before);
    expect(await steps()).toEqual(checkpoints);
  });

  it('rejects changed destination settings before writing votes', async () => {
    const f = await sealedImport();
    await env.DB.prepare("UPDATE destinations SET status='active' WHERE id=?").bind(aliceDestination).run();
    await expect(f.reconciliations.apply(f.owner, alice, await capture([vote('123', 1, timestamp), vote('456', 1)]))).rejects.toThrow();
    expect(await steps()).toEqual([]);
  });

  it('binds a capture identity to its original contents and metadata, including no-op retries', async () => {
    const f = await sealedImport();
    const first = await capture([vote('123', 1, timestamp), vote('456', 1)]);
    await f.reconciliations.apply(f.owner, alice, first);
    const before = await votesTable();
    const changed = await capture([vote('123', 0, latest), vote('456', 1)]);
    for (const altered of [{ ...changed, id: first.id }, { ...first, capturedAt: later }, { ...first, codeSha: 'f'.repeat(40) }]) {
      await expect(f.reconciliations.apply(f.owner, alice, altered)).rejects.toThrow();
    }
    expect(await votesTable()).toEqual(before);
    expect(await steps()).toHaveLength(1);
  });

  it('commits simultaneous retries at most once', async () => {
    const f = await sealedImport();
    const input = await capture([vote('123', 1, timestamp), vote('456', 1), vote('789', 1)]);
    const results = await Promise.allSettled([f.reconciliations.apply(f.owner, alice, input), f.reconciliations.apply(f.owner, alice, input)]);
    expect(results.some(r => r.status === 'fulfilled' && r.value.applied)).toBe(true);
    expect(await steps()).toHaveLength(1);
    expect(await f.reconciliations.verify(alice)).toMatchObject({ verified: true, reconciliations: 1 });
  });

  it('splits a large capture into bounded steps that stay within D1 Free query limits', async () => {
    const pmids = Array.from({ length: 30 }, (_, i) => String(1000 + i));
    const f = await sealedImport(pmids.map(article));
    const big = await capture([vote('123', 1, timestamp), vote('456', 0, timestamp), ...pmids.map(p => vote(p, 1))]);
    let queries = 0;
    const instrument = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, prop) {
      if (prop === 'bind') return (...args: unknown[]) => instrument(target.bind(...args));
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { queries++; return value.apply(target, args); };
    } });
    const counted = new Proxy(env.DB, { get(target, prop) {
      if (prop === 'prepare') return (sql: string) => instrument(target.prepare(sql));
      if (prop === 'batch') return (statements: D1PreparedStatement[]) => { queries += statements.length; return target.batch(statements); };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(await new VoteReconciliationRepository(counted).apply(f.owner, alice, big)).toMatchObject({ sequence: 1, changed: 20, remaining: 10 });
    expect(queries).toBe(43);
    expect(await f.reconciliations.apply(f.owner, alice, big)).toMatchObject({ sequence: 2, changed: 10, remaining: 0 });
    expect(await f.reconciliations.verify(alice)).toEqual({ verified: true, reconciliations: 2, votes: 32 });
  });

  it.each([
    ['a contradicting vote with the same timestamp', [vote('123', 0, timestamp), vote('456', 0, timestamp)]],
    ['a capture older than D1', [vote('123', 1, earlier), vote('456', 0, timestamp)]],
    ['a vote D1 has and the capture lacks', [vote('123', 1, timestamp)]],
  ])('refuses %s without writing anything', async (_case, votes) => {
    const f = await sealedImport();
    const before = await votesTable();
    const input = await capture([...votes, vote('789', 1)]);
    const plan = await f.reconciliations.plan(alice, input);
    expect(plan.counts.conflict + plan.counts.d1Only).toBe(1);
    await expect(f.reconciliations.apply(f.owner, alice, input)).rejects.toThrow('Vote reconciliation conflict');
    expect(await votesTable()).toEqual(before);
    expect(await steps()).toEqual([]);
  });

  it('rejects a capture whose votes do not match its checksum', async () => {
    const f = await sealedImport();
    const input = await capture([vote('123', 1, timestamp), vote('456', 0, timestamp)]);
    await expect(f.reconciliations.apply(f.owner, alice, { ...input, votes: [vote('123', 1, timestamp), vote('456', 1)] })).rejects.toThrow('Vote reconciliation conflict');
    expect(await steps()).toEqual([]);
  });

  it('requires the live import lease, legacy mode, a paused user and a sealed import', async () => {
    const f = await sealedImport();
    const input = await capture([vote('123', 1, timestamp), vote('456', 0, timestamp), vote('789', 1)]);
    await expect(f.reconciliations.apply(crypto.randomUUID(), alice, input)).rejects.toThrow();
    await env.DB.prepare("UPDATE system_controls SET mode='maintenance'").run();
    await expect(f.reconciliations.apply(f.owner, alice, input)).rejects.toThrow();
    await env.DB.prepare("UPDATE system_controls SET mode='legacy'").run();
    await env.DB.prepare("UPDATE users SET status='active'").run();
    await expect(f.reconciliations.apply(f.owner, alice, input)).rejects.toThrow();
    await env.DB.prepare("UPDATE users SET status='paused'").run();
    await env.DB.prepare('DELETE FROM operation_lock').run();
    await expect(f.reconciliations.apply(f.owner, alice, input)).rejects.toThrow();
    expect(await steps()).toEqual([]);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM operation_assertions').first('n'))).toBe(0);
  });

  it('aborts a step when the votes change between planning and writing', async () => {
    const f = await sealedImport();
    let raced = false;
    const racing = new Proxy(env.DB, { get(target, prop) {
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (!raced && statements.length === 4) {
            raced = true;
            await target.prepare("UPDATE votes SET voted_at=? WHERE pmid='123'").bind(later).run();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const input = await capture([vote('123', 1, timestamp), vote('456', 0, timestamp), vote('789', 1)]);
    await expect(new VoteReconciliationRepository(racing).apply(f.owner, alice, input)).rejects.toThrow('Vote reconciliation conflict');
    expect(await steps()).toEqual([]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM votes WHERE pmid='789'").first('n')).toBe(0);
  });

  it('detects edited votes, immutable steps and a broken chain', async () => {
    const f = await sealedImport();
    await f.reconciliations.apply(f.owner, alice, await capture([vote('123', 1, timestamp), vote('456', 1), vote('789', 1)]));
    await f.reconciliations.apply(f.owner, alice, await capture([vote('123', 1, timestamp), vote('456', 0, latest), vote('789', 1)]));
    await expect(env.DB.prepare("UPDATE vote_reconciliations SET changes_json='[]'").run()).rejects.toThrow('reconciliation immutable');

    await env.DB.prepare("UPDATE votes SET value=0 WHERE pmid='789'").run();
    await expect(f.reconciliations.verify(alice)).rejects.toThrow();
    await expect(f.imports.verify(f.manifest.id)).rejects.toThrow();
    await env.DB.prepare("UPDATE votes SET value=1 WHERE pmid='789'").run();
    expect(await f.reconciliations.verify(alice)).toMatchObject({ verified: true });

    await env.DB.prepare('DELETE FROM vote_reconciliations WHERE sequence=1').run();
    await expect(f.reconciliations.verify(alice)).rejects.toThrow();
    await expect(f.imports.verify(f.manifest.id)).rejects.toThrow();
  });
});

describe('reconciliation routes', () => {
  const call = (path: string, credential: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => backend.fetch(
    new Request(`https://test/internal/v1/imports/users/${alice}/vote-reconciliations${path}`, { method,
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
    { ...env, IMPORT_SERVICE_SECRET: importSecret, VOTES_READ_SECRET: 'read-only', TELEGRAM_WEBHOOK_SECRET: 'telegram' });

  it('require the import credential and never leak details in errors', async () => {
    const f = await sealedImport();
    const input = await capture([vote('123', 1, timestamp), vote('456', 0, timestamp), vote('789', 1)]);
    for (const credential of ['synthetic-test-secret-only', 'read-only', 'telegram', 'wrong']) {
      expect((await call('/plan', credential, { capture: input })).status).toBe(401);
    }
    const plan = await call('/plan', importSecret, { capture: input });
    expect(plan.status).toBe(200);
    expect(plan.headers.get('cache-control')).toBe('no-store');
    expect(((await plan.json()) as { counts: { new: number } }).counts.new).toBe(1);

    expect((await call('', importSecret, { capture: input })).status).toBe(400); // owner required
    const conflicting = await call('', importSecret, { owner: f.owner, capture: await capture([vote('123', 1, timestamp)]) });
    expect(conflicting.status).toBe(409);
    expect(await conflicting.text()).not.toMatch(/123|alice|100/);

    expect(await (await call('', importSecret, { owner: f.owner, capture: input })).json()).toMatchObject({ applied: true, changed: 1 });
    expect(await (await call('/verify', importSecret)).json()).toEqual({ verified: true, reconciliations: 1, votes: 3 });
    expect((await call('/unknown', importSecret)).status).toBe(404);
  });
});
