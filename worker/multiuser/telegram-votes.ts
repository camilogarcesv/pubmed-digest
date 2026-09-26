import { z } from 'zod';
import { Pmid, Timestamp } from '../../src/multiuser/contracts.js';
import { clear, D1_MODE, fenced, guard } from './digest-fence.js';

const CallbackVote = z.strictObject({
  chatId: z.string().regex(/^-?\d{1,20}$/), messageId: z.string().regex(/^\d{1,20}$/), pmid: Pmid,
  value: z.union([z.literal(0), z.literal(1)]), updateId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), votedAt: Timestamp,
});
/**
 * Eligibility is resolved in the write transaction. A historical exception never covers D1 items.
 * Legacy digests put vote buttons on near misses too, which the ledger records scored but not delivered.
 */
const eligible = `SELECT d.user_id,d.id AS destination_id FROM destinations d JOIN users u ON u.id=d.user_id
  WHERE d.external_id=? AND d.status='active' AND u.status='active' AND (
    EXISTS(SELECT 1 FROM delivery_messages m WHERE m.user_id=d.user_id AND m.destination_id=d.id
      AND m.telegram_message_id=? AND m.pmid=? AND m.votable=1 AND m.status IN ('sent','reconciled_sent'))
    OR EXISTS(SELECT 1 FROM user_articles a WHERE a.user_id=d.user_id AND a.pmid=? AND a.run_id IS NULL
      AND (a.delivered=1 OR a.relevance IS NOT NULL)
      AND EXISTS(SELECT 1 FROM authority_checkpoint c WHERE c.user_id=a.user_id AND c.activated_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM delivery_messages m WHERE m.destination_id=d.id AND m.telegram_message_id=?)))`;

export async function recordCallbackVote(db: D1Database, input: z.infer<typeof CallbackVote>): Promise<'recorded' | 'superseded' | 'failed'> {
  const v = CallbackVote.parse(input);
  const args = [v.chatId, v.messageId, v.pmid, v.pmid, v.messageId];
  const fresh = `(NOT EXISTS(SELECT 1 FROM telegram_vote_updates t WHERE t.user_id=votes.user_id AND t.pmid=votes.pmid)
    OR EXISTS(SELECT 1 FROM telegram_vote_updates t WHERE t.user_id=votes.user_id AND t.pmid=votes.pmid
      AND (julianday(?) - julianday(t.received_at)>=1 OR t.update_id<?)))`;
  const result = await fenced(db, [
    guard(db, D1_MODE, []),
    db.prepare(`INSERT INTO votes(user_id,pmid,destination_id,value,source,voted_at)
      SELECT e.user_id,?,e.destination_id,?,'telegram',? FROM (${eligible}) e WHERE 1
      ON CONFLICT(user_id,pmid) DO UPDATE SET destination_id=excluded.destination_id,value=excluded.value,source='telegram',voted_at=excluded.voted_at
      WHERE ${fresh}`).bind(v.pmid, v.value, v.votedAt, ...args, v.votedAt, v.updateId),
    db.prepare(`INSERT INTO telegram_vote_updates(user_id,pmid,update_id,received_at)
      SELECT v.user_id,v.pmid,?,? FROM votes v JOIN (${eligible}) e ON e.user_id=v.user_id
      WHERE v.pmid=? AND v.voted_at=? AND v.value=? AND v.source='telegram'
      ON CONFLICT(user_id,pmid) DO UPDATE SET update_id=excluded.update_id,received_at=excluded.received_at
      WHERE julianday(excluded.received_at)-julianday(telegram_vote_updates.received_at)>=1 OR telegram_vote_updates.update_id<excluded.update_id`)
      .bind(v.updateId, v.votedAt, ...args, v.pmid, v.votedAt, v.value),
    db.prepare(eligible).bind(...args), clear(db),
  ], 'Voting requires D1 mode');
  return result[1].meta.changes ? 'recorded' : result[3].results.length ? 'superseded' : 'failed';
}
