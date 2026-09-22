import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ImportRepository } from '../multiuser/imports.js';
import { LedgerExtensionRepository } from '../multiuser/ledger-extensions.js';
import { VoteReconciliationRepository } from '../multiuser/reconciliations.js';
import backend from '../multiuser/worker.js';
import { ImportManifest, checksum, counts } from '../../src/multiuser/import-contracts.js';
import { articleHash, buildLedgerExtension, type LedgerArticle } from '../../src/multiuser/ledger-extension.js';
import { alice, bob, aliceDestination, profile, timestamp } from './fixtures.js';

const later = '2026-09-22T04:00:00.000Z';
const article = (pmid: string, title: string | null = null): LedgerArticle => ({ kind: 'article', pmid, title, firstSeen: timestamp, relevance: 0, delivered: true });
async function fixture() {
  const owner = crypto.randomUUID(), imports = new ImportRepository(env.DB), repository = new LedgerExtensionRepository(env.DB);
  const records = [article('123', 'Original')];
  const manifest = ImportManifest.parse({ format: 1, id: crypto.randomUUID(), capturedAt: timestamp, codeSha: 'a'.repeat(40), stateSha: 'b'.repeat(40),
    identity: { id: alice, destinationId: aliceDestination, chatId: '100', email: 'alice@example.test', slug: 'alice', timezone: 'UTC' },
    profile, sources: [], files: Object.fromEntries(['ledger', 'profile', 'config', 'votes', 'backup', 'identity'].map(k => [k, 'c'.repeat(64)])),
    counts: counts(records), blocks: [{ checksum: await checksum(records), count: 1 }] });
  await imports.lease(owner); await imports.create(owner, manifest);
  await imports.put(owner, manifest.id, { index: 0, checksum: await checksum(records), records });
  await imports.verify(manifest.id, owner);
  const prepare = async (additions: LedgerArticle[], capturedAt = later) => {
    const before = (await repository.snapshot(alice)).records;
    return buildLedgerExtension(before, [...before, ...additions], { id: crypto.randomUUID(), userId: alice, capturedAt, codeSha: 'e'.repeat(40), stateSha: (await checksum(additions)).slice(0, 40), ledgerChecksum: 'd'.repeat(64), backupChecksum: 'b'.repeat(64) });
  };
  return { owner, imports, repository, manifest, prepare };
}
const totals = async () => env.DB.prepare(`SELECT (SELECT count(*) FROM articles) AS articles,(SELECT count(*) FROM ledger_extension_blocks) AS blocks,(SELECT count(*) FROM data_imports) AS provenance`).first();

describe('verifiable ledger additions', () => {
  it('resumes partial blocks, seals exactly once and preserves original and later verification', async () => {
    const f = await fixture();
    const data = await f.prepare(Array.from({ length: 13 }, (_, i) => article(String(1000 + i), i % 2 ? '' : null)));
    await f.repository.create(f.owner, alice, data.manifest);
    await f.repository.put(f.owner, alice, data.manifest.id, data.blocks[0]);
    expect(await f.imports.verify(f.manifest.id)).toMatchObject({ verified: true, counts: f.manifest.counts });
    await expect(f.repository.finalize(f.owner, alice, data.manifest.id)).rejects.toThrow();
    await f.imports.release(f.owner);
    const resumed = crypto.randomUUID(); await f.imports.lease(resumed);
    await f.repository.put(resumed, alice, data.manifest.id, data.blocks[0]);
    await f.repository.put(resumed, alice, data.manifest.id, data.blocks[1]);
    await f.repository.finalize(resumed, alice, data.manifest.id);
    const before = await totals();
    await f.repository.create(resumed, alice, data.manifest);
    for (const b of data.blocks) await f.repository.put(resumed, alice, data.manifest.id, b);
    await f.repository.finalize(resumed, alice, data.manifest.id);
    expect(await totals()).toEqual(before);
    expect((await f.repository.snapshot(alice)).checksum).toBe(data.manifest.afterHash);
    expect(await env.DB.prepare('SELECT relevance,delivered_at,legacy_title FROM user_articles WHERE pmid=?').bind('1000').first()).toEqual({ relevance: 0, delivered_at: null, legacy_title: null });
    expect(await env.DB.prepare('SELECT legacy_title FROM user_articles WHERE pmid=?').bind('1001').first('legacy_title')).toBe('');
    expect(await new VoteReconciliationRepository(env.DB).verify(alice)).toMatchObject({ verified: true, votes: 0 });
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM digest_runs').first('n'))).toBe(0);
  });

  it('verifies multiple sealed extensions and votes on the added articles', async () => {
    const f = await fixture();
    for (const pmid of ['456', '789']) {
      const data = await f.prepare([article(pmid)]);
      await f.repository.create(f.owner, alice, data.manifest);
      await f.repository.put(f.owner, alice, data.manifest.id, data.blocks[0]);
      const votes = [{ pmid: '456', chatId: '100', value: 1, votedAt: later }];
      const capture = { format: 1, id: crypto.randomUUID(), codeSha: 'f'.repeat(40), capturedAt: later, checksum: await checksum(votes), votes };
      const reconciliations = new VoteReconciliationRepository(env.DB);
      if (pmid === '456') await expect(reconciliations.apply(f.owner, alice, capture)).rejects.toThrow();
      await f.repository.finalize(f.owner, alice, data.manifest.id);
      if (pmid === '456') expect(await reconciliations.apply(f.owner, alice, capture)).toMatchObject({ changed: 1 });
    }
    expect(await f.imports.verify(f.manifest.id)).toMatchObject({ verified: true });
    expect(await new VoteReconciliationRepository(env.DB).verify(alice)).toMatchObject({ verified: true, votes: 1 });
    expect((await f.repository.snapshot(alice)).records).toHaveLength(3);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM data_imports').first('n')).toBe(5);
  });

  it('rejects stale baselines, changed identities, wrong users and concurrent open sessions', async () => {
    const f = await fixture(), data = await f.prepare([article('456')]);
    await expect(f.repository.create(f.owner, bob, data.manifest)).rejects.toThrow();
    await expect(f.repository.create(f.owner, alice, { ...data.manifest, beforeHash: '0'.repeat(64) })).rejects.toThrow();
    await f.repository.create(f.owner, alice, data.manifest);
    await expect(f.repository.create(f.owner, alice, { ...data.manifest, codeSha: '0'.repeat(40) })).rejects.toThrow();
    await expect(f.repository.create(f.owner, alice, { ...data.manifest, id: crypto.randomUUID() })).rejects.toThrow();
    await expect(f.repository.status(bob, data.manifest.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.repository.put(f.owner, bob, data.manifest.id, data.blocks[0])).rejects.toThrow();
    expect(await totals()).toEqual({ articles: 1, blocks: 0, provenance: 3 });
  });

  it('rejects reordered and altered blocks and a wrong final hash before committing', async () => {
    const f = await fixture(), data = await f.prepare(Array.from({ length: 11 }, (_, i) => article(String(1000 + i))));
    await f.repository.create(f.owner, alice, { ...data.manifest, afterHash: '0'.repeat(64) });
    await expect(f.repository.put(f.owner, alice, data.manifest.id, data.blocks[1])).rejects.toThrow();
    await expect(f.repository.put(f.owner, alice, data.manifest.id, { ...data.blocks[0], records: [article('999')] })).rejects.toThrow();
    await f.repository.put(f.owner, alice, data.manifest.id, data.blocks[0]);
    await expect(f.repository.put(f.owner, alice, data.manifest.id, data.blocks[1])).rejects.toThrow();
    expect(await totals()).toEqual({ articles: 11, blocks: 1, provenance: 3 });
    expect(await f.imports.verify(f.manifest.id)).toMatchObject({ verified: true });
  });

  it('requires a live lease, paused user and legacy mode', async () => {
    const f = await fixture(), data = await f.prepare([article('456')]);
    await expect(f.repository.create(crypto.randomUUID(), alice, data.manifest)).rejects.toThrow();
    await f.repository.create(f.owner, alice, data.manifest);
    for (const sql of ["UPDATE system_controls SET mode='maintenance'", "UPDATE users SET status='active'", 'UPDATE operation_lock SET expires_at=0']) {
      await env.DB.prepare(sql).run();
      await expect(f.repository.put(f.owner, alice, data.manifest.id, data.blocks[0])).rejects.toThrow();
      await env.DB.prepare("UPDATE system_controls SET mode='legacy'").run();
      await env.DB.prepare("UPDATE users SET status='paused'").run();
    }
    expect(await totals()).toEqual({ articles: 1, blocks: 0, provenance: 3 });
  });

  it('rolls back the whole block after a mid-batch insertion failure', async () => {
    const f = await fixture(), data = await f.prepare([article('456'), article('789')]);
    await f.repository.create(f.owner, alice, data.manifest);
    await env.DB.prepare('INSERT INTO articles VALUES(?,?,NULL,NULL,?)').bind('789', 'Other global article', timestamp).run();
    await expect(f.repository.put(f.owner, alice, data.manifest.id, data.blocks[0])).rejects.toThrow();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM articles WHERE pmid='456'").first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM ledger_extension_blocks').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM operation_assertions').first('n')).toBe(0);
  });

  it('makes simultaneous retries idempotent and detects subsequent corruption', async () => {
    const f = await fixture(), data = await f.prepare([article('456')]);
    await f.repository.create(f.owner, alice, data.manifest);
    await Promise.all([f.repository.put(f.owner, alice, data.manifest.id, data.blocks[0]), f.repository.put(f.owner, alice, data.manifest.id, data.blocks[0])]);
    await f.repository.finalize(f.owner, alice, data.manifest.id);
    expect(await totals()).toEqual({ articles: 2, blocks: 1, provenance: 4 });
    await expect(env.DB.prepare("UPDATE ledger_extension_blocks SET records_json='[]'").run()).rejects.toThrow('immutable');
    await expect(env.DB.prepare("UPDATE ledger_extensions SET manifest_hash=?").bind('a'.repeat(64)).run()).rejects.toThrow();
    await env.DB.prepare("UPDATE user_articles SET relevance=1 WHERE pmid='456'").run();
    await expect(f.imports.verify(f.manifest.id)).rejects.toThrow();
    await env.DB.prepare("UPDATE user_articles SET relevance=0 WHERE pmid='456'").run();
    expect(await f.imports.verify(f.manifest.id)).toMatchObject({ verified: true });
    await env.DB.prepare('DELETE FROM ledger_extension_blocks').run();
    await expect(f.imports.verify(f.manifest.id)).rejects.toThrow();
  });

  it.each(['create', 'put', 'finalize'] as const)('fences the exact verified snapshot during %s', async operation => {
    const f = await fixture(), data = await f.prepare([article('456')]);
    if (operation !== 'create') await f.repository.create(f.owner, alice, data.manifest);
    if (operation === 'finalize') await f.repository.put(f.owner, alice, data.manifest.id, data.blocks[0]);
    let altered = false;
    const racing = new Proxy(env.DB, { get(target, prop) {
      if (prop === 'batch') return async (statements: D1PreparedStatement[]) => {
        // Verification uses batches of six and two SELECTs; each mutation has 3, 4 or 5 statements.
        if (!altered && [3, 4, 5].includes(statements.length)) {
          altered = true;
          await target.prepare("UPDATE articles SET metadata_json='{}' WHERE pmid='123'").run();
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const repository = new LedgerExtensionRepository(racing), before = await totals();
    await expect(operation === 'create' ? repository.create(f.owner, alice, data.manifest)
      : operation === 'put' ? repository.put(f.owner, alice, data.manifest.id, data.blocks[0])
        : repository.finalize(f.owner, alice, data.manifest.id)).rejects.toThrow();
    expect(altered).toBe(true);
    expect(await totals()).toEqual(before);
    if (operation !== 'create') expect((await f.repository.status(alice, data.manifest.id)).status).toBe('open');
  });

  it.each(['provenance', 'history'] as const)('fences verified %s before sealing', async mutation => {
    const f = await fixture(), data = await f.prepare([article('456')]);
    await f.repository.create(f.owner, alice, data.manifest);
    await f.repository.put(f.owner, alice, data.manifest.id, data.blocks[0]);
    const racing = new Proxy(env.DB, { get(target, prop) {
      if (prop === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (statements.length === 4) await target.prepare(mutation === 'provenance'
          ? "UPDATE data_imports SET checksum='0000000000000000000000000000000000000000000000000000000000000000'"
          : 'DELETE FROM ledger_extension_blocks').run();
        return target.batch(statements);
      };
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(new LedgerExtensionRepository(racing).finalize(f.owner, alice, data.manifest.id)).rejects.toThrow();
    expect((await f.repository.status(alice, data.manifest.id)).status).toBe('open');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM data_imports').first('n')).toBe(3);
  });

  it('does not verify absent or incomplete extensions, and verifies sealed history after later additions', async () => {
    const f = await fixture(), first = await f.prepare([article('456')]);
    await expect(f.repository.verify(alice, first.manifest.id)).rejects.toThrow();
    await f.repository.create(f.owner, alice, first.manifest);
    await expect(f.repository.verify(alice, first.manifest.id)).rejects.toThrow();
    await f.repository.put(f.owner, alice, first.manifest.id, first.blocks[0]);
    await expect(f.repository.verify(alice, first.manifest.id)).rejects.toThrow();
    await f.repository.finalize(f.owner, alice, first.manifest.id);
    const second = await f.prepare([article('789')]);
    await f.repository.create(f.owner, alice, second.manifest);
    await f.repository.put(f.owner, alice, second.manifest.id, second.blocks[0]);
    await f.repository.finalize(f.owner, alice, second.manifest.id);
    expect(await f.repository.verify(alice, first.manifest.id)).toMatchObject({ verified: true, finalized: true, manifestHash: await checksum(first.manifest), articles: 3 });
    const repeatedSha = await f.prepare([article('999')]);
    await expect(f.repository.create(f.owner, alice, { ...repeatedSha.manifest, stateSha: first.manifest.stateSha })).rejects.toThrow();
  });

  it('bounds D1 queries for a full ten-article block', async () => {
    const f = await fixture(), data = await f.prepare(Array.from({ length: 10 }, (_, i) => article(String(1000 + i))));
    await f.repository.create(f.owner, alice, data.manifest);
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
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await new LedgerExtensionRepository(counted).put(f.owner, alice, data.manifest.id, data.blocks[0]);
    expect(queries).toBeLessThanOrEqual(50);
    expect((await f.repository.snapshot(alice)).checksum).toBe(await articleHash([article('123', 'Original'), ...data.blocks[0].records]));
  });
});

describe('ledger extension routes', () => {
  it('isolates credentials and keeps errors private', async () => {
    const f = await fixture(), data = await f.prepare([article('456')]), secret = 'd'.repeat(64);
    const call = (credential: string, path: string, body?: unknown) => backend.fetch(new Request(`https://test/internal/v1/imports/users/${alice}/${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    }), { ...env, IMPORT_SERVICE_SECRET: secret, VOTES_READ_SECRET: 'readonly', TELEGRAM_WEBHOOK_SECRET: 'telegram' });
    for (const credential of ['synthetic-test-secret-only', 'readonly', 'telegram', '']) {
      expect((await call(credential, 'ledger')).status).toBe(401);
      expect((await call(credential, 'ledger-extensions', { owner: f.owner, manifest: data.manifest })).status).toBe(401);
    }
    const snapshot = await call(secret, 'ledger');
    expect(snapshot.status).toBe(200); expect(snapshot.headers.get('cache-control')).toBe('no-store');
    expect((await call(secret, 'ledger-extensions', {})).status).toBe(400);
    expect((await call(secret, 'ledger-extensions', { owner: f.owner, manifest: data.manifest })).status).toBe(200);
    const path = `ledger-extensions/${data.manifest.id}`;
    expect((await call(secret, `${path}/blocks`, { owner: f.owner, block: data.blocks[0] })).status).toBe(200);
    expect((await call(secret, `${path}/finalize`, { owner: f.owner })).status).toBe(200);
    expect((await call(secret, path)).status).toBe(200);
  });
});
