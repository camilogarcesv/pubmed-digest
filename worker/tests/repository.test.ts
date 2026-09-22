import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { computeEvalMetrics } from '../../src/votes.js';
import { alice, bob, aliceDestination, bobDestination, article, item, ledger, profile, run, seedUsers, timestamp } from './fixtures.js';

describe('D1 tenant isolation and migration', () => {
  it('applies from empty and replays migrations without losing data', async () => {
    const repository = await seedUsers();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(await repository.contexts()).toHaveLength(2);
    const tables = await env.DB.prepare("PRAGMA table_list").all<{ name: string; strict: number }>();
    expect(tables.results.filter(t => ['users', 'digest_runs', 'votes'].includes(t.name)).every(t => t.strict === 1)).toBe(true);
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('upgrades an existing v1 database without changing existing records', async () => {
    const db = env.MIGRATION_DB;
    await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 1));
    const firstMigration = (await db.prepare('SELECT * FROM d1_migrations ORDER BY id').all()).results;
    await db.prepare("INSERT INTO users(id,slug,email,timezone,status,created_at) VALUES(?,?,?,'UTC','active',?)")
      .bind(alice, 'alice', 'alice@example.test', timestamp).run();
    await db.prepare('INSERT INTO profile_versions VALUES(?,1,?,1,?)').bind(alice, JSON.stringify(profile), timestamp).run();
    const before = await db.prepare('SELECT * FROM profile_versions').all();
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    expect((await db.prepare('SELECT * FROM profile_versions').all()).results).toEqual(before.results);
    await expect(db.prepare("UPDATE profile_versions SET config_json='{}'").run()).rejects.toThrow('new profile version');
    expect((await db.prepare('SELECT * FROM d1_migrations').all()).results).toHaveLength(env.TEST_MIGRATIONS.length);
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    expect((await db.prepare('SELECT * FROM d1_migrations ORDER BY id LIMIT 1').all()).results).toEqual(firstMigration);
    expect((await db.prepare('SELECT name FROM sqlite_schema WHERE type=\'trigger\'').all()).results).toHaveLength(9);
  });

  it('keeps seen, score, vote and eval independent for the same PMID', async () => {
    const repository = await seedUsers();
    await repository.importLedger(alice, [{ article: article(), entry: ledger(alice) }]);
    expect(await repository.seen({ pairs: [{ userId: alice, pmid: '123' }, { userId: bob, pmid: '123' }] })).toEqual([true, false]);
    await repository.importLedger(bob, [{ article: article(), entry: ledger(bob, '123', 0) }]);
    await repository.importVote({ userId: alice, destinationId: aliceDestination, pmid: '123', value: 1, votedAt: timestamp });
    await repository.importVote({ userId: bob, destinationId: bobDestination, pmid: '123', value: 0, votedAt: timestamp });
    expect(await repository.evalContext(alice)).toEqual([{ pmid: '123', title: 'Paper 123', score: 9, value: 1, votedAt: timestamp }]);
    expect(await repository.evalContext(bob)).toEqual([{ pmid: '123', title: 'Paper 123', score: 0, value: 0, votedAt: timestamp }]);
    const evaluate = async (id: string) => computeEvalMetrics((await repository.evalContext(id)).flatMap(v => v.score === null ? [] : [{ ...v, score: v.score }]), 7);
    expect((await evaluate(alice)).liked).toBe(1);
    expect((await evaluate(bob)).liked).toBe(0);
    expect((await evaluate(alice)).status).toBe('insufficient_data');
  });

  it('does not expose email/chat identifiers and excludes paused users/destinations', async () => {
    const repository = await seedUsers();
    const contexts = await repository.contexts();
    expect(contexts[0].profile.sources).toEqual([{ kind: 'journal', value: 'AJNR' }]);
    expect(contexts[0].profile.profile).toEqual(profile);
    expect(JSON.stringify(contexts)).not.toContain('@example.test');
    expect(JSON.stringify(contexts)).not.toContain('externalId');
    await env.DB.prepare("UPDATE users SET status='paused' WHERE id=?").bind(bob).run();
    await env.DB.prepare("UPDATE destinations SET status='paused' WHERE id=?").bind(aliceDestination).run();
    expect(await repository.contexts()).toMatchObject([{ userId: alice, destinationIds: [] }]);
  });

  it('rejects cross-user foreign keys for profiles, destinations, runs and votes', async () => {
    const repository = await seedUsers();
    await repository.importLedger(alice, [{ article: article(), entry: ledger(alice) }]);
    await expect(repository.importVote({ userId: bob, destinationId: aliceDestination, pmid: '123', value: 0, votedAt: timestamp })).rejects.toThrow();
    const created = await repository.createRun(run());
    await expect(repository.getRun(bob, created.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(env.DB.prepare("INSERT INTO digest_chunks VALUES(?,?,0,?)").bind(bob, created.id, 'b'.repeat(64)).run()).rejects.toThrow();
    await repository.importLedger(bob, [{ article: article(), entry: ledger(bob) }]);
    await expect(env.DB.prepare('UPDATE user_articles SET run_id=? WHERE user_id=?').bind(created.id, bob).run()).rejects.toThrow();
    await env.DB.prepare('INSERT INTO profile_versions VALUES(?,2,?,0,?)').bind(alice, JSON.stringify(profile), timestamp).run();
    await expect(repository.createRun({ ...run(bob), profileVersion: 2 })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rolls back all writes in a failed import batch and preserves explicit zero/legacy delivery', async () => {
    const repository = await seedUsers();
    await expect(repository.importLedger(alice, [
      { article: article(), entry: ledger(alice) }, { article: article(), entry: ledger(alice) },
    ])).rejects.toThrow();
    expect((await env.DB.prepare('SELECT * FROM articles').all()).results).toEqual([]);
    await repository.importLedger(alice, [{ article: article(), entry: ledger(alice, '123', 0) }]);
    expect(await env.DB.prepare('SELECT relevance,delivered,delivered_at FROM user_articles').first()).toEqual({ relevance: 0, delivered: 1, delivered_at: null });
    await expect(env.DB.prepare('UPDATE user_articles SET relevance=11').run()).rejects.toThrow();
  });

  it('enforces one active profile and immutable profile contents', async () => {
    await seedUsers();
    await expect(env.DB.prepare('INSERT INTO profile_versions VALUES(?,2,?,1,?)').bind(alice, JSON.stringify(profile), timestamp).run()).rejects.toThrow();
    await expect(env.DB.prepare("UPDATE profile_versions SET config_json='{}' WHERE user_id=?").bind(alice).run()).rejects.toThrow();
  });

  it('enforces a total source order across journals and queries', async () => {
    await seedUsers();
    await expect(env.DB.prepare("INSERT INTO profile_sources VALUES(?,1,'query','MRI',0)").bind(alice).run()).rejects.toThrow();
    await env.DB.prepare("INSERT INTO profile_sources VALUES(?,1,'query','MRI',1)").bind(alice).run();
    const repository = new (await import('../multiuser/repository.js')).D1DigestRepository(env.DB);
    const context = (await repository.contexts()).find(u => u.userId === alice)!;
    expect(context.profile.sources).toEqual([{ kind: 'journal', value: 'AJNR' }, { kind: 'query', value: 'MRI' }]);
  });

  it('uses indexes for scoped ledger and vote lookup', async () => {
    await seedUsers();
    const ledgerPlan = await env.DB.prepare('EXPLAIN QUERY PLAN SELECT * FROM user_articles WHERE user_id=? AND pmid=?').bind(alice, '123').all<{ detail: string }>();
    const votePlan = await env.DB.prepare('EXPLAIN QUERY PLAN SELECT * FROM votes WHERE user_id=? ORDER BY voted_at DESC,pmid').bind(alice).all<{ detail: string }>();
    expect(ledgerPlan.results.some(r => r.detail.includes('INDEX'))).toBe(true);
    expect(votePlan.results.some(r => r.detail.includes('votes_user_time'))).toBe(true);
  });
});

describe('draft idempotency and reservations', () => {
  it('enforces both draft triggers for direct writes that bypass the repository', async () => {
    const repository = await seedUsers();
    const created = await repository.createRun(run(alice, 2));
    await repository.putItems(alice, created.id, 0, [item()]);
    await repository.importLedger(alice, [{ article: article('124'), entry: ledger(alice, '124') }]);
    for (const status of ['prepared', 'delivering', 'needs_reconciliation', 'succeeded', 'aborted']) {
      await env.DB.prepare('UPDATE digest_runs SET status=? WHERE id=?').bind(status, created.id).run();
      await expect(env.DB.prepare('INSERT INTO digest_chunks VALUES(?,?,1,?)')
        .bind(alice, created.id, 'a'.repeat(64)).run()).rejects.toThrow('run is not a draft');
      await expect(env.DB.prepare("INSERT INTO digest_items VALUES(?,?,'124',9,NULL,'test','selected')")
        .bind(alice, created.id).run()).rejects.toThrow('run is not a draft');
    }
    expect((await env.DB.prepare('SELECT * FROM digest_chunks').all()).results).toHaveLength(1);
    expect((await env.DB.prepare('SELECT * FROM digest_items').all()).results).toHaveLength(1);
  });

  it('retries by stable key, rejects changed input, and keeps the ledger untouched', async () => {
    const repository = await seedUsers();
    const input = run();
    const first = await repository.createRun(input);
    expect((await repository.createRun({ ...input, id: crypto.randomUUID() })).id).toBe(first.id);
    await expect(repository.createRun({ ...input, payloadHash: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.createRun({ ...input, kind: 'search' })).rejects.toMatchObject({ code: 'conflict' });
    await repository.putItems(alice, first.id, 0, [item()]);
    await repository.putItems(alice, first.id, 0, [item()]);
    await expect(repository.putItems(alice, first.id, 0, [item('124')])).rejects.toMatchObject({ code: 'conflict' });
    expect((await env.DB.prepare('SELECT * FROM user_articles').all()).results).toEqual([]);
    expect((await env.DB.prepare('SELECT * FROM digest_items').all()).results).toHaveLength(1);
    expect(await repository.seen({ pairs: [{ userId: alice, pmid: '123' }, { userId: bob, pmid: '123' }] })).toEqual([true, false]);
    await env.DB.prepare("UPDATE digest_runs SET status='needs_reconciliation' WHERE id=?").bind(first.id).run();
    expect(await repository.seen({ pairs: [{ userId: alice, pmid: '123' }] })).toEqual([true]);
  });

  it('keeps chunks atomic when a later item exceeds expected count', async () => {
    const repository = await seedUsers();
    const created = await repository.createRun(run());
    await expect(repository.putItems(alice, created.id, 0, [item(), item('124')])).rejects.toThrow('too many run items');
    for (const table of ['articles', 'digest_items', 'digest_chunks']) expect((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results).toHaveLength(0);
  });

  it('never inserts items into a non-draft run and releases aborted reservations only', async () => {
    const repository = await seedUsers();
    const created = await repository.createRun(run(alice, 2));
    await repository.putItems(alice, created.id, 0, [item()]);
    await env.DB.prepare("UPDATE digest_runs SET status='aborted' WHERE id=?").bind(created.id).run();
    await expect(repository.putItems(alice, created.id, 1, [item('124')])).rejects.toThrow('not a draft');
    expect(await repository.seen({ pairs: [{ userId: alice, pmid: '123' }] })).toEqual([false]);
  });

  it('supports maximum chunks/pairs without per-row query fan-out in seen', async () => {
    const repository = await seedUsers();
    const created = await repository.createRun(run(alice, 15));
    await repository.putItems(alice, created.id, 0, Array.from({ length: 15 }, (_, i) => item(String(i + 1))));
    const pairs = Array.from({ length: 50 }, (_, i) => ({ userId: alice, pmid: String(i + 1) }));
    expect((await repository.seen({ pairs })).filter(Boolean)).toHaveLength(15);
    await expect(repository.seen({ pairs: [...pairs, pairs[0]] })).rejects.toThrow();
  });

  it('concurrent identical chunks converge without duplicate records', async () => {
    const repository = await seedUsers();
    const created = await repository.createRun(run());
    await Promise.all([repository.putItems(alice, created.id, 0, [item()]), repository.putItems(alice, created.id, 0, [item()])]);
    expect((await env.DB.prepare('SELECT * FROM digest_items').all()).results).toHaveLength(1);
    expect((await env.DB.prepare('SELECT * FROM digest_chunks').all()).results).toHaveLength(1);
  });
});

describe('votes from delivered Telegram messages', () => {
  it('validates owner, chat, message, PMID and delivery status before recording', async () => {
    const repository = await seedUsers();
    const created = await repository.createRun(run());
    await repository.putItems(alice, created.id, 0, [item()]);
    const insert = (destination: string) => env.DB.prepare(`INSERT INTO delivery_messages
      (id,user_id,run_id,destination_id,position,kind,pmid,votable,payload_json,status,telegram_message_id,updated_at)
      VALUES(?,?,?,?,0,'paper','123',1,'{}','sent','77',?)`).bind(crypto.randomUUID(), alice, created.id, destination, timestamp).run();
    await expect(insert(bobDestination)).rejects.toThrow();
    await insert(aliceDestination);
    expect(await repository.recordTelegramVote('200', '77', '123', 0, timestamp)).toBe(false);
    expect(await repository.recordTelegramVote('100', '78', '123', 0, timestamp)).toBe(false);
    expect(await repository.recordTelegramVote('100', '77', '124', 0, timestamp)).toBe(false);
    expect(await repository.recordTelegramVote('100', '77', '123', 1, timestamp)).toBe(true);
    expect(await repository.recordTelegramVote('100', '77', '123', 0, '2026-09-14T12:00:00.000Z')).toBe(false);
    expect(await repository.evalContext(bob)).toEqual([]);
    expect((await repository.evalContext(alice))[0].value).toBe(1);
    await env.DB.prepare("UPDATE delivery_messages SET status='unknown'").run();
    expect(await repository.recordTelegramVote('100', '77', '123', 0, '2026-09-16T12:00:00.000Z')).toBe(false);
  });
});
