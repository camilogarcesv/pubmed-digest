import { AuthorityCommand } from '../../src/multiuser/authority.js';
import { DomainError } from '../../src/multiuser/contracts.js';
import { checksum, ImportManifest } from '../../src/multiuser/import-contracts.js';
import { isoWeek } from '../../src/multiuser/allocation.js';
import { clear, fenced, guard } from './digest-fence.js';
import { ImportRepository, votesSnapshotSql, type VerifiedSnapshot } from './imports.js';
import { articlesSnapshotSql } from './ledger-history.js';

const idle = `NOT EXISTS(SELECT 1 FROM legacy_vote_inflight)
  AND NOT EXISTS(SELECT 1 FROM delivery_messages WHERE status='sending')
  AND NOT EXISTS(SELECT 1 FROM operation_lock WHERE expires_at>unixepoch())`;
const conflict = () => new DomainError('conflict', 'Authority preconditions changed');
type Checkpoint = { user_id: string; destination_id: string; code_sha: string; state_sha: string; proof_json: string; proof_hash: string; activated_at: string | null };

export class AuthorityRepository {
  constructor(private readonly db: D1Database, private readonly codeSha?: string) {}
  async status() {
    const rows = await this.db.batch<Record<string, unknown>>([
      this.db.prepare('SELECT mode FROM system_controls WHERE singleton=1'),
      this.db.prepare('SELECT proof_hash AS proofHash,first_period AS firstPeriod,activated_at AS activatedAt FROM authority_checkpoint'),
      this.db.prepare("SELECT (SELECT count(*) FROM legacy_vote_inflight) AS legacyWrites,(SELECT count(*) FROM delivery_messages WHERE status='sending') AS sending"),
      this.db.prepare('SELECT id,started_at AS startedAt FROM legacy_vote_inflight ORDER BY started_at,id LIMIT 100'),
    ]);
    return { ...rows[0].results[0], checkpoint: rows[1].results[0] ?? null, ...rows[2].results[0], pendingLegacy: rows[3].results };
  }
  async verify() {
    const checkpoint = await this.db.prepare('SELECT * FROM authority_checkpoint WHERE singleton=1').first<Checkpoint>();
    if (!checkpoint?.activated_at) throw conflict();
    const proof = JSON.parse(checkpoint.proof_json) as { snapshots: VerifiedSnapshot[] };
    if (await checksum(proof) !== checkpoint.proof_hash) throw conflict();
    // Migration history stays immutable; live articles, votes and user status legitimately evolve.
    const historical = proof.snapshots.filter(p => /FROM (import_sessions|import_blocks|ledger_extensions|ledger_extension_blocks|vote_reconciliations|data_imports)\b/.test(p.sql));
    const ledger = proof.snapshots.find(p => p.sql === articlesSnapshotSql);
    const baselineVotes = proof.snapshots.find(p => p.sql === votesSnapshotSql);
    if (!ledger || !baselineVotes) throw conflict();
    const checks = await this.db.batch<{ valid: number }>([
      ...historical.map(p => this.db.prepare(`SELECT ((${p.sql})=?) AS valid`).bind(p.userId, p.raw)),
      this.db.prepare(`SELECT NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN votes v
        ON v.user_id=? AND v.pmid=json_extract(j.value,'$.pmid') WHERE v.user_id IS NULL) AS valid`).bind(baselineVotes.raw, checkpoint.user_id),
      this.db.prepare(`SELECT NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN user_articles a
        ON a.user_id=? AND a.pmid=json_extract(j.value,'$.pmid') WHERE a.user_id IS NULL
        OR a.first_seen IS NOT json_extract(j.value,'$.firstSeen') OR a.relevance IS NOT json_extract(j.value,'$.relevance')
        OR a.delivered IS NOT json_extract(j.value,'$.delivered') OR a.legacy_title IS NOT json_extract(j.value,'$.title')
        OR a.run_id IS NOT NULL) AS valid`).bind(ledger.raw, checkpoint.user_id),
      this.db.prepare(`SELECT NOT EXISTS(SELECT 1 FROM digest_runs r WHERE r.status='succeeded' AND (
        EXISTS(SELECT 1 FROM delivery_messages m WHERE m.run_id=r.id AND m.status NOT IN ('sent','reconciled_sent'))
        OR EXISTS(SELECT 1 FROM digest_items i LEFT JOIN user_articles a ON a.user_id=i.user_id AND a.pmid=i.pmid
          WHERE i.run_id=r.id AND (a.run_id IS NULL OR a.run_id!=r.id OR a.relevance IS NOT i.relevance
            OR a.delivered!=(i.disposition='selected'))))) AS valid`),
      this.db.prepare(`SELECT NOT EXISTS(SELECT 1 FROM votes v LEFT JOIN user_articles a ON a.user_id=v.user_id AND a.pmid=v.pmid
        WHERE a.user_id IS NULL AND NOT EXISTS(SELECT 1 FROM delivery_messages m WHERE m.user_id=v.user_id AND m.pmid=v.pmid
          AND m.votable=1 AND m.status IN ('sent','reconciled_sent'))) AS valid`),
    ]);
    if (checks.some(c => c.results[0]?.valid !== 1) || (await this.db.prepare('PRAGMA foreign_key_check').all()).results.length) throw conflict();
    const counts = await this.db.prepare(`SELECT (SELECT count(*) FROM digest_runs) AS runs,
      (SELECT count(*) FROM digest_runs WHERE status='succeeded') AS succeeded,
      (SELECT count(*) FROM delivery_messages WHERE status IN ('failed','unknown')) AS unresolved,
      (SELECT count(*) FROM votes) AS votes`).first();
    return { verified: true, counts };
  }
  async execute(input: unknown) {
    const command = AuthorityCommand.parse(input), hash = await checksum(command);
    const previous = await this.db.prepare('SELECT payload_hash FROM authority_events WHERE id=?').bind(command.id).first<{ payload_hash: string }>();
    if (previous) { if (previous.payload_hash !== hash) throw conflict(); return this.status(); }
    const at = new Date().toISOString();
    const writes: D1PreparedStatement[] = [guard(this.db,
      '(SELECT mode FROM system_controls WHERE singleton=1)=? AND NOT EXISTS(SELECT 1 FROM operation_lock WHERE expires_at>unixepoch())', [command.expectedMode])];
    if (command.action === 'maintenance') {
      // Stop new claims immediately; outcomes of already-started requests can still be recorded.
      writes.push(this.db.prepare("UPDATE system_controls SET mode='maintenance',updated_at=? WHERE singleton=1").bind(at));
    } else if (command.action === 'quiesce') {
      if (command.expectedMode !== 'maintenance') throw conflict();
      writes.push(this.db.prepare(`UPDATE delivery_messages SET status='unknown',updated_at=?
        WHERE status='sending' AND julianday(updated_at)<=julianday(?)-15.0/1440`).bind(at, at),
      this.db.prepare(`UPDATE digest_runs SET status='needs_reconciliation',updated_at=? WHERE status='delivering'
        AND EXISTS(SELECT 1 FROM delivery_messages m WHERE m.run_id=digest_runs.id AND m.status='unknown')`).bind(at));
    } else if (command.action === 'release_legacy') {
      if (command.expectedMode !== 'maintenance') throw conflict();
      // Explicit operator evidence is mandatory: elapsed time alone never releases a claim.
      writes.push(guard(this.db, `EXISTS(SELECT 1 FROM legacy_vote_inflight WHERE id=? AND julianday(started_at)<=julianday(?)-15.0/1440)`, [command.claimId, at]),
        this.db.prepare('DELETE FROM legacy_vote_inflight WHERE id=?').bind(command.claimId));
    } else if (command.action === 'cancel') {
      // Before activation D1 has accepted no authoritative write: KV and state resume, and an
      // unactivated seal is discarded so the transition restarts from a fresh final delta.
      if (command.expectedMode !== 'maintenance') throw conflict();
      writes.push(guard(this.db, 'NOT EXISTS(SELECT 1 FROM authority_checkpoint WHERE activated_at IS NOT NULL)', []),
        this.db.prepare('DELETE FROM authority_checkpoint WHERE activated_at IS NULL'),
        this.db.prepare("UPDATE system_controls SET mode='legacy',updated_at=? WHERE singleton=1").bind(at));
    } else {
      if (command.expectedMode !== 'maintenance') throw conflict();
      writes.push(guard(this.db, idle, []));
      if (command.action === 'seal') {
        if (this.codeSha !== undefined && command.codeSha !== this.codeSha) throw conflict();
        if (command.firstPeriod <= isoWeek(new Date())) throw conflict();
        const imports = new ImportRepository(this.db);
        const { snapshots } = await imports.verifiedState(command.importId);
        const session = await this.db.prepare("SELECT manifest_json FROM import_sessions WHERE id=? AND status='finalized'").bind(command.importId).first<{ manifest_json: string }>();
        if (!session) throw conflict();
        const manifest = ImportManifest.parse(JSON.parse(session.manifest_json));
        const latest = await this.db.prepare("SELECT source_ref FROM data_imports WHERE user_id=? AND kind='state' ORDER BY created_at DESC,id DESC LIMIT 1")
          .bind(manifest.identity.id).first<{ source_ref: string }>();
        if (latest?.source_ref !== command.stateSha) throw conflict();
        writes.push(guard(this.db, "NOT EXISTS(SELECT 1 FROM authority_checkpoint) AND NOT EXISTS(SELECT 1 FROM digest_runs) AND NOT EXISTS(SELECT 1 FROM users WHERE status!='paused')", []));
        writes.push(this.proofGuard(snapshots));
        const proof = { snapshots, codeSha: command.codeSha, stateSha: command.stateSha, firstPeriod: command.firstPeriod };
        if (new TextEncoder().encode(JSON.stringify(proof)).byteLength > 1_800_000) throw new DomainError('conflict', 'Checkpoint exceeds the bounded row size');
        writes.push(this.db.prepare(`INSERT INTO authority_checkpoint VALUES(1,?,?,?,?,?,?,?,?,?,NULL)`)
          .bind(manifest.identity.id, manifest.identity.destinationId, command.importId, command.codeSha, command.stateSha,
            command.firstPeriod, JSON.stringify(proof), await checksum(proof), at));
      } else {
        const checkpoint = await this.db.prepare('SELECT * FROM authority_checkpoint WHERE singleton=1').first<Checkpoint>();
        if (!checkpoint) throw conflict();
        if (command.action === 'activate') {
          if (checkpoint.state_sha !== command.stateSha) throw conflict();
          if (this.codeSha !== undefined && checkpoint.code_sha !== this.codeSha) throw conflict();
          if (checkpoint.activated_at || checkpoint.proof_hash !== command.proofHash) throw conflict();
          const proof = JSON.parse(checkpoint.proof_json) as { snapshots: VerifiedSnapshot[] };
          if (await checksum(proof) !== checkpoint.proof_hash) throw conflict();
          writes.push(this.proofGuard(proof.snapshots));
          writes.push(this.db.prepare("UPDATE users SET status='active' WHERE id=?").bind(checkpoint.user_id),
            this.db.prepare("UPDATE destinations SET status='active',digest_enabled=1,ops_enabled=1 WHERE user_id=? AND id=?").bind(checkpoint.user_id, checkpoint.destination_id),
            this.db.prepare('UPDATE authority_checkpoint SET activated_at=? WHERE singleton=1 AND activated_at IS NULL').bind(at));
        } else if (!checkpoint.activated_at) throw conflict();
        writes.push(this.db.prepare("UPDATE system_controls SET mode='d1',updated_at=? WHERE singleton=1").bind(at));
      }
    }
    writes.push(this.db.prepare('INSERT INTO authority_events VALUES(?,?,?,?,?,?,?)').bind(command.id, hash, JSON.stringify(command), command.action, command.actor, command.reason, at), clear(this.db));
    try { await fenced(this.db, writes, 'Authority preconditions changed'); }
    catch (error) {
      const committed = await this.db.prepare('SELECT payload_hash FROM authority_events WHERE id=?').bind(command.id).first<{ payload_hash: string }>();
      if (committed?.payload_hash !== hash) throw error;
    }
    return this.status();
  }
  private proofGuard(proof: VerifiedSnapshot[]) {
    return guard(this.db, proof.map(p => `(${p.sql})=?`).join(' AND '), proof.flatMap(p => [p.userId, p.raw]));
  }
}
