import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { ImportRepository } from '../multiuser/imports.js';
import backend from '../multiuser/worker.js';
import { D1DigestRepository } from '../multiuser/repository.js';
import { ImportManifest, checksum, counts, type Record } from '../../src/multiuser/import-contracts.js';
import { computeEvalMetrics } from '../../src/votes.js';
import { alice, aliceDestination, bob, profile, timestamp } from './fixtures.js';

const secret = 'a'.repeat(64);
const article: Record = { kind: 'article', pmid: '123', title: '', firstSeen: timestamp, relevance: 0, delivered: true };
const vote: Record = { kind: 'vote', pmid: '123', chatId: '100', value: 1, votedAt: timestamp };
async function fixture(records: Record[] = [article, vote]) {
  const owner = crypto.randomUUID();
  const repository = new ImportRepository(env.DB);
  const blocks = await Promise.all(records.map(async r => ({ index: records.indexOf(r), checksum: await checksum([r]), records: [r] })));
  const manifest = ImportManifest.parse({ format: 1, id: crypto.randomUUID(), identity: { id: alice, destinationId: aliceDestination, chatId: '100', email: 'alice@example.test', slug: 'alice', timezone: 'UTC' }, capturedAt: timestamp,
    codeSha: 'a'.repeat(40), stateSha: 'b'.repeat(40), profile, sources: [{ kind: 'journal', value: 'AJNR' }, { kind: 'query', value: 'MRI' }],
    files: Object.fromEntries(['ledger', 'profile', 'config', 'votes', 'backup', 'identity'].map(k => [k, 'c'.repeat(64)])),
    counts: counts(records), blocks: blocks.map(b => ({ checksum: b.checksum, count: b.records.length })) });
  await repository.lease(owner);
  return { repository, owner, manifest, blocks };
}
async function populated() {
  const f = await fixture();
  await f.repository.create(f.owner, f.manifest);
  for (const b of f.blocks) await f.repository.put(f.owner, f.manifest.id, b);
  return f;
}
const api = (path: string, credential = secret, body?: unknown, method = body === undefined ? 'GET' : 'POST') => backend.fetch(new Request(`https://test/internal/v1/imports${path}`, {
  method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
}), { ...env, IMPORT_SERVICE_SECRET: secret, VOTES_READ_SECRET: 'read-only', TELEGRAM_WEBHOOK_SECRET: 'telegram' });

describe('atomic legacy import', () => {
  it('preserves zero, empty titles and unknown dates, seals provenance and leaves contexts empty', async () => {
    const f = await populated();
    expect(await f.repository.verify(f.manifest.id, f.owner)).toMatchObject({ verified: true, counts: f.manifest.counts });
    expect((await f.repository.status(f.manifest.id)).status).toBe('finalized');
    const row = await env.DB.prepare('SELECT relevance,delivered,delivered_at,run_id FROM user_articles').first();
    expect(row).toEqual({ relevance: 0, delivered: 1, delivered_at: null, run_id: null });
    const digest = new D1DigestRepository(env.DB);
    expect(await digest.contexts()).toEqual([]);
    expect(await digest.evalContext(bob)).toEqual([]);
    const imported = await digest.evalContext(alice);
    expect(imported).toEqual([{ pmid: '123', title: '', value: 1, score: 0, votedAt: timestamp }]);
    expect(computeEvalMetrics(imported.map(v => ({ ...v, score: v.score! })), 7).status).toBe('insufficient_data');
    expect((await env.DB.prepare('SELECT * FROM data_imports').all()).results).toHaveLength(3);
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    const before = await env.DB.prepare('SELECT * FROM import_sessions').all();
    await f.repository.create(f.owner, f.manifest);
    for (const block of f.blocks) await f.repository.put(f.owner, f.manifest.id, block);
    await f.repository.verify(f.manifest.id, f.owner);
    expect((await env.DB.prepare('SELECT * FROM import_sessions').all()).results).toEqual(before.results);
  });
  it('preserves an absent title as NULL separately from an empty title', async () => {
    const f = await fixture([{ ...article, title: null }]);
    await f.repository.create(f.owner, f.manifest);
    await f.repository.put(f.owner, f.manifest.id, f.blocks[0]);
    await f.repository.verify(f.manifest.id, f.owner);
    expect(await env.DB.prepare('SELECT legacy_title FROM user_articles').first()).toEqual({ legacy_title: null });
  });
  it('retries concurrent identical blocks without duplicate rows or checkpoints', async () => {
    const f = await fixture(); await f.repository.create(f.owner, f.manifest);
    await Promise.all([f.repository.put(f.owner, f.manifest.id, f.blocks[0]), f.repository.put(f.owner, f.manifest.id, f.blocks[0])]);
    expect((await f.repository.status(f.manifest.id)).blocks).toHaveLength(1);
    expect((await env.DB.prepare('SELECT * FROM user_articles').all()).results).toHaveLength(1);
  });
  it('rejects altered block contents and changed manifests', async () => {
    const f = await populated();
    await expect(f.repository.put(f.owner, f.manifest.id, { ...f.blocks[0], records: [{ ...article, title: 'changed' }] })).rejects.toThrow();
    await expect(f.repository.create(f.owner, { ...f.manifest, profile: { ...profile, description: 'changed' } })).rejects.toThrow();
  });
  it('rolls back all data and checkpoint when a later statement in a block fails', async () => {
    const f = await fixture([article, { ...article, title: 'duplicate' }]);
    const combined = { index: 0, records: [article, article], checksum: await checksum([article, article]) };
    f.manifest.blocks = [{ checksum: combined.checksum, count: 2 }];
    await f.repository.create(f.owner, f.manifest);
    await expect(f.repository.put(f.owner, f.manifest.id, combined)).rejects.toThrow();
    expect((await f.repository.status(f.manifest.id)).blocks).toEqual([]);
    expect((await env.DB.prepare('SELECT * FROM articles').all()).results).toEqual([]);
  });
  it('does not checkpoint unresolved votes or foreign chats', async () => {
    const f = await fixture(); await f.repository.create(f.owner, f.manifest);
    await expect(f.repository.put(f.owner, f.manifest.id, f.blocks[1])).rejects.toThrow();
    const alien = { ...vote, chatId: '200' };
    const g = { ...f.blocks[1], records: [alien], checksum: await checksum([alien]) };
    await expect(f.repository.put(f.owner, f.manifest.id, g)).rejects.toThrow();
    expect((await f.repository.status(f.manifest.id)).blocks).toEqual([]);
  });
  it('cannot finalize incomplete or corrupted content', async () => {
    const f = await fixture(); await f.repository.create(f.owner, f.manifest);
    await expect(f.repository.verify(f.manifest.id, f.owner)).rejects.toThrow();
    for (const b of f.blocks) await f.repository.put(f.owner, f.manifest.id, b);
    await env.DB.prepare("UPDATE articles SET title='altered'").run();
    await expect(f.repository.verify(f.manifest.id, f.owner)).rejects.toThrow();
    expect((await f.repository.status(f.manifest.id)).status).toBe('open');
    expect((await env.DB.prepare('SELECT * FROM data_imports').all()).results).toEqual([]);
  });
  it('checks the lease within the write transaction and never renews an expired lease', async () => {
    const f = await fixture(); await f.repository.create(f.owner, f.manifest);
    await env.DB.prepare('UPDATE operation_lock SET expires_at=0').run();
    await expect(f.repository.lease(f.owner, true)).rejects.toThrow();
    await expect(f.repository.put(f.owner, f.manifest.id, f.blocks[0])).rejects.toThrow();
    const other = crypto.randomUUID(); await f.repository.lease(other);
    await expect(f.repository.lease(f.owner, true)).rejects.toThrow();
    await expect(f.repository.put(f.owner, f.manifest.id, f.blocks[0])).rejects.toThrow();
    await f.repository.release(other);
    await expect(f.repository.lease(f.owner, true)).rejects.toThrow();
  });
  it('refuses imports while a deployment owns the lock and keeps tenant bootstrap isolated', async () => {
    const f = await fixture();
    await env.DB.prepare("UPDATE operation_lock SET kind='deploy'").run();
    await expect(f.repository.create(f.owner, f.manifest)).rejects.toThrow();
    await expect(f.repository.lease(crypto.randomUUID())).rejects.toThrow();
    expect((await env.DB.prepare('SELECT * FROM users').all()).results).toEqual([]);
  });
  it('fences a data edit between verification and final commit', async () => {
    const f = await populated();
    const batch = env.DB.batch.bind(env.DB);
    let calls = 0;
    const spy = vi.spyOn(env.DB, 'batch').mockImplementation(async statements => {
      calls++;
      if (calls === 2) await env.DB.prepare('UPDATE user_articles SET relevance=8').run();
      return batch(statements);
    });
    try { await expect(f.repository.verify(f.manifest.id, f.owner)).rejects.toThrow(); }
    finally { spy.mockRestore(); }
    expect((await f.repository.status(f.manifest.id)).status).toBe('open');
  });
  it('detects provenance corruption and prevents reopening sealed sessions', async () => {
    const f = await populated(); await f.repository.verify(f.manifest.id, f.owner);
    await expect(env.DB.prepare("UPDATE import_sessions SET status='open'").run()).rejects.toThrow();
    await env.DB.prepare("UPDATE data_imports SET code_sha='altered'").run();
    await expect(f.repository.verify(f.manifest.id)).rejects.toThrow();
  });
  it('fits maximum blocks within the fifty-query request budget', async () => {
    const rows: Record[] = Array.from({ length: 15 }, (_, i) => ({ ...article, pmid: String(i + 1) }));
    const f = await fixture(rows);
    const block = { index: 0, records: rows, checksum: await checksum(rows) };
    f.manifest.blocks = [{ checksum: block.checksum, count: 15 }];
    await f.repository.create(f.owner, f.manifest);
    await f.repository.put(f.owner, f.manifest.id, block);
    expect((await f.repository.verify(f.manifest.id, f.owner)).verified).toBe(true);
  });
});

describe('administrative capability boundary', () => {
  it.each(['read-only', 'telegram', 'synthetic-test-secret-only', 'wrong'])('rejects crossed credential %s', async credential => {
    const response = await api('', credential, {});
    expect(response.status).toBe(401); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain(credential);
  });
  it('rejects oversized, invalid and arbitrary SQL bodies without reflecting inputs', async () => {
    expect((await api('', secret, { secret: 'private-marker', sql: 'DROP TABLE users' })).status).toBe(400);
    expect((await api('', secret, { content: 'x'.repeat(256 * 1024) })).status).toBe(413);
    expect((await api('/sql', secret, {})).status).toBe(404);
    const response = await api('', secret, { email: 'private@example.test' });
    expect(await response.text()).not.toContain('private@example.test');
  });
  it('runs the typed create, block, status and finalize routes with the import credential', async () => {
    const f = await fixture();
    expect((await api('', secret, { owner: f.owner, manifest: f.manifest })).status).toBe(200);
    for (const block of f.blocks) expect((await api(`/${f.manifest.id}/blocks`, secret, { owner: f.owner, block })).status).toBe(200);
    expect((await api(`/${f.manifest.id}`)).status).toBe(200);
    expect((await api(`/${f.manifest.id}/finalize`, secret, { owner: f.owner })).status).toBe(200);
    expect((await api(`/${f.manifest.id}/verify`)).status).toBe(200);
  });
});
