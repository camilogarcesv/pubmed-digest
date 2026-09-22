import { z } from 'zod';
import {
  DomainError, OpsAlert, Period, PrepareRun, ResolveMessage, UserId,
  type DeliveryOutcome, type RunProgress, type UserContext,
} from '../../src/multiuser/contracts.js';
import { canonical } from '../../src/multiuser/import-contracts.js';
import { voteKeyboard } from '../../src/feedback.js';
import { ACTIVE_USER, D1_MODE, clear, fenced, guard } from './digest-fence.js';
import { toUserContext } from './repository.js';

export type TelegramFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
/** An attempt without a recorded outcome after this long may or may not have reached Telegram. */
export const STALE_ATTEMPT_MS = 15 * 60 * 1000;
const TELEGRAM_TIMEOUT_MS = 10_000;
/**
 * D1 Free allows 50 queries per invocation. prepare spends 4 reads, 3 guard/update statements plus one
 * insert per message, and up to 3 more when it recovers from a concurrent commit: 36 keeps it at 46.
 */
export const MAX_PREPARED_MESSAGES = 36;
/** Operator alerts fan out sequentially; more recipients than this is a configuration error. */
const MAX_OPS_DESTINATIONS = 5;
const DELIVERED = "('sent','reconciled_sent')";
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const conflict = (message: string) => new DomainError('conflict', message);
const PROGRESS = `SELECT r.id,r.user_id AS userId,r.run_key AS runKey,r.period,r.status,r.expected_items AS expectedItems,
  (SELECT count(*) FROM digest_items i WHERE i.user_id=r.user_id AND i.run_id=r.id) AS items,
  (SELECT json_group_object(status,n) FROM (SELECT m.status,count(*) AS n FROM delivery_messages m
    WHERE m.user_id=r.user_id AND m.run_id=r.id GROUP BY m.status)) AS messages
  FROM digest_runs r`;

type SendResult = { status: 'sent'; messageId: string } | { status: 'pending'; retryAfter: number } | { status: 'failed' | 'unknown' };
type RunHead = { status: string; kind: string; expectedItems: number; metrics: string };
type MessageRow = { id: string; status: string; pmid: string | null; votable: number; payload_json: string; updated_at: string; external_id: string };
type Item = { pmid: string; disposition: string };

/**
 * The D1 run lifecycle: draft → prepared → delivering → succeeded, with needs_reconciliation for
 * attempts whose outcome is not a definite answer. Writes are fenced in-transaction by mode, owner
 * and state; the 0008 triggers enforce the same transitions for statements that bypass this class.
 */
export class RunRepository {
  constructor(
    private readonly db: D1Database,
    private readonly telegram: { token?: string; fetch: TelegramFetch },
    private readonly now: () => number = Date.now,
  ) {}

  private iso(ms = this.now()): string { return new Date(ms).toISOString(); }
  private head(userId: string, runId: string): Promise<RunHead | null> {
    return this.db.prepare('SELECT status,kind,expected_items AS expectedItems,metrics_json AS metrics FROM digest_runs WHERE user_id=? AND id=?')
      .bind(userId, runId).first<RunHead>();
  }

  /** One user's operating context by slug, whatever its status: dry runs and canaries read paused users. */
  async context(slug: string): Promise<UserContext & { status: 'active' | 'paused' }> {
    Slug.parse(slug);
    const [userResult, sourceResult, destinationResult] = await this.db.batch([
      this.db.prepare(`SELECT u.id AS userId,u.slug,u.timezone,u.status,p.version,p.config_json,p.created_at
        FROM users u LEFT JOIN profile_versions p ON p.user_id=u.id AND p.active=1 WHERE u.slug=?`).bind(slug),
      this.db.prepare(`SELECT s.kind,s.value FROM profile_sources s
        JOIN profile_versions p ON p.user_id=s.user_id AND p.version=s.profile_version AND p.active=1
        JOIN users u ON u.id=s.user_id WHERE u.slug=? ORDER BY s.position`).bind(slug),
      this.db.prepare(`SELECT d.id,d.ops_enabled FROM destinations d JOIN users u ON u.id=d.user_id
        WHERE u.slug=? AND d.status='active' AND d.digest_enabled=1 ORDER BY d.id`).bind(slug),
    ]);
    const user = z.object({ userId: UserId, slug: z.string(), timezone: z.string(), status: z.enum(['active', 'paused']),
      version: z.number().nullable(), config_json: z.string().nullable(), created_at: z.string().nullable() }).optional().parse(userResult.results[0]);
    if (!user) throw new DomainError('not_found', 'User not found');
    const sources = z.array(z.object({ kind: z.enum(['journal', 'query']), value: z.string() })).parse(sourceResult.results);
    const destinations = z.array(z.object({ id: z.uuid(), ops_enabled: z.number() })).parse(destinationResult.results);
    return { ...toUserContext(user, sources, destinations), status: user.status };
  }

  async runs(userId: string, period: string): Promise<RunProgress[]> {
    UserId.parse(userId); Period.parse(period);
    const { results } = await this.db.prepare(`${PROGRESS} WHERE r.user_id=? AND r.kind='weekly' AND r.period=? ORDER BY r.created_at,r.run_key`)
      .bind(userId, period).all();
    return results.map(toProgress);
  }

  async progress(userId: string, runId: string): Promise<RunProgress> {
    UserId.parse(userId); z.uuid().parse(runId);
    const row = await this.db.prepare(`${PROGRESS} WHERE r.user_id=? AND r.id=?`).bind(userId, runId).first();
    if (!row) throw new DomainError('not_found', 'Run not found');
    return toProgress(row);
  }

  /** Freeze the rendered messages of a complete draft for every active digest destination. */
  async prepare(userId: string, runId: string, input: unknown): Promise<RunProgress> {
    UserId.parse(userId); z.uuid().parse(runId);
    const body = PrepareRun.parse(input);
    const rows = body.destinations.flatMap(d => d.messages.map((m, position) => ({
      destinationId: d.destinationId, position, kind: m.kind, pmid: m.pmid, votable: Number(m.votable), text: m.text,
    })));
    if (rows.length > MAX_PREPARED_MESSAGES) throw new DomainError('invalid_input', 'Too many messages for one transaction');
    if (new Set(body.destinations.map(d => d.destinationId)).size !== body.destinations.length) throw new DomainError('invalid_input', 'Duplicate destination');
    const [runResult, itemResult, destinationResult, userResult] = await this.db.batch([
      this.db.prepare('SELECT status,kind,expected_items AS expectedItems,metrics_json AS metrics FROM digest_runs WHERE user_id=? AND id=?').bind(userId, runId),
      this.db.prepare('SELECT pmid,disposition FROM digest_items WHERE user_id=? AND run_id=?').bind(userId, runId),
      this.db.prepare("SELECT id FROM destinations WHERE user_id=? AND status='active' AND digest_enabled=1 ORDER BY id").bind(userId),
      this.db.prepare('SELECT status FROM users WHERE id=?').bind(userId),
    ]);
    const run = runResult.results[0] as RunHead | undefined;
    if (!run) throw new DomainError('not_found', 'Run not found');
    if (run.status !== 'draft') return this.preparedAgain(userId, runId, run, rows, body.metrics);
    if ((userResult.results[0] as { status: string } | undefined)?.status !== 'active') throw conflict('User is not active');
    const items = itemResult.results as Item[];
    if (items.length !== run.expectedItems) throw conflict('Run items are incomplete');
    const destinationIds = (destinationResult.results as { id: string }[]).map(d => d.id);
    if (canonical(body.destinations.map(d => d.destinationId).sort()) !== canonical(destinationIds)) throw conflict('Destinations changed');
    for (const d of body.destinations) validateMessages(d.messages, items);
    const at = this.iso();
    try {
      await fenced(this.db, [
        guard(this.db, `${D1_MODE} AND ${ACTIVE_USER} AND (SELECT count(*) FROM digest_items WHERE user_id=? AND run_id=?)=?
          AND (SELECT json_group_array(id) FROM (SELECT id FROM destinations WHERE user_id=? AND status='active' AND digest_enabled=1 ORDER BY id))=?`,
        [userId, userId, runId, run.expectedItems, userId, JSON.stringify(destinationIds)]),
        this.db.prepare("UPDATE digest_runs SET status='prepared',metrics_json=?,updated_at=? WHERE user_id=? AND id=? AND status='draft'")
          .bind(JSON.stringify(body.metrics), at, userId, runId),
        ...rows.map(r => this.db.prepare(`INSERT INTO delivery_messages(id,user_id,run_id,destination_id,position,kind,pmid,votable,payload_json,status,attempts,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,'pending',0,?)`).bind(crypto.randomUUID(), userId, runId, r.destinationId, r.position, r.kind, r.pmid, r.votable, JSON.stringify({ text: r.text }), at)),
        clear(this.db),
      ], 'Prepare preconditions changed');
    } catch (error) {
      // A concurrent identical prepare may have committed first.
      const current = await this.head(userId, runId);
      if (current && current.status !== 'draft') return this.preparedAgain(userId, runId, current, rows, body.metrics);
      throw error;
    }
    return this.progress(userId, runId);
  }

  /** A retry after a lost response is accepted only for exactly the content already frozen. */
  private async preparedAgain(userId: string, runId: string, run: RunHead, rows: object[], metrics: unknown): Promise<RunProgress> {
    if (run.status === 'aborted') throw conflict('Run was aborted');
    const { results } = await this.db.prepare(`SELECT destination_id AS destinationId,position,kind,pmid,votable,json_extract(payload_json,'$.text') AS text
      FROM delivery_messages WHERE user_id=? AND run_id=? ORDER BY destination_id,position`).bind(userId, runId).all();
    const order = (xs: object[]) => canonical([...xs].sort((a, b) => canonical(a).localeCompare(canonical(b))));
    if (order(results) !== order(rows) || canonical(JSON.parse(run.metrics)) !== canonical(metrics)) throw conflict('Run already prepared with different content');
    return this.progress(userId, runId);
  }

  /**
   * Send the next message of one destination, strictly in order. Telegram offers no idempotency key,
   * so an attempt whose outcome is not a definite answer becomes unknown and is never retried here.
   * Each destination is blocked only by its own unresolved messages, as the legacy multi-recipient
   * delivery never let one failing chat stop the others.
   */
  async deliverNext(userId: string, runId: string, destinationId: string): Promise<DeliveryOutcome> {
    UserId.parse(userId); z.uuid().parse(runId); z.uuid().parse(destinationId);
    if (!this.telegram.token) throw new Error('Telegram is not configured');
    const run = await this.head(userId, runId);
    if (!run) throw new DomainError('not_found', 'Run not found');
    if (run.status === 'succeeded') return { state: 'done' };
    if (!['prepared', 'delivering', 'needs_reconciliation'].includes(run.status)) throw conflict('Run is not deliverable');
    const next = await this.db.prepare(`SELECT m.id,m.status,m.pmid,m.votable,m.payload_json,m.updated_at,d.external_id
      FROM delivery_messages m JOIN destinations d ON d.user_id=m.user_id AND d.id=m.destination_id
      WHERE m.user_id=? AND m.run_id=? AND m.destination_id=? AND m.status NOT IN ${DELIVERED}
      ORDER BY m.position LIMIT 1`).bind(userId, runId, destinationId).first<MessageRow>();
    if (!next) {
      const known = await this.db.prepare('SELECT 1 FROM delivery_messages WHERE user_id=? AND run_id=? AND destination_id=? LIMIT 1')
        .bind(userId, runId, destinationId).first();
      if (!known) throw new DomainError('not_found', 'Destination not part of this run');
      return (await this.undelivered(userId, runId)) ? { state: 'destination_done' } : this.finalize(userId, runId, run);
    }
    if (next.status === 'failed' || next.status === 'unknown') return { state: 'blocked', messageId: next.id };
    const now = this.now();
    if (next.status === 'sending') {
      if (Date.parse(next.updated_at) >= now - STALE_ATTEMPT_MS) return { state: 'busy' };
      // An attempt that never recorded its outcome may or may not have reached Telegram.
      await fenced(this.db, [
        guard(this.db, D1_MODE, []),
        this.db.prepare("UPDATE delivery_messages SET status='unknown',updated_at=? WHERE user_id=? AND id=? AND status='sending' AND updated_at=?")
          .bind(this.iso(now), userId, next.id, next.updated_at),
        this.db.prepare("UPDATE digest_runs SET status='needs_reconciliation',updated_at=? WHERE user_id=? AND id=? AND status='delivering'")
          .bind(this.iso(now), userId, runId),
        clear(this.db),
      ], 'Delivery requires D1 mode');
      return { state: 'blocked', messageId: next.id };
    }
    // For a pending message updated_at is the earliest next attempt (flood control moves it forward).
    const notBefore = Date.parse(next.updated_at);
    if (next.status === 'pending' && notBefore > now) return { state: 'retry', retryAfter: Math.ceil((notBefore - now) / 1000) };

    const claimedAt = this.iso(now);
    let claimed: D1Result[];
    try {
      claimed = await fenced(this.db, [
        guard(this.db, `${D1_MODE} AND ${ACTIVE_USER}
          AND EXISTS(SELECT 1 FROM destinations WHERE user_id=? AND id=? AND status='active' AND digest_enabled=1)
          AND EXISTS(SELECT 1 FROM digest_runs WHERE user_id=? AND id=? AND status IN ('prepared','delivering','needs_reconciliation'))
          AND NOT EXISTS(SELECT 1 FROM delivery_messages WHERE user_id=? AND run_id=? AND destination_id=? AND status IN ('sending','failed','unknown'))`,
        [userId, userId, destinationId, userId, runId, userId, runId, destinationId]),
        // A run returns to delivering only once no destination has an unresolved message.
        this.db.prepare(`UPDATE digest_runs SET status='delivering',updated_at=? WHERE user_id=? AND id=? AND status IN ('prepared','needs_reconciliation')
          AND NOT EXISTS(SELECT 1 FROM delivery_messages WHERE user_id=? AND run_id=? AND status IN ('failed','unknown'))`)
          .bind(claimedAt, userId, runId, userId, runId),
        this.db.prepare("UPDATE delivery_messages SET status='sending',attempts=attempts+1,updated_at=? WHERE user_id=? AND id=? AND status=? AND updated_at<=?")
          .bind(claimedAt, userId, next.id, next.status, claimedAt),
        clear(this.db),
      ], 'Delivery preconditions changed');
    } catch (error) {
      if (error instanceof DomainError) return this.contended(userId, runId, destinationId);
      throw error;
    }
    if (claimed[2].meta.changes !== 1) return { state: 'busy' };

    const body: Record<string, unknown> = {
      chat_id: next.external_id, text: z.object({ text: z.string() }).parse(JSON.parse(next.payload_json)).text,
      parse_mode: 'HTML', disable_web_page_preview: true,
    };
    if (next.votable === 1 && next.pmid) body.reply_markup = { inline_keyboard: voteKeyboard(next.pmid) };
    const result = await this.send(body);

    // The outcome of an attempt already made is recorded whatever the mode is by now.
    const recordedAt = this.now();
    const unrecorded = () => console.error(JSON.stringify({ event: 'delivery_outcome_unrecorded', messageId: next.id, status: result.status,
      telegramMessageId: result.status === 'sent' ? result.messageId : null }));
    let recorded: D1Result[];
    try {
      recorded = await this.db.batch([
        this.db.prepare("UPDATE delivery_messages SET status=?,telegram_message_id=?,updated_at=? WHERE user_id=? AND id=? AND status='sending'")
          .bind(result.status, result.status === 'sent' ? result.messageId : null,
            this.iso(result.status === 'pending' ? recordedAt + result.retryAfter * 1000 : recordedAt), userId, next.id),
        ...(result.status === 'failed' || result.status === 'unknown' ? [
          this.db.prepare("UPDATE digest_runs SET status='needs_reconciliation',updated_at=? WHERE user_id=? AND id=? AND status='delivering'")
            .bind(this.iso(recordedAt), userId, runId),
        ] : []),
      ]);
    } catch (error) {
      unrecorded();
      throw error;
    }
    if (recorded[0].meta.changes !== 1) unrecorded();
    if (result.status === 'pending') return { state: 'retry', retryAfter: result.retryAfter };
    if (result.status !== 'sent') return { state: 'blocked', messageId: next.id };
    return (await this.undelivered(userId, runId)) ? { state: 'sent' } : this.finalize(userId, runId, run);
  }

  private async undelivered(userId: string, runId: string): Promise<number> {
    return Number(await this.db.prepare(`SELECT count(*) AS n FROM delivery_messages WHERE user_id=? AND run_id=? AND status NOT IN ${DELIVERED}`)
      .bind(userId, runId).first('n'));
  }

  /** Why a claim was refused: an attempt in flight or awaiting resolution here, or a changed precondition. */
  private async contended(userId: string, runId: string, destinationId: string): Promise<DeliveryOutcome> {
    const [openResult, stateResult] = await this.db.batch([
      this.db.prepare(`SELECT id,status FROM delivery_messages WHERE user_id=? AND run_id=? AND destination_id=?
        AND status IN ('sending','failed','unknown') ORDER BY status='sending',position LIMIT 1`).bind(userId, runId, destinationId),
      this.db.prepare(`SELECT ${D1_MODE} AS d1,(SELECT status FROM users WHERE id=?) AS user,
        (SELECT status='active' AND digest_enabled=1 FROM destinations WHERE user_id=? AND id=?) AS destination`).bind(userId, userId, destinationId),
    ]);
    const open = openResult.results[0] as { id: string; status: string } | undefined;
    if (open?.status === 'sending') return { state: 'busy' };
    if (open) return { state: 'blocked', messageId: open.id };
    const state = stateResult.results[0] as { d1: number; user: string | null; destination: number | null };
    if (state.d1 !== 1) throw conflict('Delivery requires D1 mode');
    if (state.user !== 'active') throw conflict('User is not active');
    if (state.destination !== 1) throw conflict('Destination is not active');
    throw conflict('Delivery preconditions changed');
  }

  /**
   * Every message delivered: the run succeeds and a weekly run's items become the user's history,
   * atomically. An article already in the history keeps its first record; the anomaly is logged,
   * never allowed to leave a delivered run unsealed.
   */
  private async finalize(userId: string, runId: string, run: Pick<RunHead, 'kind' | 'expectedItems'>): Promise<DeliveryOutcome> {
    const at = this.iso();
    let sealed: D1Result[];
    try {
      sealed = await fenced(this.db, [
        guard(this.db, `${D1_MODE} AND EXISTS(SELECT 1 FROM digest_runs WHERE user_id=? AND id=? AND status IN ('delivering','needs_reconciliation'))
          AND EXISTS(SELECT 1 FROM delivery_messages WHERE user_id=? AND run_id=?)
          AND NOT EXISTS(SELECT 1 FROM delivery_messages WHERE user_id=? AND run_id=? AND status NOT IN ${DELIVERED})`,
        [userId, runId, userId, runId, userId, runId]),
        this.db.prepare("UPDATE digest_runs SET status='succeeded',updated_at=? WHERE user_id=? AND id=?").bind(at, userId, runId),
        // Same semantics as the legacy ledger: every considered article is seen; delivered means selected.
        this.db.prepare(`INSERT INTO user_articles(user_id,pmid,first_seen,relevance,reason,source,run_id,delivered,delivered_at)
          SELECT i.user_id,i.pmid,?,i.relevance,i.reason,i.source,i.run_id,i.disposition='selected',CASE WHEN i.disposition='selected' THEN ? END
          FROM digest_items i JOIN digest_runs r ON r.user_id=i.user_id AND r.id=i.run_id
          WHERE i.user_id=? AND i.run_id=? AND r.kind='weekly'
          ON CONFLICT(user_id,pmid) DO NOTHING`).bind(at, at, userId, runId),
        clear(this.db),
      ], 'Sealing preconditions changed');
    } catch (error) {
      if ((await this.head(userId, runId))?.status === 'succeeded') return { state: 'done' };
      throw error;
    }
    const recorded = sealed[2].meta.changes;
    if (run.kind === 'weekly' && recorded !== run.expectedItems) {
      console.warn(JSON.stringify({ event: 'history_already_present', runId, articles: run.expectedItems - recorded }));
    }
    return { state: 'done' };
  }

  /** Release a run that has not attempted any message; its articles become eligible again. */
  async abort(userId: string, runId: string): Promise<RunProgress> {
    UserId.parse(userId); z.uuid().parse(runId);
    const run = await this.head(userId, runId);
    if (!run) throw new DomainError('not_found', 'Run not found');
    if (run.status !== 'aborted') {
      await fenced(this.db, [
        guard(this.db, `${D1_MODE} AND EXISTS(SELECT 1 FROM digest_runs WHERE user_id=? AND id=? AND status IN ('draft','prepared'))
          AND NOT EXISTS(SELECT 1 FROM delivery_messages WHERE user_id=? AND run_id=? AND (status!='pending' OR attempts>0))`, [userId, runId, userId, runId]),
        this.db.prepare("UPDATE digest_runs SET status='aborted',updated_at=? WHERE user_id=? AND id=?").bind(this.iso(), userId, runId),
        clear(this.db),
      ], 'Only a run that has not started delivery can be aborted');
    }
    return this.progress(userId, runId);
  }

  /**
   * Operator alert as plain text (no HTML parsing) to active operations destinations of active users,
   * including operations-only chats that receive no digest. Alert text must carry no other user's data.
   */
  async opsAlert(input: unknown): Promise<{ sent: number; failed: number }> {
    const { text } = OpsAlert.parse(input);
    if (!this.telegram.token) throw new Error('Telegram is not configured');
    // No write to fence in a transaction: the external effect itself is gated on the current mode.
    const [modeResult, destinationResult] = await this.db.batch([
      this.db.prepare(`SELECT ${D1_MODE} AS d1`),
      this.db.prepare(`SELECT d.external_id FROM destinations d JOIN users u ON u.id=d.user_id
        WHERE d.status='active' AND d.ops_enabled=1 AND u.status='active' ORDER BY d.id LIMIT ${MAX_OPS_DESTINATIONS + 1}`),
    ]);
    if ((modeResult.results[0] as { d1: number }).d1 !== 1) throw conflict('Alerts are sent only in D1 mode');
    const destinations = destinationResult.results as { external_id: string }[];
    if (destinations.length > MAX_OPS_DESTINATIONS) throw conflict('Too many operations destinations');
    let sent = 0, failed = 0;
    for (const d of destinations) {
      const result = await this.send({ chat_id: d.external_id, text, disable_web_page_preview: true });
      if (result.status === 'sent') sent++; else failed++;
    }
    return { sent, failed };
  }

  /** Administrative resolution of one failed/unknown message, audited in delivery_resolutions. */
  async resolve(userId: string, runId: string, messageId: string, input: unknown): Promise<RunProgress> {
    UserId.parse(userId); z.uuid().parse(runId); z.uuid().parse(messageId);
    const r = ResolveMessage.parse(input);
    const run = await this.head(userId, runId);
    if (!run) throw new DomainError('not_found', 'Run not found');
    const at = this.iso();
    await fenced(this.db, [
      guard(this.db, `${D1_MODE} AND EXISTS(SELECT 1 FROM digest_runs WHERE user_id=? AND id=? AND status IN ('delivering','needs_reconciliation'))
        AND EXISTS(SELECT 1 FROM delivery_messages WHERE user_id=? AND run_id=? AND id=? AND status IN ('failed','unknown'))`,
      [userId, runId, userId, runId, messageId]),
      this.db.prepare('INSERT INTO delivery_resolutions(id,user_id,message_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?)')
        .bind(crypto.randomUUID(), userId, messageId, r.action, r.actor, r.reason, at),
      this.db.prepare("UPDATE delivery_messages SET status=?,telegram_message_id=?,updated_at=? WHERE user_id=? AND run_id=? AND id=? AND status IN ('failed','unknown')")
        .bind(r.action === 'mark_sent' ? 'reconciled_sent' : 'reconciled_retry', r.telegramMessageId, at, userId, runId, messageId),
      clear(this.db),
    ], 'Message is not awaiting resolution');
    if (!(await this.undelivered(userId, runId))) await this.finalize(userId, runId, run);
    return this.progress(userId, runId);
  }

  private async send(body: Record<string, unknown>): Promise<SendResult> {
    let response: Response;
    try {
      response = await this.telegram.fetch(`https://api.telegram.org/bot${this.telegram.token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS), redirect: 'error',
      });
    } catch {
      return { status: 'unknown' };
    }
    // Flood control and rejected requests are definite answers that nothing was sent.
    if (response.status === 429) {
      const retryAfter = await response.json().then(b => z.object({ parameters: z.object({ retry_after: z.number().int().min(1).max(3600) }) })
        .parse(b).parameters.retry_after).catch(() => 1);
      return { status: 'pending', retryAfter };
    }
    if (response.status >= 400 && response.status < 500) {
      await response.body?.cancel();
      return { status: 'failed' };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { status: 'unknown' };
    }
    try {
      const sent = z.object({ ok: z.literal(true), result: z.object({ message_id: z.number().int().nonnegative() }) }).parse(await response.json());
      return { status: 'sent', messageId: String(sent.result.message_id) };
    } catch {
      return { status: 'unknown' };
    }
  }
}

function toProgress(row: Record<string, unknown>): RunProgress {
  return z.object({
    id: z.uuid(), userId: UserId, runKey: z.string(), period: z.string().nullable(),
    status: z.enum(['draft', 'prepared', 'delivering', 'needs_reconciliation', 'succeeded', 'aborted']),
    expectedItems: z.number(), items: z.number(), messages: z.string().transform(s => z.record(z.string(), z.number()).parse(JSON.parse(s))),
  }).parse(row);
}

/** Votable messages are exactly one per delivered item; other messages never reference an article. */
function validateMessages(messages: z.infer<typeof PrepareRun>['destinations'][number]['messages'], items: Item[]): void {
  const dispositions = new Map(items.map(i => [i.pmid, i.disposition]));
  const delivered = items.filter(i => i.disposition === 'selected' || i.disposition === 'near_miss');
  const votes = new Map<string, number>();
  for (const m of messages) {
    if (m.kind === 'empty' && delivered.length) throw new DomainError('invalid_input', 'Empty digest with delivered items');
    if (m.pmid === null) continue;
    if (dispositions.get(m.pmid) !== (m.kind === 'paper' ? 'selected' : 'near_miss')) throw new DomainError('invalid_input', 'Message does not match a delivered item');
    if (m.votable) votes.set(m.pmid, (votes.get(m.pmid) ?? 0) + 1);
  }
  if (delivered.some(i => votes.get(i.pmid) !== 1) || votes.size !== delivered.length) throw new DomainError('invalid_input', 'Each delivered item needs exactly one vote keyboard');
}
