import { z } from 'zod';
import {
  Article, CreateRun, Destination, DigestItem, DomainError, LedgerEntry,
  ProfileVersion, SeenCheck, User, UserId, VoteInput,
  type DigestRepository, type EvalVote, type RunRecord, type UserContext,
} from '../../src/multiuser/contracts.js';

const runColumns = 'id, user_id AS userId, status, payload_hash AS payloadHash, expected_items AS expectedItems, profile_version AS profileVersion, kind';

/** All reads/writes are explicitly tenant-scoped; global articles contain PubMed data only. */
export class D1DigestRepository implements DigestRepository {
  constructor(private readonly db: D1Database) {}

  /** Bootstrap primitive. The production import/checksum workflow is added in 2.3. */
  async createUser(input: z.infer<typeof User>, version: z.infer<typeof ProfileVersion>, destination: z.infer<typeof Destination>): Promise<void> {
    const user = User.parse(input);
    const profile = ProfileVersion.parse(version);
    const target = Destination.parse(destination);
    if (profile.userId !== user.id || target.userId !== user.id) throw new DomainError('invalid_input', 'Owner mismatch');
    await this.db.batch([
      this.db.prepare('INSERT INTO users(id,slug,email,timezone,status,created_at) VALUES(?,?,?,?,?,?)')
        .bind(user.id, user.slug, user.email, user.timezone, user.status, user.createdAt),
      this.db.prepare('INSERT INTO profile_versions(user_id,version,config_json,active,created_at) VALUES(?,?,?,1,?)')
        .bind(user.id, profile.version, JSON.stringify(profile.profile), profile.createdAt),
      ...profile.sources.map((s, position) => this.db.prepare('INSERT INTO profile_sources(user_id,profile_version,kind,value,position) VALUES(?,?,?,?,?)')
        .bind(user.id, profile.version, s.kind, s.value, position)),
      this.db.prepare('INSERT INTO destinations(id,user_id,external_id,status,digest_enabled,ops_enabled) VALUES(?,?,?,?,?,?)')
        .bind(target.id, user.id, target.externalId, target.status, Number(target.digestEnabled), Number(target.opsEnabled)),
    ]);
  }

  async contexts(): Promise<UserContext[]> {
    // One read transaction: a profile activation cannot mix old settings with new sources.
    const [userResult, sourceResult, destinationResult] = await this.db.batch([
      this.db.prepare(`SELECT u.id AS userId,u.slug,u.timezone,p.version,p.config_json,p.created_at
        FROM users u LEFT JOIN profile_versions p ON p.user_id=u.id AND p.active=1
        WHERE u.status='active' ORDER BY u.slug LIMIT 101`),
      this.db.prepare(`SELECT s.user_id,s.kind,s.value FROM profile_sources s
        JOIN profile_versions p ON p.user_id=s.user_id AND p.version=s.profile_version AND p.active=1
        JOIN users u ON u.id=s.user_id AND u.status='active' ORDER BY s.position`),
      this.db.prepare(`SELECT d.id,d.user_id FROM destinations d JOIN users u ON u.id=d.user_id
        WHERE u.status='active' AND d.status='active' AND d.digest_enabled=1 ORDER BY d.id`),
    ]);
    const users = z.array(z.object({ userId: UserId, slug: z.string(), timezone: z.string(),
      version: z.number().nullable(), config_json: z.string().nullable(), created_at: z.string().nullable() })).parse(userResult.results);
    if (users.length > 100) throw new DomainError('conflict', 'Contexts require pagination above 100 users');
    if (users.some(u => u.version === null)) throw new DomainError('conflict', 'Active user has no active profile');
    const sources = z.array(z.object({ user_id: UserId, kind: z.enum(['journal', 'query']), value: z.string() })).parse(sourceResult.results);
    const destinations = z.array(z.object({ id: z.uuid(), user_id: UserId })).parse(destinationResult.results);
    return users.map(u => ({
      userId: u.userId, slug: u.slug, timezone: u.timezone,
      profile: ProfileVersion.parse({ userId: u.userId, version: u.version, profile: JSON.parse(u.config_json!),
        sources: sources.filter(s => s.user_id === u.userId).map(({ kind, value }) => ({ kind, value })), createdAt: u.created_at }),
      destinationIds: destinations.filter(d => d.user_id === u.userId).map(d => d.id),
    }));
  }

  async seen(input: z.infer<typeof SeenCheck>): Promise<boolean[]> {
    const { pairs } = SeenCheck.parse(input);
    // JSON input consumes one binding, even at the 50-pair limit. Reservations remain until
    // the run succeeds or is explicitly aborted; unknown delivery is never silently released.
    const { results } = await this.db.prepare(`SELECT CAST(j.key AS INTEGER) AS position,
      (EXISTS(SELECT 1 FROM user_articles a WHERE a.user_id=json_extract(j.value,'$.userId') AND a.pmid=json_extract(j.value,'$.pmid'))
      OR EXISTS(SELECT 1 FROM digest_items i JOIN digest_runs r ON r.user_id=i.user_id AND r.id=i.run_id
        WHERE i.user_id=json_extract(j.value,'$.userId') AND i.pmid=json_extract(j.value,'$.pmid')
        AND r.kind='weekly' AND r.status IN ('draft','prepared','delivering','needs_reconciliation'))) AS seen
      FROM json_each(?) j ORDER BY position`).bind(JSON.stringify(pairs)).all<{ position: number; seen: number }>();
    return results.map(r => r.seen === 1);
  }

  async evalContext(userId: string): Promise<EvalVote[]> {
    UserId.parse(userId);
    const { results } = await this.db.prepare(`SELECT v.pmid,a.title,v.value,ua.relevance AS score,v.voted_at AS votedAt
      FROM votes v JOIN articles a ON a.pmid=v.pmid
      LEFT JOIN user_articles ua ON ua.user_id=v.user_id AND ua.pmid=v.pmid
      WHERE v.user_id=? ORDER BY v.voted_at DESC,v.pmid LIMIT 1001`).bind(userId).all<EvalVote>();
    if (results.length > 1000) throw new DomainError('conflict', 'Eval context requires pagination above 1000 votes');
    return results;
  }

  /** Import insertion is strict: retries/drift must be resolved by the future import manifest. */
  async importLedger(userId: string, rows: Array<{ article: z.infer<typeof Article>; entry: z.infer<typeof LedgerEntry> }>): Promise<void> {
    UserId.parse(userId);
    if (rows.length < 1 || rows.length > 15) throw new DomainError('invalid_input', 'Import chunk must contain 1–15 entries');
    const parsed = rows.map(row => ({ article: Article.parse(row.article), entry: LedgerEntry.parse(row.entry) }));
    if (parsed.some(r => r.entry.userId !== userId || r.entry.pmid !== r.article.pmid)) throw new DomainError('invalid_input', 'Owner or PMID mismatch');
    await this.db.batch(parsed.flatMap(({ article, entry }) => [
      this.upsertArticle(article),
      this.db.prepare(`INSERT INTO user_articles(user_id,pmid,first_seen,relevance,reason,source,delivered,delivered_at)
        VALUES(?,?,?,?,?,?,?,?)`).bind(userId, entry.pmid, entry.firstSeen, entry.relevance, entry.reason, entry.source, Number(entry.delivered), entry.deliveredAt),
    ]));
  }

  private upsertArticle(a: z.infer<typeof Article>): D1PreparedStatement {
    return this.db.prepare(`INSERT INTO articles(pmid,title,abstract,metadata_json,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(pmid) DO UPDATE SET
        title=CASE WHEN articles.title='' THEN excluded.title ELSE articles.title END,
        abstract=coalesce(articles.abstract,excluded.abstract),
        metadata_json=coalesce(articles.metadata_json,excluded.metadata_json),
        updated_at=max(articles.updated_at,excluded.updated_at)`)
      .bind(a.pmid, a.title, a.abstract, a.metadata === null ? null : JSON.stringify(a.metadata), a.updatedAt);
  }

  async createRun(input: z.infer<typeof CreateRun>): Promise<RunRecord> {
    const run = CreateRun.parse(input);
    await this.db.prepare(`INSERT INTO digest_runs(id,user_id,profile_version,run_key,payload_hash,kind,status,expected_items,profile_snapshot_json,created_at,updated_at)
      SELECT ?,p.user_id,p.version,?,?,?,'draft',?,json_object('profile',json(p.config_json),'sources',
        json((SELECT json_group_array(json_object('kind',s.kind,'value',s.value)) FROM
          (SELECT kind,value FROM profile_sources WHERE user_id=p.user_id AND profile_version=p.version ORDER BY position) s))),?,?
      FROM profile_versions p JOIN users u ON u.id=p.user_id
      WHERE p.user_id=? AND p.version=? AND p.active=1 AND u.status='active'
      ON CONFLICT(user_id,run_key) DO NOTHING`)
      .bind(run.id, run.runKey, run.payloadHash, run.kind, run.expectedItems, run.createdAt, run.createdAt, run.userId, run.profileVersion).run();
    const existing = await this.db.prepare(`SELECT ${runColumns} FROM digest_runs WHERE user_id=? AND run_key=?`)
      .bind(run.userId, run.runKey).first<RunRecord>();
    if (!existing) throw new DomainError('not_found', 'Active user/profile not found');
    if (existing.payloadHash !== run.payloadHash || existing.expectedItems !== run.expectedItems || existing.profileVersion !== run.profileVersion || existing.kind !== run.kind) {
      throw new DomainError('conflict', 'Run key already used with different input');
    }
    return existing;
  }

  async getRun(userId: string, runId: string): Promise<RunRecord> {
    UserId.parse(userId); z.uuid().parse(runId);
    const run = await this.db.prepare(`SELECT ${runColumns} FROM digest_runs WHERE user_id=? AND id=?`).bind(userId, runId).first<RunRecord>();
    if (!run) throw new DomainError('not_found', 'Run not found');
    return run;
  }

  async putItems(userId: string, runId: string, chunkIndex: number, input: z.infer<typeof DigestItem>[]): Promise<void> {
    UserId.parse(userId); z.uuid().parse(runId); z.number().int().min(0).max(249).parse(chunkIndex);
    const items = z.array(DigestItem).min(1).max(15).parse(input);
    if (new Set(items.map(i => i.article.pmid)).size !== items.length) throw new DomainError('invalid_input', 'Duplicate PMID in chunk');
    const data = new TextEncoder().encode(JSON.stringify(items));
    if (data.byteLength > 256 * 1024) throw new DomainError('invalid_input', 'Chunk exceeds 256 KiB');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(n => n.toString(16).padStart(2, '0')).join('');
    const prior = () => this.db.prepare('SELECT payload_hash FROM digest_chunks WHERE user_id=? AND run_id=? AND chunk_index=?')
      .bind(userId, runId, chunkIndex).first<{ payload_hash: string }>();
    const existing = await prior();
    if (existing) {
      if (existing.payload_hash !== hash) throw new DomainError('conflict', 'Chunk input changed');
      return;
    }
    await this.getRun(userId, runId);
    try {
      await this.db.batch([
        this.db.prepare('INSERT INTO digest_chunks(user_id,run_id,chunk_index,payload_hash) VALUES(?,?,?,?)').bind(userId, runId, chunkIndex, hash),
        ...items.flatMap(i => [this.upsertArticle(i.article), this.db.prepare(`INSERT INTO digest_items(user_id,run_id,pmid,relevance,reason,source,disposition)
          VALUES(?,?,?,?,?,?,?)`).bind(userId, runId, i.article.pmid, i.relevance, i.reason, i.source, i.disposition)]),
      ]);
    } catch (error) {
      // A simultaneous identical request may have committed while we awaited the batch.
      if ((await prior())?.payload_hash === hash) return;
      throw error;
    }
  }

  /** Use only during the audited KV backfill. Telegram callbacks must use recordTelegramVote. */
  async importVote(input: z.infer<typeof VoteInput>): Promise<void> {
    const v = VoteInput.parse(input);
    await this.db.prepare(`INSERT INTO votes(user_id,pmid,destination_id,value,source,voted_at) VALUES(?,?,?,?,'legacy_import',?)
      ON CONFLICT(user_id,pmid) DO UPDATE SET destination_id=excluded.destination_id,value=excluded.value,source=excluded.source,voted_at=excluded.voted_at
      WHERE excluded.voted_at > votes.voted_at`).bind(v.userId, v.pmid, v.destinationId, v.value, v.votedAt).run();
  }

  async recordTelegramVote(chatId: string, messageId: string, pmid: string, value: 0 | 1, votedAt: string): Promise<boolean> {
    z.string().regex(/^-?\d{1,20}$/).parse(chatId);
    z.string().regex(/^\d{1,20}$/).parse(messageId);
    const input = VoteInput.omit({ userId: true, destinationId: true }).parse({ pmid, value, votedAt });
    const result = await this.db.prepare(`INSERT INTO votes(user_id,pmid,destination_id,value,source,voted_at)
      SELECT d.user_id,m.pmid,d.id,?,'telegram',? FROM delivery_messages m
      JOIN destinations d ON d.user_id=m.user_id AND d.id=m.destination_id
      JOIN users u ON u.id=d.user_id
      WHERE d.external_id=? AND d.status='active' AND u.status='active' AND m.telegram_message_id=? AND m.pmid=?
        AND m.votable=1 AND m.status IN ('sent','reconciled_sent')
      ON CONFLICT(user_id,pmid) DO UPDATE SET destination_id=excluded.destination_id,value=excluded.value,source=excluded.source,voted_at=excluded.voted_at
      WHERE excluded.voted_at > votes.voted_at`)
      .bind(input.value, input.votedAt, chatId, messageId, input.pmid).run();
    return result.meta.changes > 0;
  }
}
