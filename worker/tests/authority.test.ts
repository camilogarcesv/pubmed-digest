import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { AuthorityRepository } from '../multiuser/authority.js';
import { ImportRepository } from '../multiuser/imports.js';
import { LedgerExtensionRepository } from '../multiuser/ledger-extensions.js';
import { VoteReconciliationRepository } from '../multiuser/reconciliations.js';
import { recordCallbackVote } from '../multiuser/telegram-votes.js';
import { ImportManifest, checksum, counts, type Record } from '../../src/multiuser/import-contracts.js';
import { buildLedgerExtension } from '../../src/multiuser/ledger-extension.js';
import { VOTE_NOT_SAVED, voteAck } from '../../src/feedback.js';
import { alice, aliceDestination, profile, timestamp, d1Mode, seedUsers, article, item, run, advanceRun } from './fixtures.js';
import { RunRepository } from '../multiuser/runs.js';
import { createWorker, type WorkerEnv } from '../worker.js';
import { createExecutionContext } from 'cloudflare:test';

const audit = () => ({ id: crypto.randomUUID(), actor: 'test', reason: 'synthetic transition' });
const later = '2026-09-22T04:00:00.000Z';
async function imported() {
  const imports = new ImportRepository(env.DB), owner = crypto.randomUUID();
  const records: Record[] = [{ kind: 'article', pmid: '123', title: '', firstSeen: timestamp, relevance: 9, delivered: true }];
  const hash = await checksum(records);
  const manifest = ImportManifest.parse({ format: 1, id: crypto.randomUUID(), identity: { id: alice, destinationId: aliceDestination, chatId: '100', email: 'alice@example.test', slug: 'alice', timezone: 'UTC' },
    capturedAt: timestamp, codeSha: 'a'.repeat(40), stateSha: 'b'.repeat(40), profile, sources: [{ kind: 'journal', value: 'AJNR' }],
    files: Object.fromEntries(['ledger', 'profile', 'config', 'votes', 'backup', 'identity'].map(k => [k, 'c'.repeat(64)])),
    counts: counts(records), blocks: [{ checksum: hash, count: 1 }] });
  await imports.lease(owner); await imports.create(owner, manifest);
  await imports.put(owner, manifest.id, { index: 0, checksum: hash, records });
  await imports.verify(manifest.id, owner); await imports.release(owner);
  const authority = new AuthorityRepository(env.DB);
  await authority.execute({ ...audit(), action: 'maintenance', expectedMode: 'legacy' });
  const seal = { ...audit(), action: 'seal', expectedMode: 'maintenance', importId: manifest.id,
    codeSha: 'a'.repeat(40), stateSha: 'b'.repeat(40), firstPeriod: '2099-W01' };
  return { authority, seal, imports, owner };
}
async function activated() {
  const f = await imported();
  const sealed = await f.authority.execute(f.seal);
  const proofHash = (sealed.checkpoint as { proofHash: string }).proofHash;
  const activate = { ...audit(), action: 'activate', expectedMode: 'maintenance', proofHash, stateSha: f.seal.stateSha };
  await f.authority.execute(activate);
  return { ...f, activate };
}
const vote = (updateId = 1, value: 0 | 1 = 1, votedAt = timestamp) => ({ chatId: '100', messageId: '7', pmid: '123', value, updateId, votedAt });

describe('authority transition', () => {
  it('seals a verified import, activates atomically and repeats without changing the audit trail', async () => {
    const f = await activated();
    await f.authority.execute(f.activate);
    expect(await f.authority.status()).toMatchObject({ mode: 'd1', legacyWrites: 0, sending: 0 });
    expect(await f.authority.verify()).toMatchObject({ verified: true });
    expect(await env.DB.prepare('SELECT count(*) FROM authority_events').first('count(*)')).toBe(3);
    expect(await env.DB.prepare('SELECT status FROM users').first('status')).toBe('active');
    expect(await env.DB.prepare('SELECT digest_enabled,ops_enabled FROM destinations').first()).toEqual({ digest_enabled: 1, ops_enabled: 1 });
    await expect(f.authority.execute({ ...f.activate, reason: 'different' })).rejects.toThrow();
    await expect(d1Mode('legacy')).rejects.toThrow('cannot be reversed');
    await expect(f.imports.verify(f.seal.importId)).rejects.toThrow();
  });
  it('blocks stale mode, in-flight legacy votes, leases, changed state SHA and incomplete imports', async () => {
    const f = await imported();
    await expect(f.authority.execute({ ...f.seal, expectedMode: 'legacy' })).rejects.toThrow();
    await expect(f.authority.execute({ ...f.seal, stateSha: 'd'.repeat(40) })).rejects.toThrow();
    await f.imports.lease(f.owner);
    await expect(f.authority.execute(f.seal)).rejects.toThrow();
    await f.imports.release(f.owner);
    await d1Mode('legacy');
    await env.DB.prepare('INSERT INTO legacy_vote_inflight VALUES(?,?)').bind('request', timestamp).run();
    await d1Mode('maintenance');
    await expect(f.authority.execute(f.seal)).rejects.toThrow();
    await env.DB.prepare('DELETE FROM legacy_vote_inflight').run();
    await expect(f.authority.execute({ ...f.seal, importId: crypto.randomUUID() })).rejects.toThrow();
  });
  it('detects content drift between sealing and activation and prevents further imports', async () => {
    const f = await imported(), sealed = await f.authority.execute(f.seal);
    await f.imports.lease(f.owner);
    await expect(env.DB.prepare("INSERT INTO operation_assertions VALUES(?,'import',1)").bind(f.owner).run()).rejects.toThrow();
    await f.imports.release(f.owner);
    await env.DB.prepare("UPDATE articles SET title='changed'").run();
    await expect(f.authority.execute({ ...audit(), action: 'activate', expectedMode: 'maintenance', stateSha: f.seal.stateSha, proofHash: (sealed.checkpoint as { proofHash: string }).proofHash })).rejects.toThrow();
    expect(await env.DB.prepare('SELECT status FROM users').first('status')).toBe('paused');
  });
  it('preserves new votes through maintenance and resume and enforces the first delivery week', async () => {
    const f = await activated();
    expect(await recordCallbackVote(env.DB, vote())).toBe('recorded');
    await f.authority.execute({ ...audit(), action: 'maintenance', expectedMode: 'd1' });
    await expect(recordCallbackVote(env.DB, vote(2, 0))).rejects.toThrow();
    await f.authority.execute({ ...audit(), action: 'resume', expectedMode: 'maintenance' });
    expect(await env.DB.prepare('SELECT value FROM votes').first('value')).toBe(1);
    const { D1DigestRepository } = await import('../multiuser/repository.js');
    // A policy refusal, reported as a conflict so the client does not retry it.
    await expect(new D1DigestRepository(env.DB).createRun(run())).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('activation period') });
    expect(await f.authority.verify()).toMatchObject({ verified: true });
  });
  it('applies the final delta under audited maintenance and seals only its state SHA', async () => {
    const f = await imported();
    const ledger = new LedgerExtensionRepository(env.DB), stateSha = 'e'.repeat(40);
    const before = (await ledger.snapshot(alice)).records;
    // A near miss of the last legacy digest: scored and sent with buttons, not delivered.
    const addition = { kind: 'article' as const, pmid: '456', title: 'Later', firstSeen: later, relevance: 6, delivered: false };
    const delta = await buildLedgerExtension(before, [...before, addition], { id: crypto.randomUUID(), userId: alice, capturedAt: later,
      codeSha: 'e'.repeat(40), stateSha, ledgerChecksum: 'd'.repeat(64), backupChecksum: 'b'.repeat(64) });
    await f.imports.lease(f.owner);
    await ledger.create(f.owner, alice, delta.manifest);
    for (const block of delta.blocks) await ledger.put(f.owner, alice, delta.manifest.id, block);
    await ledger.finalize(f.owner, alice, delta.manifest.id);
    const votes = [{ pmid: '456', chatId: '100', value: 1 as const, votedAt: later }];
    const capture = { format: 1, id: crypto.randomUUID(), codeSha: 'f'.repeat(40), capturedAt: later, checksum: await checksum(votes), votes };
    expect(await new VoteReconciliationRepository(env.DB).apply(f.owner, alice, capture)).toMatchObject({ changed: 1 });
    await f.imports.release(f.owner);
    // The seal names the final ledger; an older state SHA no longer matches it.
    await expect(f.authority.execute(f.seal)).rejects.toThrow();
    const sealed = await f.authority.execute({ ...f.seal, id: crypto.randomUUID(), stateSha });
    const proofHash = (sealed.checkpoint as { proofHash: string }).proofHash;
    await f.authority.execute({ ...audit(), action: 'activate', expectedMode: 'maintenance', proofHash, stateSha });
    expect(await f.authority.verify()).toMatchObject({ verified: true, counts: { votes: 1 } });
  });
  it('cancels an unactivated transition back to legacy so a fresh final delta can be sealed', async () => {
    const f = await imported();
    await f.authority.execute(f.seal);
    await expect(f.authority.execute({ ...audit(), action: 'cancel', expectedMode: 'legacy' })).rejects.toThrow();
    const cancel = { ...audit(), action: 'cancel', expectedMode: 'maintenance' };
    await f.authority.execute(cancel);
    await f.authority.execute(cancel);
    expect(await f.authority.status()).toMatchObject({ mode: 'legacy', checkpoint: null, legacyWrites: 0 });
    // Legacy votes and imports resume; the audit trail keeps the discarded seal.
    await env.DB.prepare('INSERT INTO legacy_vote_inflight VALUES(?,?)').bind('vote', timestamp).run();
    await env.DB.prepare('DELETE FROM legacy_vote_inflight').run();
    await f.imports.lease(f.owner);
    await env.DB.prepare("INSERT INTO operation_assertions VALUES(?,'import',1)").bind(f.owner).run();
    await env.DB.prepare('DELETE FROM operation_assertions').run();
    await f.imports.release(f.owner);
    expect(await env.DB.prepare('SELECT action FROM authority_events ORDER BY created_at,action').all().then(r => r.results.map(e => e.action)))
      .toEqual(expect.arrayContaining(['maintenance', 'seal', 'cancel']));
    await f.authority.execute({ ...audit(), action: 'maintenance', expectedMode: 'legacy' });
    await f.authority.execute({ ...f.seal, id: crypto.randomUUID() });
    expect(await f.authority.status()).toMatchObject({ mode: 'maintenance', checkpoint: { activatedAt: null } });
  });
  it('never cancels an activated transition', async () => {
    const f = await activated();
    await f.authority.execute({ ...audit(), action: 'maintenance', expectedMode: 'd1' });
    await expect(f.authority.execute({ ...audit(), action: 'cancel', expectedMode: 'maintenance' })).rejects.toThrow();
    expect(await f.authority.status()).toMatchObject({ mode: 'maintenance', checkpoint: { activatedAt: expect.any(String) } });
  });
  it('keeps the audit trail and the sealed evidence immutable', async () => {
    const f = await imported();
    await f.authority.execute(f.seal);
    await expect(env.DB.prepare("UPDATE authority_checkpoint SET activated_at='2099-01-01T00:00:00.000Z',proof_json='{}'").run()).rejects.toThrow('sealed');
    await expect(env.DB.prepare("UPDATE authority_checkpoint SET first_period='2098-W01'").run()).rejects.toThrow('sealed');
    await expect(env.DB.prepare("UPDATE authority_events SET reason='changed'").run()).rejects.toThrow('immutable');
    const sealed = await f.authority.status();
    await f.authority.execute({ ...audit(), action: 'activate', expectedMode: 'maintenance', stateSha: f.seal.stateSha,
      proofHash: (sealed.checkpoint as { proofHash: string }).proofHash });
    await expect(env.DB.prepare('UPDATE authority_checkpoint SET activated_at=NULL').run()).rejects.toThrow('sealed');
    expect(await f.authority.verify()).toMatchObject({ verified: true });
  });
  it('expires crashed attempts in maintenance without retrying, then resumes for explicit resolution', async () => {
    const f = await activated();
    const { D1DigestRepository } = await import('../multiuser/repository.js');
    const repo = new D1DigestRepository(env.DB);
    const r = await repo.createRun({ ...run(), period: '2099-W01', runKey: 'weekly:2099-W01:1' });
    await repo.putItems(alice, r.id, 0, [item('456')]);
    const runs = new RunRepository(env.DB, { token: 'test', fetch: async () => { throw new Error('must not send'); } });
    await runs.prepare(alice, r.id, { metrics: {}, destinations: [{ destinationId: aliceDestination, messages: [{ kind: 'paper', text: 'test', pmid: '456', votable: true }] }] });
    await advanceRun(r.id, 'delivering');
    await env.DB.prepare("UPDATE delivery_messages SET status='sending',attempts=1,updated_at=?").bind(new Date().toISOString()).run();
    await f.authority.execute({ ...audit(), action: 'maintenance', expectedMode: 'd1' });
    await f.authority.execute({ ...audit(), action: 'quiesce', expectedMode: 'maintenance' });
    await expect(f.authority.execute({ ...audit(), action: 'resume', expectedMode: 'maintenance' })).rejects.toThrow();
    await env.DB.prepare('UPDATE delivery_messages SET updated_at=?').bind(timestamp).run();
    const q = { ...audit(), action: 'quiesce', expectedMode: 'maintenance' };
    await Promise.all([f.authority.execute(q), f.authority.execute(q)]);
    expect(await env.DB.prepare('SELECT status FROM delivery_messages').first('status')).toBe('unknown');
    await f.authority.execute({ ...audit(), action: 'resume', expectedMode: 'maintenance' });
    expect(await runs.deliverNext(alice, r.id, aliceDestination)).toMatchObject({ state: 'blocked' });
  });
  it('releases an orphan legacy claim only with audited evidence and after the drain window', async () => {
    const f = await imported();
    await d1Mode('legacy');
    const claimId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO legacy_vote_inflight VALUES(?,?)').bind(claimId, new Date().toISOString()).run();
    await d1Mode('maintenance');
    const release = { ...audit(), action: 'release_legacy', expectedMode: 'maintenance', claimId, evidenceHash: 'a'.repeat(64) };
    await expect(f.authority.execute(release)).rejects.toThrow();
    await env.DB.prepare('UPDATE legacy_vote_inflight SET started_at=?').bind(timestamp).run();
    await expect(f.authority.execute({ ...release, evidenceHash: '' })).rejects.toThrow();
    await f.authority.execute(release);
    expect(await f.authority.status()).toMatchObject({ legacyWrites: 0 });
    expect(await env.DB.prepare('SELECT payload_json FROM authority_events WHERE id=?').bind(release.id).first('payload_json')).toContain(release.evidenceHash);
  });
  it('rejects loss or corruption of imported history after activation', async () => {
    const f = await activated();
    await env.DB.prepare('UPDATE user_articles SET relevance=0').run();
    await expect(f.authority.verify()).rejects.toThrow();
    await env.DB.prepare('UPDATE user_articles SET relevance=9').run();
    expect(await f.authority.verify()).toMatchObject({ verified: true });
    await env.DB.prepare('DELETE FROM user_articles').run();
    await expect(f.authority.verify()).rejects.toThrow();
  });
});

describe('D1 callback votes', () => {
  it('deduplicates and orders presses transactionally, allowing randomized ids after a day', async () => {
    await activated();
    expect(await recordCallbackVote(env.DB, vote(20))).toBe('recorded');
    expect(await recordCallbackVote(env.DB, vote(20))).toBe('superseded');
    expect(await recordCallbackVote(env.DB, vote(19, 0))).toBe('superseded');
    await Promise.all([recordCallbackVote(env.DB, vote(21, 0)), recordCallbackVote(env.DB, vote(22, 1))]);
    expect(await env.DB.prepare('SELECT value FROM votes').first('value')).toBe(1);
    expect(await recordCallbackVote(env.DB, vote(1, 0, '2026-09-17T12:00:00.000Z'))).toBe('recorded');
  });
  it('rejects foreign chats, never-sent legacy articles and paused users, and accepts legacy near misses', async () => {
    await activated();
    expect(await recordCallbackVote(env.DB, { ...vote(), chatId: '200' })).toBe('failed');
    // Unscored legacy articles were filtered before scoring and never carried buttons.
    await env.DB.prepare('UPDATE user_articles SET delivered=0,relevance=NULL').run();
    expect(await recordCallbackVote(env.DB, vote())).toBe('failed');
    await env.DB.prepare('UPDATE user_articles SET relevance=6').run();
    await env.DB.prepare("UPDATE users SET status='paused'").run();
    expect(await recordCallbackVote(env.DB, vote())).toBe('failed');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM votes').first('n')).toBe(0);
    await env.DB.prepare("UPDATE users SET status='active'").run();
    expect(await recordCallbackVote(env.DB, vote())).toBe('recorded');
  });
  it('requires the exact sent D1 message, including near misses', async () => {
    const repo = await seedUsers(); await d1Mode();
    const r = await repo.createRun(run());
    await repo.putItems(alice, r.id, 0, [{ ...item(), disposition: 'near_miss' }]);
    const runs = new RunRepository(env.DB, { token: 'test', fetch: async () => Response.json({ ok: true, result: { message_id: 7 } }) });
    await runs.prepare(alice, r.id, { destinations: [{ destinationId: aliceDestination,
      messages: [{ kind: 'near_miss', text: 'test', pmid: '123', votable: true }] }], metrics: {} });
    expect(await recordCallbackVote(env.DB, vote())).toBe('failed');
    await runs.deliverNext(alice, r.id, aliceDestination);
    expect(await recordCallbackVote(env.DB, { ...vote(), messageId: '8' })).toBe('failed');
    expect(await recordCallbackVote(env.DB, vote())).toBe('recorded');
    await repo.importLedger('22222222-2222-4222-8222-222222222222', [{ article: article(), entry: {
      userId: '22222222-2222-4222-8222-222222222222', pmid: '123', firstSeen: timestamp, relevance: 9, delivered: true, deliveredAt: null, reason: null, source: null } }]);
    expect(await recordCallbackVote(env.DB, { ...vote(), chatId: '200' })).toBe('failed');
  });
  it('keeps a legacy claim until KV finishes and refuses new votes during maintenance', async () => {
    let finish!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; });
    const replies: unknown[] = [];
    const worker = createWorker(async (_url, init) => { replies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); });
    const bindings = { ...env, TELEGRAM_WEBHOOK_SECRET: 'test', TELEGRAM_BOT_TOKEN: 'test', VOTES_READ_SECRET: 'test',
      VOTES: { get: async () => null, put: async () => { started(); await pending; } } } as unknown as WorkerEnv;
    const request = () => new Request('https://test/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test' },
      body: JSON.stringify({ update_id: 1, callback_query: { id: 'test', data: 'v:123:1', message: { message_id: 7, chat: { id: 100 } } } }) });
    const call = () => worker.fetch!(request() as Parameters<NonNullable<typeof worker.fetch>>[0], bindings, createExecutionContext());
    const running = call(); await began;
    const authority = new AuthorityRepository(env.DB);
    await authority.execute({ ...audit(), action: 'maintenance', expectedMode: 'legacy' });
    expect(await authority.status()).toMatchObject({ legacyWrites: 1 });
    await call();
    expect(replies).toHaveLength(1);
    finish(); await running;
    expect(await authority.status()).toMatchObject({ legacyWrites: 0 });
  });
  it('stores webhook votes in D1 once active, acknowledges them and never touches KV', async () => {
    await activated();
    const replies: { method: string; body: { text?: string } }[] = [];
    const worker = createWorker(async (url, init) => {
      replies.push({ method: String(url).split('/').at(-1)!, body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    });
    const frozen = { get: async () => { throw new Error('KV read'); }, put: async () => { throw new Error('KV write'); } };
    const bindings = { ...env, TELEGRAM_WEBHOOK_SECRET: 'test', TELEGRAM_BOT_TOKEN: 'test', VOTES_READ_SECRET: 'test', VOTES: frozen } as unknown as WorkerEnv;
    const press = (updateId: number, data: string, chat: number) => worker.fetch!(new Request('https://test/webhook', {
      method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test' },
      body: JSON.stringify({ update_id: updateId, callback_query: { id: 'test', data, message: { message_id: 7, chat: { id: chat } } } }),
    }) as Parameters<NonNullable<typeof worker.fetch>>[0], bindings, createExecutionContext());
    expect((await press(1, 'v:123:1', 100)).status).toBe(200);
    expect(await env.DB.prepare('SELECT value,source FROM votes').first()).toEqual({ value: 1, source: 'telegram' });
    expect(replies.map(r => r.method)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    expect(replies[0].body.text).toBe(voteAck(1));
    replies.length = 0;
    expect((await press(2, 'v:123:0', 200)).status).toBe(200);
    expect(replies).toEqual([{ method: 'answerCallbackQuery', body: expect.objectContaining({ text: VOTE_NOT_SAVED }) }]);
    expect(await env.DB.prepare('SELECT value FROM votes').first('value')).toBe(1);
  });
});
