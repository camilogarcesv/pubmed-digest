import { z } from 'zod';
import { DomainError, UserId } from '../../src/multiuser/contracts.js';
import { checksum } from '../../src/multiuser/import-contracts.js';
import { LedgerBlock, LedgerManifest, articleHash } from '../../src/multiuser/ledger-extension.js';
import { ImportRepository, type VerifiedSnapshot } from './imports.js';
import { articleRecords, ledgerProvenance } from './ledger-history.js';

const conflict = () => new DomainError('conflict', 'Ledger extension conflict');
export class LedgerExtensionRepository {
  constructor(private readonly db: D1Database) {}
  private guard(owner: string, valid: string, args: (string | number)[]) {
    z.uuid().parse(owner);
    return this.db.prepare(`INSERT INTO operation_assertions(owner,kind,valid) VALUES(?,'import',(${valid}))`).bind(owner, ...args);
  }
  private guardSnapshot(owner: string, snapshots: VerifiedSnapshot[], valid: string, args: (string | number)[]) {
    return this.guard(owner, snapshots.map(s => `(${s.sql})=?`).join(' AND ') + ` AND (${valid})`, [...snapshots.flatMap(s => [s.userId, s.raw]), ...args]);
  }
  private clear() { return this.db.prepare('DELETE FROM operation_assertions'); }
  private async verifyImport(userId: string) {
    UserId.parse(userId);
    const session = await this.db.prepare("SELECT id FROM import_sessions WHERE user_id=? AND status='finalized'").bind(userId).first<{ id: string }>();
    if (!session) throw conflict();
    return new ImportRepository(this.db).verifiedState(session.id);
  }
  private async session(userId: string, id: string) {
    UserId.parse(userId); z.uuid().parse(id);
    const row = await this.db.prepare('SELECT manifest_json,manifest_hash,status,sequence FROM ledger_extensions WHERE id=? AND user_id=?')
      .bind(id, userId).first<{ manifest_json: string; manifest_hash: string; status: string; sequence: number }>();
    if (!row) throw new DomainError('not_found', 'Ledger extension not found');
    const manifest = LedgerManifest.parse(JSON.parse(row.manifest_json));
    if (manifest.userId !== userId || manifest.id !== id || await checksum(manifest) !== row.manifest_hash) throw conflict();
    return { ...row, manifest };
  }
  async snapshot(userId: string) {
    const state = await this.verifyImport(userId);
    const records = articleRecords(JSON.parse(state.snapshots[0].raw));
    return { userId, records, checksum: await articleHash(records) };
  }
  async status(userId: string, id: string) {
    const session = await this.session(userId, id);
    const blocks = await this.db.prepare('SELECT block_index AS blockIndex,checksum FROM ledger_extension_blocks WHERE extension_id=? ORDER BY block_index').bind(id).all();
    return { status: session.status, manifestHash: session.manifest_hash, blocks: blocks.results };
  }
  async create(owner: string, userId: string, input: unknown) {
    const m = LedgerManifest.parse(input), hash = await checksum(m);
    if (userId !== m.userId) throw conflict();
    const prior = () => this.db.prepare('SELECT user_id,manifest_hash FROM ledger_extensions WHERE id=?').bind(m.id).first<{ user_id: string; manifest_hash: string }>();
    const existing = await prior();
    if (existing) {
      if (existing.user_id !== userId || existing.manifest_hash !== hash) throw conflict();
      return this.status(userId, m.id);
    }
    const state = await this.verifyImport(userId);
    const current = { records: articleRecords(JSON.parse(state.snapshots[0].raw)) };
    if (current.records.length !== m.beforeCount || await articleHash(current.records) !== m.beforeHash) throw conflict();
    if (await this.db.prepare("SELECT 1 FROM data_imports WHERE user_id=? AND kind='state' AND source_ref=?").bind(userId, m.stateSha).first()) throw conflict();
    const sequence = Number(await this.db.prepare('SELECT coalesce(max(sequence),0)+1 AS n FROM ledger_extensions WHERE user_id=?').bind(userId).first('n'));
    try {
      await this.db.batch([
        this.guardSnapshot(owner, state.snapshots, `NOT EXISTS(SELECT 1 FROM ledger_extensions WHERE user_id=? AND status='open')
          AND (SELECT coalesce(max(sequence),0)+1 FROM ledger_extensions WHERE user_id=?)=?
          AND NOT EXISTS(SELECT 1 FROM data_imports WHERE user_id=? AND kind='state' AND source_ref=?)
          AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='paused')`, [userId, userId, sequence, userId, m.stateSha, userId]),
        this.db.prepare("INSERT INTO ledger_extensions VALUES(?,?,?,?,?,'open')").bind(m.id, userId, sequence, hash, JSON.stringify(m)),
        this.clear(),
      ]);
    } catch { const found = await prior(); if (found?.user_id !== userId || found.manifest_hash !== hash) throw conflict(); }
    return this.status(userId, m.id);
  }
  async put(owner: string, userId: string, id: string, input: unknown) {
    const block = LedgerBlock.parse(input), session = await this.session(userId, id), m = session.manifest;
    const expected = m.blocks[block.index];
    if (!expected || block.checksum !== expected.checksum || block.records.length !== expected.count || await checksum(block.records) !== block.checksum) throw conflict();
    const prior = () => this.db.prepare('SELECT checksum FROM ledger_extension_blocks WHERE extension_id=? AND block_index=?').bind(id, block.index).first<{ checksum: string }>();
    const existing = await prior();
    if (existing) { if (existing.checksum !== block.checksum) throw conflict(); return { checksum: block.checksum }; }
    if (session.status !== 'open') throw conflict();
    const state = await this.verifyImport(userId);
    const current = { records: articleRecords(JSON.parse(state.snapshots[0].raw)) };
    if (block.index === m.blocks.length - 1) {
      const completed = [...current.records, ...block.records];
      if (completed.length !== m.afterCount || await articleHash(completed) !== m.afterHash) throw conflict();
    }
    try {
      await this.db.batch([
        this.guardSnapshot(owner, state.snapshots, `EXISTS(SELECT 1 FROM ledger_extensions WHERE id=? AND user_id=? AND status='open')
          AND (SELECT count(*) FROM ledger_extension_blocks WHERE extension_id=?)=?
          AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='paused')`, [id, userId, id, block.index, userId]),
        this.db.prepare('INSERT INTO ledger_extension_blocks VALUES(?,?,?,?)').bind(id, block.index, block.checksum, JSON.stringify(block.records)),
        ...block.records.flatMap(r => [
          this.db.prepare('INSERT INTO articles VALUES(?,?,NULL,NULL,?)').bind(r.pmid, r.title ?? '', m.capturedAt),
          this.db.prepare('INSERT INTO user_articles(user_id,pmid,first_seen,relevance,delivered,legacy_title) VALUES(?,?,?,?,?,?)')
            .bind(userId, r.pmid, r.firstSeen, r.relevance, Number(r.delivered), r.title),
        ]),
        this.clear(),
      ]);
    } catch { if ((await prior())?.checksum !== block.checksum) throw conflict(); }
    return { checksum: block.checksum };
  }
  async verify(userId: string, id: string) {
    const session = await this.session(userId, id);
    if (session.status !== 'finalized') throw conflict();
    const state = await this.verifyImport(userId);
    const records = articleRecords(JSON.parse(state.snapshots[0].raw));
    return { verified: true, finalized: true, extensionId: id, manifestHash: session.manifest_hash, articles: records.length, checksum: await articleHash(records) };
  }
  async finalize(owner: string, userId: string, id: string) {
    const session = await this.session(userId, id), m = session.manifest;
    const state = await this.verifyImport(userId);
    if (session.status === 'finalized') return { ...state.verified, finalized: true };
    const current = { records: articleRecords(JSON.parse(state.snapshots[0].raw)) };
    if (current.records.length !== m.afterCount || await articleHash(current.records) !== m.afterHash) throw conflict();
    const p = ledgerProvenance(m);
    try {
      await this.db.batch([
        this.guardSnapshot(owner, state.snapshots, `EXISTS(SELECT 1 FROM ledger_extensions WHERE id=? AND user_id=? AND status='open')
          AND (SELECT count(*) FROM ledger_extension_blocks WHERE extension_id=?)=?
          AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='paused')`, [id, userId, id, m.blocks.length, userId]),
        this.db.prepare('INSERT INTO data_imports(id,user_id,kind,source_ref,code_sha,checksum,counts_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
          .bind(p.id, p.user_id, p.kind, p.source_ref, p.code_sha, p.checksum, p.counts_json, p.created_at),
        this.db.prepare("UPDATE ledger_extensions SET status='finalized' WHERE id=? AND user_id=?").bind(id, userId),
        this.clear(),
      ]);
    } catch { throw conflict(); }
    return { ...state.verified, finalized: true };
  }
}
