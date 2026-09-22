import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { RunRepository, STALE_ATTEMPT_MS, type TelegramFetch } from '../multiuser/runs.js';
import { createBackend } from '../multiuser/worker.js';
import type { DigestItem, OutboundMessage } from '../../src/multiuser/contracts.js';
import { voteKeyboard } from '../../src/feedback.js';
import { alice, aliceDestination, bob, bobDestination, advanceRun, article, d1Mode, resetDatabase, run, seedUsers, timestamp } from './fixtures.js';

type Item = z.infer<typeof DigestItem>;
type Message = z.infer<typeof OutboundMessage>;
const token = 'synthetic-bot-token';
const scored = (pmid: string, disposition: Item['disposition'], relevance = 9): Item => ({
  article: article(pmid), relevance: disposition === 'filtered' ? null : relevance, reason: 'Motivo', source: 'AJNR', disposition,
});
const items = [scored('1001', 'selected'), scored('1002', 'selected', 8), scored('1003', 'near_miss', 6), scored('1004', 'below_threshold', 3), scored('1005', 'filtered')];
/** The digest shape: header, one message per paper, near-miss section, footer. */
function render(xs: Item[] = items): Message[] {
  const paper = (i: Item): Message => ({ kind: i.disposition === 'selected' ? 'paper' : 'near_miss', text: `<b>${i.article.title}</b>`, pmid: i.article.pmid, votable: true });
  const selected = xs.filter(i => i.disposition === 'selected'), near = xs.filter(i => i.disposition === 'near_miss');
  if (!selected.length && !near.length) return [{ kind: 'empty', text: 'Nada esta semana', pmid: null, votable: false }];
  return [{ kind: 'header', text: '<b>Digest</b>', pmid: null, votable: false }, ...selected.map(paper),
    ...(near.length ? [{ kind: 'header' as const, text: '<i>Cerca del umbral</i>', pmid: null, votable: false }, ...near.map(paper)] : []),
    { kind: 'footer', text: '<i>pie</i>', pmid: null, votable: false }];
}
/** Scripted Telegram: each entry answers one sendMessage call; default is a successful send. */
function telegram(script: (Response | Error | (() => Promise<Response>))[] = []) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let id = 500;
  const fetch: TelegramFetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    const step = script.shift();
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step();
    return step ?? Response.json({ ok: true, result: { message_id: id++ } });
  };
  return { fetch, calls };
}
async function draft(xs: Item[] = items, attempt = 1) {
  const repository = await env.DB.prepare('SELECT 1 FROM users WHERE id=?').bind(alice).first()
    ? new (await import('../multiuser/repository.js')).D1DigestRepository(env.DB) : await seedUsers();
  await d1Mode();
  const created = await repository.createRun(run(alice, xs.length, attempt));
  for (let i = 0; i < xs.length; i += 15) await repository.putItems(alice, created.id, i / 15, xs.slice(i, i + 15));
  return { repository, runId: created.id };
}
async function prepared(t = telegram(), xs: Item[] = items) {
  const d = await draft(xs);
  const runs = new RunRepository(env.DB, { token, fetch: t.fetch });
  await runs.prepare(alice, d.runId, { metrics: { scored: xs.length }, destinations: [{ destinationId: aliceDestination, messages: render(xs) }] });
  return { ...d, runs, t };
}
const messageRows = (runId: string) => env.DB.prepare('SELECT id,position,status,attempts,telegram_message_id FROM delivery_messages WHERE run_id=? ORDER BY position')
  .bind(runId).all<{ id: string; position: number; status: string; attempts: number; telegram_message_id: string | null }>().then(r => r.results);
const runStatus = (runId: string) => env.DB.prepare('SELECT status FROM digest_runs WHERE id=?').bind(runId).first<string>('status');
async function deliverAll(runs: RunRepository, runId: string, destination = aliceDestination) {
  const states: string[] = [];
  for (let i = 0; i < 50; i++) {
    const outcome = await runs.deliverNext(alice, runId, destination);
    states.push(outcome.state);
    if (outcome.state !== 'sent' && outcome.state !== 'retry') return states;
  }
  throw new Error('delivery did not settle');
}

describe('run lifecycle', () => {
  it('delivers in order with the digest format, then records history exactly once', async () => {
    const f = await prepared();
    expect(await f.runs.progress(alice, f.runId)).toMatchObject({ status: 'prepared', items: 5, messages: { pending: 6 } });
    expect(await f.repository.seen({ pairs: ['1001', '1004', '1005'].map(pmid => ({ userId: alice, pmid })) })).toEqual([true, true, true]);
    expect(await deliverAll(f.runs, f.runId)).toEqual(['sent', 'sent', 'sent', 'sent', 'sent', 'done']);
    expect(f.t.calls.map(c => c.body.text)).toEqual(render().map(m => m.text));
    expect(f.t.calls[1]).toEqual({ url: `https://api.telegram.org/bot${token}/sendMessage`, body: {
      chat_id: '100', text: '<b>Paper 1001</b>', parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: voteKeyboard('1001') },
    } });
    expect(f.t.calls.filter(c => c.body.reply_markup).map(c => (c.body.reply_markup as { inline_keyboard: unknown }).inline_keyboard))
      .toEqual(['1001', '1002', '1003'].map(voteKeyboard));
    expect(await runStatus(f.runId)).toBe('succeeded');
    const history = await env.DB.prepare('SELECT pmid,relevance,delivered,delivered_at IS NOT NULL AS stamped,run_id FROM user_articles ORDER BY pmid').all();
    expect(history.results).toEqual([
      { pmid: '1001', relevance: 9, delivered: 1, stamped: 1, run_id: f.runId }, { pmid: '1002', relevance: 8, delivered: 1, stamped: 1, run_id: f.runId },
      { pmid: '1003', relevance: 6, delivered: 0, stamped: 0, run_id: f.runId }, { pmid: '1004', relevance: 3, delivered: 0, stamped: 0, run_id: f.runId },
      { pmid: '1005', relevance: null, delivered: 0, stamped: 0, run_id: f.runId },
    ]);
    expect(await f.runs.deliverNext(alice, f.runId, aliceDestination)).toEqual({ state: 'done' });
    expect(f.t.calls).toHaveLength(6);
    expect((await messageRows(f.runId)).every(m => m.status === 'sent' && m.attempts === 1)).toBe(true);
    expect(await f.repository.seen({ pairs: [{ userId: alice, pmid: '1001' }, { userId: bob, pmid: '1001' }] })).toEqual([true, false]);
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('delivers an explicit empty digest and seals a run without delivered items', async () => {
    const f = await prepared(telegram(), [scored('1004', 'below_threshold', 3)]);
    expect(await deliverAll(f.runs, f.runId)).toEqual(['done']);
    expect(f.t.calls.map(c => c.body.text)).toEqual(['Nada esta semana']);
    expect(await env.DB.prepare('SELECT delivered FROM user_articles').all()).toMatchObject({ results: [{ delivered: 0 }] });
  });

  it('maps Telegram answers: flood control retries, rejections fail, ambiguity is unknown', async () => {
    const cases: [Response | Error, string, string][] = [
      [Response.json({ ok: false, parameters: { retry_after: 7 } }, { status: 429 }), 'retry', 'pending'],
      [Response.json({ ok: false }, { status: 400 }), 'blocked', 'failed'],
      [new Response('upstream', { status: 502 }), 'blocked', 'unknown'],
      [new Error('timeout'), 'blocked', 'unknown'],
      [Response.json({ ok: true, result: {} }), 'blocked', 'unknown'],
    ];
    for (const [answer, state, status] of cases) {
      await resetDatabase();
      const f = await prepared(telegram([answer]));
      const outcome = await f.runs.deliverNext(alice, f.runId, aliceDestination);
      expect(outcome.state).toBe(state);
      if (state === 'retry') expect(outcome.retryAfter).toBe(7);
      expect((await messageRows(f.runId))[0]).toMatchObject({ status, attempts: 1, telegram_message_id: null });
      expect(await runStatus(f.runId)).toBe(state === 'retry' ? 'delivering' : 'needs_reconciliation');
      // Never re-sent automatically: the next call reports the blocked message instead of sending.
      if (state === 'blocked') expect(await f.runs.deliverNext(alice, f.runId, aliceDestination)).toEqual({ state: 'blocked', messageId: (await messageRows(f.runId))[0].id });
      else {
        // Flood control holds the message for every caller until retry_after has elapsed.
        expect((await f.runs.deliverNext(alice, f.runId, aliceDestination)).state).toBe('retry');
        const later = new RunRepository(env.DB, { token, fetch: f.t.fetch }, () => Date.now() + 8000);
        expect((await later.deliverNext(alice, f.runId, aliceDestination)).state).toBe('sent');
      }
      expect(f.t.calls).toHaveLength(state === 'retry' ? 2 : 1);
    }
  });

  it('never sends twice or out of order under concurrent calls', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await prepared(telegram([async () => { await gate; return Response.json({ ok: true, result: { message_id: 1 } }); }]));
    const first = f.runs.deliverNext(alice, f.runId, aliceDestination);
    await vi.waitFor(async () => expect((await messageRows(f.runId))[0].status).toBe('sending'));
    expect(await f.runs.deliverNext(alice, f.runId, aliceDestination)).toEqual({ state: 'busy' });
    release();
    expect((await first).state).toBe('sent');
    for (let round = 0; round < 3; round++) {
      const racing = await Promise.all([f.runs.deliverNext(alice, f.runId, aliceDestination), f.runs.deliverNext(alice, f.runId, aliceDestination)]);
      expect(racing.every(r => r.state === 'sent' || r.state === 'busy')).toBe(true);
    }
    // Whatever the interleaving: each message at most once, in position order, never skipping ahead.
    expect(f.t.calls.map(c => c.body.text)).toEqual(render().slice(0, f.t.calls.length).map(m => m.text));
    const attempts = (await messageRows(f.runId)).map(m => m.attempts);
    expect(attempts.every(n => n <= 1)).toBe(true);
    expect(attempts.filter(n => n === 1)).toHaveLength(f.t.calls.length);
  });

  it('turns an abandoned attempt into unknown after the window and blocks further sends', async () => {
    const f = await prepared();
    const [first] = await messageRows(f.runId);
    await advanceRun(f.runId, 'delivering');
    const old = Date.parse(timestamp);
    await env.DB.prepare("UPDATE delivery_messages SET status='sending',attempts=1,updated_at=? WHERE id=?").bind(new Date(old).toISOString(), first.id).run();
    const early = new RunRepository(env.DB, { token, fetch: f.t.fetch }, () => old + STALE_ATTEMPT_MS - 1);
    expect(await early.deliverNext(alice, f.runId, aliceDestination)).toEqual({ state: 'busy' });
    const late = new RunRepository(env.DB, { token, fetch: f.t.fetch }, () => old + STALE_ATTEMPT_MS + 1);
    expect(await late.deliverNext(alice, f.runId, aliceDestination)).toEqual({ state: 'blocked', messageId: first.id });
    expect(await runStatus(f.runId)).toBe('needs_reconciliation');
    expect(f.t.calls).toHaveLength(0);
  });

  it('resolves blocked messages with an audit trail and resumes or seals the run', async () => {
    const f = await prepared(telegram([new Error('timeout')]));
    const [first] = await messageRows(f.runId);
    await f.runs.deliverNext(alice, f.runId, aliceDestination);
    await expect(f.runs.resolve(alice, f.runId, (await messageRows(f.runId))[1].id, { action: 'retry', actor: 'operator', reason: 'x', telegramMessageId: null }))
      .rejects.toMatchObject({ code: 'conflict' });
    await f.runs.resolve(alice, f.runId, first.id, { action: 'mark_sent', actor: 'operator', reason: 'Visto en el chat', telegramMessageId: '900' });
    expect(await deliverAll(f.runs, f.runId)).toEqual(['sent', 'sent', 'sent', 'sent', 'done']);
    expect((await messageRows(f.runId))[0]).toMatchObject({ status: 'reconciled_sent', telegram_message_id: '900', attempts: 1 });
    expect(await env.DB.prepare('SELECT action,actor,reason FROM delivery_resolutions').all()).toMatchObject({ results: [{ action: 'mark_sent', actor: 'operator', reason: 'Visto en el chat' }] });
    await expect(env.DB.prepare("UPDATE delivery_resolutions SET reason='changed'").run()).rejects.toThrow('resolution immutable');

    await resetDatabase();
    const g = await prepared(telegram([Response.json({ ok: false }, { status: 403 })]), [scored('2001', 'selected')]);
    await g.runs.deliverNext(alice, g.runId, aliceDestination);
    const blocked = (await messageRows(g.runId))[0];
    await g.runs.resolve(alice, g.runId, blocked.id, { action: 'retry', actor: 'operator', reason: 'Chat reactivado', telegramMessageId: null });
    expect(await deliverAll(g.runs, g.runId)).toEqual(['sent', 'sent', 'done']);
    expect((await messageRows(g.runId))[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('aborts only before any attempt and frees the week for another attempt', async () => {
    const d = await draft();
    const runs = new RunRepository(env.DB, { token, fetch: telegram().fetch });
    await expect(d.repository.createRun(run(alice, items.length, 2))).rejects.toMatchObject({ code: 'conflict' });
    expect((await runs.abort(alice, d.runId)).status).toBe('aborted');
    expect(await d.repository.seen({ pairs: [{ userId: alice, pmid: '1001' }] })).toEqual([false]);
    const second = await d.repository.createRun(run(alice, 1, 2));
    await d.repository.putItems(alice, second.id, 0, [scored('1001', 'selected')]);
    await runs.prepare(alice, second.id, { metrics: {}, destinations: [{ destinationId: aliceDestination, messages: render([scored('1001', 'selected')]) }] });
    expect((await runs.abort(alice, second.id)).status).toBe('aborted');
    await resetDatabase();
    const f = await prepared();
    await f.runs.deliverNext(alice, f.runId, aliceDestination);
    await expect(f.runs.abort(alice, f.runId)).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.runs.runs(alice, '2026-W38')).map(r => r.status).sort()).toEqual(['delivering']);
  });

  it('keeps delivering to other destinations while one destination is blocked', async () => {
    const repository = await seedUsers();
    const second = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await env.DB.prepare("INSERT INTO destinations(id,user_id,external_id,status,digest_enabled,ops_enabled) VALUES(?,?,'101','active',1,0)").bind(second, alice).run();
    await d1Mode();
    const xs = [scored('1001', 'selected')];
    const created = await repository.createRun(run(alice, 1));
    await repository.putItems(alice, created.id, 0, xs);
    const t = telegram([Response.json({ ok: false }, { status: 403 })]);
    const runs = new RunRepository(env.DB, { token, fetch: t.fetch });
    await runs.prepare(alice, created.id, { metrics: {}, destinations: [aliceDestination, second].map(destinationId => ({ destinationId, messages: render(xs) })) });
    const [first, other] = [aliceDestination, second].sort();
    expect((await runs.deliverNext(alice, created.id, first)).state).toBe('blocked');
    expect(await runStatus(created.id)).toBe('needs_reconciliation');
    expect(await deliverAll(runs, created.id, other)).toEqual(['sent', 'sent', 'sent', 'destination_done']);
    expect(await runStatus(created.id)).toBe('needs_reconciliation');
    expect(t.calls.map(c => c.body.chat_id)).toEqual([first === aliceDestination ? '100' : '101', ...Array(3).fill(other === aliceDestination ? '100' : '101')]);
    const blocked = (await env.DB.prepare("SELECT id FROM delivery_messages WHERE destination_id=? AND status='failed'").bind(first).first<string>('id'))!;
    await runs.resolve(alice, created.id, blocked, { action: 'retry', actor: 'operator', reason: 'Chat reactivado', telegramMessageId: null });
    expect(await deliverAll(runs, created.id, first)).toEqual(['sent', 'sent', 'done']);
    expect(await runStatus(created.id)).toBe('succeeded');
  });

  it('seals a delivered run even when an article is already in the history, keeping the first record', async () => {
    const f = await prepared();
    await env.DB.prepare("INSERT INTO user_articles(user_id,pmid,first_seen,relevance,delivered) VALUES(?,'1004',?,2,0)").bind(alice, timestamp).run();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await deliverAll(f.runs, f.runId)).at(-1)).toBe('done');
    expect(await runStatus(f.runId)).toBe('succeeded');
    expect(await env.DB.prepare("SELECT relevance,run_id FROM user_articles WHERE pmid='1004'").first()).toEqual({ relevance: 2, run_id: null });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM user_articles WHERE run_id=?').bind(f.runId).first('n')).toBe(4);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('history_already_present'));
    warn.mockRestore();
  });

  it('delivers an ad-hoc search run without writing history, like the legacy search', async () => {
    const repository = await seedUsers();
    await d1Mode();
    const search = { ...run(alice, 1), runKey: 'search:glioma', kind: 'search' as const, period: null };
    const created = await repository.createRun(search);
    expect((await repository.createRun({ ...search, id: crypto.randomUUID(), runKey: 'search:other' })).status).toBe('draft');
    await repository.putItems(alice, created.id, 0, [scored('1001', 'selected')]);
    const runs = new RunRepository(env.DB, { token, fetch: telegram().fetch });
    await runs.prepare(alice, created.id, { metrics: {}, destinations: [{ destinationId: aliceDestination, messages: render([scored('1001', 'selected')]) }] });
    expect(await deliverAll(runs, created.id)).toEqual(['sent', 'sent', 'done']);
    expect(await runStatus(created.id)).toBe('succeeded');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM user_articles').first('n')).toBe(0);
    await expect(env.DB.prepare("INSERT INTO user_articles(user_id,pmid,first_seen,delivered,run_id) VALUES(?,'1001',?,0,?)").bind(alice, timestamp, created.id).run())
      .rejects.toThrow('history waits');
  });

  it('keeps the Telegram message id in the log when a sent outcome cannot be recorded', async () => {
    const f = await prepared(telegram([Response.json({ ok: true, result: { message_id: 812 } })]));
    let batches = 0;
    const failing = new Proxy(env.DB, { get(target, prop) {
      if (prop === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (++batches === 2) throw new Error('D1 unavailable');
        return target.batch(statements);
      };
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(new RunRepository(failing, { token, fetch: f.t.fetch }).deliverNext(alice, f.runId, aliceDestination)).rejects.toThrow('D1 unavailable');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"telegramMessageId":"812"'));
    error.mockRestore();
    expect((await messageRows(f.runId))[0].status).toBe('sending');
  });

  it('reports refused preconditions as conflicts with their reason', async () => {
    const f = await prepared();
    await env.DB.prepare("UPDATE destinations SET status='paused' WHERE id=?").bind(aliceDestination).run();
    await expect(f.runs.deliverNext(alice, f.runId, aliceDestination)).rejects.toMatchObject({ code: 'conflict', message: 'Destination is not active' });
    await env.DB.prepare("UPDATE destinations SET status='active' WHERE id=?").bind(aliceDestination).run();
    await env.DB.prepare("UPDATE users SET status='paused' WHERE id=?").bind(alice).run();
    await expect(f.runs.deliverNext(alice, f.runId, aliceDestination)).rejects.toMatchObject({ code: 'conflict', message: 'User is not active' });
    await expect(f.repository.createRun({ ...run(alice, 1), runKey: 'weekly:2026-W39:1', period: '2026-W39' })).rejects.toMatchObject({ code: 'not_found' });
    await env.DB.prepare("UPDATE users SET status='active' WHERE id=?").bind(alice).run();
    expect((await f.runs.deliverNext(alice, f.runId, aliceDestination)).state).toBe('sent');
  });
});

describe('prepare validation', () => {
  it('rejects content that does not match the run items or destinations', async () => {
    const d = await draft();
    const runs = new RunRepository(env.DB, { token, fetch: telegram().fetch });
    const attempt = (messages: Message[], destinations = [aliceDestination]) => runs.prepare(alice, d.runId, { metrics: {}, destinations: destinations.map(destinationId => ({ destinationId, messages })) });
    const good = render();
    for (const messages of [
      good.filter(m => m.pmid !== '1002'), // missing a delivered item
      good.map(m => m.pmid === '1003' ? { ...m, kind: 'paper' as const } : m), // near miss rendered as selected
      [...good, { kind: 'paper' as const, text: 'x', pmid: '1004', votable: true }], // below threshold delivered
      good.map(m => m.pmid === '1001' ? { ...m, votable: false } : m), // no keyboard
      [...good, { ...good[1] }], // two keyboards for one item
      [{ kind: 'empty' as const, text: 'Nada', pmid: null, votable: false }],
    ]) await expect(attempt(messages)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(attempt(good, [aliceDestination, bobDestination])).rejects.toMatchObject({ code: 'conflict' });
    await expect(attempt(good, [bobDestination])).rejects.toMatchObject({ code: 'conflict' });
    await expect(attempt(Array.from({ length: 37 }, () => good[0]))).rejects.toThrow();
    expect(await runStatus(d.runId)).toBe('draft');
    expect((await attempt(good)).status).toBe('prepared');
    expect((await attempt(good)).status).toBe('prepared');
    await expect(attempt([...good.slice(0, -1), { ...good.at(-1)!, text: 'otro pie' }])).rejects.toMatchObject({ code: 'conflict' });
    await expect(runs.prepare(alice, d.runId, { metrics: { other: 1 }, destinations: [{ destinationId: aliceDestination, messages: good }] })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('requires every item before preparing and keeps tenants apart', async () => {
    const repository = await seedUsers();
    await d1Mode();
    const created = await repository.createRun(run(alice, 2));
    await repository.putItems(alice, created.id, 0, [scored('1001', 'selected')]);
    const runs = new RunRepository(env.DB, { token, fetch: telegram().fetch });
    const body = { metrics: {}, destinations: [{ destinationId: aliceDestination, messages: render([scored('1001', 'selected')]) }] };
    await expect(runs.prepare(alice, created.id, body)).rejects.toMatchObject({ code: 'conflict' });
    await expect(runs.prepare(bob, created.id, body)).rejects.toMatchObject({ code: 'not_found' });
    await env.DB.prepare("UPDATE users SET status='paused' WHERE id=?").bind(alice).run();
    await expect(repository.putItems(alice, created.id, 1, [scored('1002', 'below_threshold', 2)])).rejects.toMatchObject({ code: 'conflict' });
    await env.DB.prepare("UPDATE users SET status='active' WHERE id=?").bind(alice).run();
    await repository.putItems(alice, created.id, 1, [scored('1002', 'below_threshold', 2)]);
    await env.DB.prepare("UPDATE users SET status='paused' WHERE id=?").bind(alice).run();
    await expect(runs.prepare(alice, created.id, body)).rejects.toMatchObject({ code: 'conflict', message: 'User is not active' });
    await env.DB.prepare("UPDATE users SET status='active' WHERE id=?").bind(alice).run();
    await runs.prepare(alice, created.id, body);
    await expect(runs.deliverNext(bob, created.id, aliceDestination)).rejects.toMatchObject({ code: 'not_found' });
    await expect(runs.deliverNext(alice, created.id, bobDestination)).rejects.toMatchObject({ code: 'not_found' });
    await expect(runs.progress(bob, created.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await runs.runs(bob, '2026-W38')).toEqual([]);
  });
});

describe('lifecycle triggers against direct writes', () => {
  it('enforces run and message transitions, immutable content and delayed history', async () => {
    const f = await prepared();
    const [first] = await messageRows(f.runId);
    for (const sql of [
      "UPDATE digest_runs SET status='succeeded'", "UPDATE digest_runs SET status='draft'", "UPDATE digest_runs SET payload_hash='b'||substr(payload_hash,2)",
      "UPDATE digest_runs SET metrics_json='{\"x\":1}'", "UPDATE digest_items SET relevance=1",
      "UPDATE delivery_messages SET status='sent',telegram_message_id='1'", "UPDATE delivery_messages SET status='sending'",
      "UPDATE delivery_messages SET payload_json='{\"text\":\"x\"}'", "UPDATE delivery_messages SET status='reconciled_sent'",
    ]) await expect(env.DB.prepare(sql).run(), sql).rejects.toThrow();
    for (const period of ['2026-W00', '2026-W54', '2026-W5']) {
      await expect(env.DB.prepare(`INSERT INTO digest_runs(id,user_id,profile_version,run_key,payload_hash,kind,status,expected_items,profile_snapshot_json,created_at,updated_at,period)
        VALUES(?,?,1,?,?,'weekly','draft',0,'{}',?,?,?)`).bind(crypto.randomUUID(), alice, `weekly:${period}:1`, 'a'.repeat(64), timestamp, timestamp, period).run(), period).rejects.toThrow();
    }
    await expect(env.DB.prepare(`INSERT INTO delivery_messages(id,user_id,run_id,destination_id,position,kind,pmid,votable,payload_json,status,attempts,updated_at)
      VALUES(?,?,?,?,9,'footer',NULL,0,'{}','sent',0,?)`).bind(crypto.randomUUID(), alice, f.runId, aliceDestination, timestamp).run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO user_articles(user_id,pmid,first_seen,delivered,run_id) VALUES(?,'1001',?,0,?)").bind(alice, timestamp, f.runId).run())
      .rejects.toThrow('history waits');
    await expect(env.DB.prepare("INSERT INTO delivery_resolutions VALUES(?,?,?,'retry','x','y',?)").bind(crypto.randomUUID(), alice, first.id, timestamp).run())
      .rejects.toThrow('not awaiting resolution');
    await deliverAll(f.runs, f.runId);
    for (const sql of ["UPDATE digest_runs SET status='aborted'", "UPDATE delivery_messages SET status='unknown'", "UPDATE digest_runs SET updated_at='x'"]) {
      await expect(env.DB.prepare(sql).run(), sql).rejects.toThrow();
    }
  });
});

describe('mode fencing', () => {
  it('writes nothing while legacy, including a mode change between read and commit', async () => {
    const f = await prepared();
    const snapshot = () => Promise.all(['digest_runs', 'delivery_messages', 'user_articles', 'digest_assertions'].map(t => env.DB.prepare(`SELECT * FROM ${t}`).all().then(r => r.results)));
    const before = await snapshot();
    let batches = 0;
    const racing = new Proxy(env.DB, { get(target, prop) {
      if (prop === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (++batches === 1) await d1Mode('legacy');
        return target.batch(statements);
      };
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(new RunRepository(racing, { token, fetch: f.t.fetch }).deliverNext(alice, f.runId, aliceDestination)).rejects.toMatchObject({ code: 'conflict', message: 'Delivery requires D1 mode' });
    expect(f.t.calls).toHaveLength(0);
    expect(await snapshot()).toEqual(before);
    for (const call of [() => f.runs.deliverNext(alice, f.runId, aliceDestination), () => f.runs.abort(alice, f.runId), () => f.runs.opsAlert({ text: 'x' })]) {
      await expect(call()).rejects.toMatchObject({ code: 'conflict' });
    }
    await expect(f.repository.createRun({ ...run(alice, 1), runKey: 'weekly:2026-W39:1', period: '2026-W39' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.repository.putItems(alice, f.runId, 1, [scored('9001', 'selected')])).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(f.t.calls).toHaveLength(0);
  });

  it('fences prepare in its own transaction', async () => {
    const d = await draft();
    let batches = 0;
    const racing = new Proxy(env.DB, { get(target, prop) {
      if (prop === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (++batches === 2) await d1Mode('maintenance');
        return target.batch(statements);
      };
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(new RunRepository(racing, { token, fetch: telegram().fetch }).prepare(alice, d.runId, { metrics: {}, destinations: [{ destinationId: aliceDestination, messages: render() }] }))
      .rejects.toThrow();
    expect(await runStatus(d.runId)).toBe('draft');
    expect(await messageRows(d.runId)).toEqual([]);
  });
});

describe('operations alerts', () => {
  it('sends plain text only to active operations destinations', async () => {
    await seedUsers();
    await d1Mode();
    await env.DB.prepare('UPDATE destinations SET ops_enabled=1 WHERE id=?').bind(aliceDestination).run();
    const t = telegram();
    expect(await new RunRepository(env.DB, { token, fetch: t.fetch }).opsAlert({ text: '<b>El digest falló</b>' })).toEqual({ sent: 1, failed: 0 });
    expect(t.calls).toEqual([{ url: `https://api.telegram.org/bot${token}/sendMessage`, body: { chat_id: '100', text: '<b>El digest falló</b>', disable_web_page_preview: true } }]);
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare("INSERT INTO destinations(id,user_id,external_id,status,digest_enabled,ops_enabled) VALUES(?,?,?,'active',0,1)").bind(crypto.randomUUID(), alice, String(900 + i)).run();
    }
    await expect(new RunRepository(env.DB, { token, fetch: t.fetch }).opsAlert({ text: 'x' })).rejects.toMatchObject({ code: 'conflict' });
    expect(t.calls).toHaveLength(1);
  });
});

describe('Free plan budget', () => {
  function counting() {
    const counter = { queries: 0 };
    const instrument = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, prop) {
      if (prop === 'bind') return (...args: unknown[]) => instrument(target.bind(...args));
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { counter.queries++; return value.apply(target, args); };
    } });
    const db = new Proxy(env.DB, { get(target, prop) {
      if (prop === 'prepare') return (sql: string) => instrument(target.prepare(sql));
      if (prop === 'batch') return (statements: D1PreparedStatement[]) => { counter.queries += statements.length; return target.batch(statements); };
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { db, counter };
  }

  it('keeps prepare, every delivery step and the sealing step within 50 subrequests', async () => {
    const many = Array.from({ length: 34 }, (_, i) => scored(String(3000 + i), 'selected'));
    const d = await draft(many);
    const c = counting();
    const t = telegram();
    const runs = new RunRepository(c.db, { token, fetch: t.fetch });
    await runs.prepare(alice, d.runId, { metrics: {}, destinations: [{ destinationId: aliceDestination, messages: render(many) }] });
    expect(render(many)).toHaveLength(36);
    // 4 reads + guard/update/clear + 36 inserts + progress; the router adds one mode read.
    expect(c.counter.queries).toBe(44);
    let worst = 0;
    for (;;) {
      c.counter.queries = 0;
      const before = t.calls.length;
      const outcome = await runs.deliverNext(alice, d.runId, aliceDestination);
      worst = Math.max(worst, c.counter.queries + t.calls.length - before);
      if (outcome.state === 'done') break;
    }
    // Last message: 12 D1 queries (claim, record, seal) + 1 Telegram call; the router adds one mode read.
    expect(worst).toBe(13);
    expect(await runStatus(d.runId)).toBe('succeeded');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM user_articles').first('n')).toBe(34);
  });

  it('keeps a full fifteen-item chunk within budget', async () => {
    const repository = await seedUsers();
    await d1Mode();
    const created = await repository.createRun(run(alice, 15));
    const c = counting();
    await new (await import('../multiuser/repository.js')).D1DigestRepository(c.db)
      .putItems(alice, created.id, 0, Array.from({ length: 15 }, (_, i) => scored(String(4000 + i), 'selected')));
    expect(c.counter.queries).toBe(35);
  });
});

describe('digest run routes', () => {
  const importSecret = 'e'.repeat(64);
  const backend = (t = telegram()) => ({ t, call: (secret: string | undefined, path: string, method = 'GET', body?: unknown) => createBackend(t.fetch).fetch(new Request(`https://test/internal/v1${path}`, {
    method, headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...env, IMPORT_SERVICE_SECRET: importSecret, VOTES_READ_SECRET: 'readonly', TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: 'webhook' }) });

  it('isolates credentials, refuses writes outside D1 mode and serves reads in every mode', async () => {
    await seedUsers();
    await env.DB.prepare("UPDATE users SET status='paused' WHERE id=?").bind(alice).run();
    const { call, t } = backend();
    const digest = env.DIGEST_SERVICE_SECRET;
    const runPath = `/users/${alice}/digest-runs/${crypto.randomUUID()}`;
    const writes: [string, string][] = [[`/users/${alice}/digest-runs`, 'POST'], [`${runPath}/items/0`, 'PUT'], [`${runPath}/prepare`, 'POST'],
      [`${runPath}/abort`, 'POST'], [`${runPath}/destinations/${aliceDestination}/deliver`, 'POST'], ['/ops/alerts', 'POST']];
    for (const [path, method] of writes) {
      for (const secret of [undefined, 'readonly', importSecret, 'webhook']) expect((await call(secret, path, method, {})).status, path).toBe(401);
      const refused = await call(digest, path, method, {});
      expect(refused.status, path).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: 'mode_unavailable' } });
    }
    const resolve = `/admin/users/${alice}/digest-runs/${crypto.randomUUID()}/messages/${crypto.randomUUID()}/resolve`;
    for (const secret of [undefined, digest, 'readonly']) expect((await call(secret, resolve, 'POST', {})).status).toBe(401);
    expect((await call(importSecret, resolve, 'POST', {})).status).toBe(409);
    const context = await call(digest, '/users/by-slug/alice/context');
    expect(context.status).toBe(200);
    expect(context.headers.get('cache-control')).toBe('no-store');
    const body = await context.json() as { user: { status: string; destinationIds: string[]; profile: { sources: unknown[] } } };
    expect(body.user).toMatchObject({ status: 'paused', destinationIds: [aliceDestination], opsDestinationIds: [] });
    expect(JSON.stringify(body)).not.toMatch(/example\.test|"100"/);
    expect((await call(digest, '/users/by-slug/nobody/context')).status).toBe(404);
    expect(await (await call(digest, `/users/${alice}/digest-runs?period=2026-W38`)).json()).toEqual({ runs: [] });
    expect((await call(digest, `/users/${alice}/digest-runs`)).status).toBe(400);
    expect((await call(digest, `${runPath}`)).status).toBe(404);
    expect(t.calls).toHaveLength(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM digest_runs').first('n')).toBe(0);
  });

  it('runs the whole lifecycle over HTTP in D1 mode', async () => {
    await seedUsers();
    await d1Mode();
    const { call, t } = backend();
    const digest = env.DIGEST_SERVICE_SECRET;
    const r = run(alice, 2);
    expect((await call(digest, `/users/${alice}/digest-runs`, 'POST', r)).status).toBe(200);
    expect((await call(digest, `/users/${bob}/digest-runs`, 'POST', r)).status).toBe(400);
    const xs = [scored('1001', 'selected'), scored('1002', 'filtered')];
    expect((await call(digest, `/users/${alice}/digest-runs/${r.id}/items/0`, 'PUT', { items: xs })).status).toBe(200);
    const prepared = await call(digest, `/users/${alice}/digest-runs/${r.id}/prepare`, 'POST', { metrics: { cost: 0.01 }, destinations: [{ destinationId: aliceDestination, messages: render(xs) }] });
    expect(await prepared.json()).toMatchObject({ status: 'prepared', messages: { pending: 3 } });
    const states: string[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await call(digest, `/users/${alice}/digest-runs/${r.id}/destinations/${aliceDestination}/deliver`, 'POST', {});
      const { state } = await response.json() as { state: string };
      states.push(state);
      if (state === 'done') break;
    }
    expect(states).toEqual(['sent', 'sent', 'done']);
    expect(t.calls).toHaveLength(3);
    expect(await (await call(digest, `/users/${alice}/digest-runs?period=2026-W38`)).json()).toMatchObject({ runs: [{ id: r.id, status: 'succeeded', messages: { sent: 3 } }] });
  });
});
