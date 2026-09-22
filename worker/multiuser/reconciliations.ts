import { z } from 'zod';
import { DomainError, UserId } from '../../src/multiuser/contracts.js';
import { ImportRecord, canonical } from '../../src/multiuser/import-contracts.js';
import {
  MAX_STEP_CHANGES, VoteState, parseCapture, planReconciliation, replayForward,
  type ReconciliationPlan, type VoteCapture, type VoteMap,
} from '../../src/multiuser/vote-reconciliation.js';
import { ImportRepository, reconciliationSteps, votesSnapshotSql } from './imports.js';

const conflict = () => new DomainError('conflict', 'Vote reconciliation conflict');
const sorted = (map: VoteMap) => canonical([...map].sort(([a], [b]) => a.localeCompare(b)));

/**
 * Copies strict KV captures into D1 while KV remains the vote authority. Never deletes a vote,
 * never writes KV, and refuses to proceed on any disagreement it cannot explain.
 */
export class VoteReconciliationRepository {
  constructor(private readonly db: D1Database) {}

  // Same fencing as the import: the operation_assertions trigger requires this owner's live
  // import lease and legacy mode, and `valid` must hold inside the write transaction.
  private guard(owner: string, valid: string, args: (string | number)[]) {
    return this.db.prepare(`INSERT INTO operation_assertions(owner,kind,valid) VALUES(?,'import',(${valid}))`).bind(owner, ...args);
  }
  private clear() { return this.db.prepare('DELETE FROM operation_assertions'); }

  /** A paused user with a sealed import: the only state reconciliation is defined for. */
  private async context(userId: string) {
    UserId.parse(userId);
    const [users, destinations, sessions] = await this.db.batch([
      this.db.prepare('SELECT status FROM users WHERE id=?').bind(userId),
      this.db.prepare('SELECT id,external_id AS chatId FROM destinations WHERE user_id=? ORDER BY id').bind(userId),
      this.db.prepare("SELECT id FROM import_sessions WHERE user_id=? AND status='finalized'").bind(userId),
    ]);
    const user = users.results[0] as { status: string } | undefined;
    if (!user) throw new DomainError('not_found', 'User not found');
    const session = sessions.results[0] as { id: string } | undefined;
    if (user.status !== 'paused' || !session || destinations.results.length === 0) throw conflict();
    return { sessionId: session.id, destinations: z.array(z.object({ id: z.uuid(), chatId: z.string() })).parse(destinations.results) };
  }

  private async current(userId: string) {
    const row = await this.db.prepare(`SELECT (${votesSnapshotSql}) AS data`).bind(userId).first<{ data: string }>();
    const raw = z.string().parse(row?.data);
    const rows = JSON.parse(raw) as Array<{ pmid: string; value: number; votedAt: string; destinationId: string; source: string }>;
    try {
      return { raw, rows, votes: new Map(rows.map(r => [r.pmid, VoteState.parse({ value: r.value, votedAt: r.votedAt })])) as VoteMap };
    } catch { throw conflict(); }
  }

  private async prepare(userId: string, capture: VoteCapture) {
    const context = await this.context(userId);
    const chats = new Map(context.destinations.map(d => [d.chatId, d.id]));
    const own = capture.votes.filter(v => chats.has(v.chatId));
    const current = await this.current(userId);
    const { results } = await this.db.prepare('SELECT pmid FROM user_articles WHERE user_id=? AND pmid IN (SELECT value FROM json_each(?))')
      .bind(userId, JSON.stringify(own.map(v => v.pmid))).all<{ pmid: string }>();
    const plan = planReconciliation(own, current.votes, new Set(results.map(r => r.pmid)), capture.votes.length - own.length);
    const destinationOf = new Map(own.map(v => [v.pmid, chats.get(v.chatId)!]));
    return { plan, current, destinationOf, sessionId: context.sessionId };
  }

  private async capture(input: unknown): Promise<VoteCapture> {
    try { return await parseCapture(input); }
    catch (error) { if (error instanceof z.ZodError) throw error; throw conflict(); }
  }

  /** Read-only: what applying this capture would change, and what would block it. */
  async plan(userId: string, input: unknown): Promise<ReconciliationPlan> {
    return (await this.prepare(userId, await this.capture(input))).plan;
  }

  /**
   * Apply up to MAX_STEP_CHANGES changes as one sealed step. Call again until `remaining` is 0;
   * a retry after an unknown outcome re-plans against D1, so it can never apply a step twice.
   */
  async apply(owner: string, userId: string, input: unknown) {
    z.uuid().parse(owner);
    const capture = await this.capture(input);
    const { plan, current, destinationOf, sessionId } = await this.prepare(userId, capture);
    // Refuse to extend a chain whose current contents no longer prove the sealed import.
    await new ImportRepository(this.db).verify(sessionId);
    const reused = await this.db.prepare(`SELECT 1 FROM vote_reconciliations WHERE capture_id=?
      AND (user_id<>? OR capture_checksum<>? OR captured_at<>? OR code_sha<>?) LIMIT 1`)
      .bind(capture.id, userId, capture.checksum, capture.capturedAt, capture.codeSha).first();
    if (reused) throw conflict();
    if (plan.conflicts.length || plan.d1Only.length) throw conflict();
    const steps = await reconciliationSteps(this.db, userId);
    const step = plan.changes.slice(0, MAX_STEP_CHANGES);
    if (step.length === 0) return { applied: false, sequence: steps.length, changed: 0, remaining: 0, counts: plan.counts };
    const sequence = steps.length + 1;
    const id = `${capture.id}:${sequence}`;
    try {
      await this.db.batch([
        // Nothing may have changed since this plan was read: same votes, same chain head.
        this.guard(owner, `(${votesSnapshotSql})=? AND (SELECT coalesce(max(sequence),0) FROM vote_reconciliations WHERE user_id=?)=?
          AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='paused')
          AND EXISTS(SELECT 1 FROM import_sessions WHERE user_id=? AND status='finalized')
          AND NOT EXISTS(SELECT 1 FROM vote_reconciliations WHERE capture_id=?
            AND (user_id<>? OR capture_checksum<>? OR captured_at<>? OR code_sha<>?))`,
        [userId, current.raw, userId, steps.length, userId, userId, capture.id, userId, capture.checksum, capture.capturedAt, capture.codeSha]),
        this.db.prepare(`INSERT INTO vote_reconciliations(id,user_id,sequence,capture_id,capture_checksum,captured_at,code_sha,counts_json,changes_json,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(id, userId, sequence, capture.id, capture.checksum, capture.capturedAt, capture.codeSha,
          JSON.stringify({ ...plan.counts, step: step.length }), JSON.stringify(step), new Date().toISOString()),
        ...step.map(change => change.before === null
          ? this.db.prepare("INSERT INTO votes(user_id,pmid,destination_id,value,source,voted_at) VALUES(?,?,?,?,'legacy_import',?)")
            .bind(userId, change.pmid, destinationOf.get(change.pmid)!, change.after.value, change.after.votedAt)
          : this.db.prepare(`UPDATE votes SET destination_id=?,value=?,source='legacy_import',voted_at=?
            WHERE user_id=? AND pmid=? AND value=? AND voted_at=?`)
            .bind(destinationOf.get(change.pmid)!, change.after.value, change.after.votedAt, userId, change.pmid, change.before.value, change.before.votedAt)),
        this.clear(),
      ]);
    } catch { throw conflict(); }
    return { applied: true, id, sequence, changed: step.length, remaining: plan.changes.length - step.length, counts: plan.counts };
  }

  /** The import verifies exactly, and import votes plus every sealed step equal D1's votes. */
  async verify(userId: string) {
    const context = await this.context(userId);
    await new ImportRepository(this.db).verify(context.sessionId);
    const { results } = await this.db.prepare('SELECT records_json FROM import_blocks WHERE session_id=? ORDER BY block_index')
      .bind(context.sessionId).all<{ records_json: string }>();
    const base: VoteMap = new Map();
    for (const block of results) {
      for (const r of z.array(ImportRecord).parse(JSON.parse(block.records_json))) {
        if (r.kind === 'vote') base.set(r.pmid, { value: r.value, votedAt: r.votedAt });
      }
    }
    const steps = await reconciliationSteps(this.db, userId);
    let expected: VoteMap;
    try { expected = replayForward(base, steps); } catch { throw conflict(); }
    const current = await this.current(userId);
    const destinations = new Set(context.destinations.map(d => d.id));
    if (sorted(expected) !== sorted(current.votes)
      || current.rows.some(r => r.source !== 'legacy_import' || !destinations.has(r.destinationId))) throw conflict();
    return { verified: true, reconciliations: steps.length, votes: current.votes.size };
  }
}
