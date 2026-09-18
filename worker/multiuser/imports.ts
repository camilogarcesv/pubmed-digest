import { z } from 'zod';
import { DomainError } from '../../src/multiuser/contracts.js';
import { ImportBlock, ImportManifest, canonical, checksum, counts, type Manifest, type Record } from '../../src/multiuser/import-contracts.js';

const conflict = () => new DomainError('conflict', 'Import checkpoint conflict');
export class ImportRepository {
  constructor(private readonly db: D1Database) {}
  private guard(owner: string, valid = '1', args: (string | number)[] = []) {
    return this.db.prepare(`INSERT INTO operation_assertions(owner,kind,valid) VALUES(?,'import',(${valid}))`).bind(owner, ...args);
  }
  private clear() { return this.db.prepare('DELETE FROM operation_assertions'); }
  async lease(owner: string, renew = false): Promise<void> {
    z.uuid().parse(owner);
    if (renew) {
      const result = await this.db.prepare("UPDATE operation_lock SET expires_at=unixepoch()+300 WHERE owner=? AND kind='import' AND expires_at>unixepoch() RETURNING owner").bind(owner).first();
      if (!result) throw conflict();
      return;
    }
    const result = await this.db.prepare(`INSERT INTO operation_lock VALUES(1,?,'import',unixepoch()+300)
      ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner,kind=excluded.kind,expires_at=excluded.expires_at
      WHERE operation_lock.expires_at<=unixepoch() RETURNING owner`).bind(owner).first();
    if (!result) throw conflict();
  }
  async release(owner: string): Promise<void> {
    await this.db.prepare("DELETE FROM operation_lock WHERE owner=? AND kind='import'").bind(owner).run();
  }
  async status(id: string) {
    z.uuid().parse(id);
    const session = await this.db.prepare('SELECT manifest_hash,status FROM import_sessions WHERE id=?').bind(id).first<{ manifest_hash: string; status: string }>();
    if (!session) throw new DomainError('not_found', 'Import not found');
    const blocks = await this.db.prepare('SELECT block_index AS blockIndex,checksum FROM import_blocks WHERE session_id=? ORDER BY block_index').bind(id).all();
    return { ...session, blocks: blocks.results };
  }
  private async manifest(id: string): Promise<Manifest> {
    const row = await this.db.prepare('SELECT manifest_json FROM import_sessions WHERE id=?').bind(id).first<{ manifest_json: string }>();
    if (!row) throw new DomainError('not_found', 'Import not found');
    return ImportManifest.parse(JSON.parse(row.manifest_json));
  }
  async create(owner: string, input: unknown) {
    const m = ImportManifest.parse(input), hash = await checksum(m), u = m.identity;
    const prior = async () => this.db.prepare('SELECT manifest_hash FROM import_sessions WHERE id=?').bind(m.id).first<{ manifest_hash: string }>();
    const existing = await prior();
    if (existing) { if (existing.manifest_hash !== hash) throw conflict(); return this.status(m.id); }
    try {
      await this.db.batch([
        this.guard(owner, "NOT EXISTS(SELECT 1 FROM users) AND NOT EXISTS(SELECT 1 FROM articles)"),
        this.db.prepare("INSERT INTO users(id,slug,email,timezone,status,created_at) VALUES(?,?,?,?,'paused',?)").bind(u.id, u.slug, u.email, u.timezone, m.capturedAt),
        this.db.prepare('INSERT INTO profile_versions VALUES(?,1,?,1,?)').bind(u.id, JSON.stringify(m.profile), m.capturedAt),
        this.db.prepare(`INSERT INTO profile_sources(user_id,profile_version,kind,value,position)
          SELECT ?,1,json_extract(value,'$.kind'),json_extract(value,'$.value'),CAST(key AS INTEGER) FROM json_each(?)`).bind(u.id, JSON.stringify(m.sources)),
        this.db.prepare("INSERT INTO destinations VALUES(?,?,'telegram',?,'paused',0,0)").bind(u.destinationId, u.id, u.chatId),
        this.db.prepare("INSERT INTO import_sessions VALUES(?,?,?,?,'open',?,NULL)").bind(m.id, u.id, hash, JSON.stringify(m), m.capturedAt),
        this.clear(),
      ]);
    } catch { if ((await prior())?.manifest_hash !== hash) throw conflict(); }
    return this.status(m.id);
  }
  async put(owner: string, id: string, input: unknown) {
    const block = ImportBlock.parse(input), m = await this.manifest(id);
    if (new TextEncoder().encode(JSON.stringify(block)).byteLength > 256 * 1024) throw conflict();
    const hash = await checksum(block.records), expected = m.blocks[block.index];
    if (!expected || hash !== block.checksum || expected.checksum !== hash || expected.count !== block.records.length) throw conflict();
    if (block.records.some(r => r.kind === 'vote' && r.chatId !== m.identity.chatId)) throw conflict();
    const prior = () => this.db.prepare('SELECT checksum FROM import_blocks WHERE session_id=? AND block_index=?').bind(id, block.index).first<{ checksum: string }>();
    const existing = await prior();
    if (existing) { if (existing.checksum !== hash) throw conflict(); return { checksum: hash }; }
    const u = m.identity;
    try {
      await this.db.batch([
        this.guard(owner),
        this.db.prepare('INSERT INTO import_blocks VALUES(?,?,?,?)').bind(id, block.index, hash, JSON.stringify(block.records)),
        ...block.records.flatMap(r => r.kind === 'article' ? [
          this.db.prepare('INSERT INTO articles VALUES(?,?,NULL,NULL,?)').bind(r.pmid, r.title ?? '', m.capturedAt),
          this.db.prepare('INSERT INTO user_articles(user_id,pmid,first_seen,relevance,delivered,legacy_title) VALUES(?,?,?,?,?,?)').bind(u.id, r.pmid, r.firstSeen, r.relevance, Number(r.delivered), r.title),
        ] : [
          // A global article alone is not an import reference: require this user's ledger.
          this.guard(owner, 'EXISTS(SELECT 1 FROM user_articles WHERE user_id=? AND pmid=?)', [u.id, r.pmid]),
          this.db.prepare("INSERT INTO votes VALUES(?,?,?,?,'legacy_import',?)").bind(u.id, r.pmid, u.destinationId, r.value, r.votedAt),
        ]),
        this.clear(),
      ]);
    } catch { if ((await prior())?.checksum !== hash) throw conflict(); }
    return { checksum: hash };
  }

  // The same snapshot expressions are read for hashing and compared inside the final write
  // transaction, so a concurrent edit between verification and commit cannot be sealed.
  private expressions(userId: string) {
    // userId is schema-validated UUID, still bound in every SQL expression.
    return [
      "SELECT json_group_array(json_object('pmid',a.pmid,'title',u.legacy_title,'displayTitle',a.title,'firstSeen',u.first_seen,'relevance',u.relevance,'delivered',u.delivered,'abstract',a.abstract,'metadata',a.metadata_json,'updatedAt',a.updated_at,'reason',u.reason,'source',u.source,'run',u.run_id,'deliveredAt',u.delivered_at)) FROM (SELECT * FROM user_articles WHERE user_id=? ORDER BY pmid) u JOIN articles a ON a.pmid=u.pmid",
      "SELECT json_group_array(json_object('pmid',pmid,'value',value,'votedAt',voted_at,'destinationId',destination_id,'source',source)) FROM (SELECT * FROM votes WHERE user_id=? ORDER BY pmid)",
      "SELECT json_group_array(json_object('id',id,'slug',slug,'email',email,'timezone',timezone,'status',status,'createdAt',created_at,'auth',auth_subject)) FROM users WHERE id=?",
      "SELECT json_group_array(json_object('version',version,'profile',config_json,'active',active,'createdAt',created_at)) FROM profile_versions WHERE user_id=?",
      "SELECT json_group_array(json_object('kind',kind,'value',value,'position',position,'version',profile_version)) FROM (SELECT * FROM profile_sources WHERE user_id=? ORDER BY position)",
      "SELECT json_group_array(json_object('id',id,'chatId',external_id,'provider',provider,'status',status,'digest',digest_enabled,'ops',ops_enabled)) FROM destinations WHERE user_id=?",
    ].map(sql => ({ sql, userId }));
  }
  async verify(id: string, owner?: string) {
    const m = await this.manifest(id), u = m.identity;
    const expr = this.expressions(u.id);
    const snapshots = await this.db.batch<{ data: string }>(expr.map(({ sql, userId }) => this.db.prepare(`SELECT (${sql}) AS data`).bind(userId)));
    const raw = snapshots.map(s => z.string().parse(s.results[0]?.data));
    const [articles, votes, users, profiles, sources, destinations] = raw.map(s => JSON.parse(s) as { [key: string]: unknown }[]);
    const records: Record[] = articles.map(r => ({ kind: 'article', pmid: String(r.pmid), title: r.title === null ? null : String(r.title), firstSeen: String(r.firstSeen), relevance: r.relevance as number | null, delivered: r.delivered === 1 }));
    records.push(...votes.map(r => ({ kind: 'vote' as const, pmid: String(r.pmid), value: r.value as 0 | 1, votedAt: String(r.votedAt), chatId: u.chatId })));
    if (canonical(counts(records)) !== canonical(m.counts)
      || canonical(users) !== canonical([{ id: u.id, slug: u.slug, email: u.email, timezone: u.timezone, status: 'paused', createdAt: m.capturedAt, auth: null }])
      || canonical(profiles) !== canonical([{ version: 1, profile: JSON.stringify(m.profile), active: 1, createdAt: m.capturedAt }])
      || canonical(sources) !== canonical(m.sources.map((s, position) => ({ ...s, position, version: 1 })))
      || canonical(destinations) !== canonical([{ id: u.destinationId, chatId: u.chatId, provider: 'telegram', status: 'paused', digest: 0, ops: 0 }])
      || articles.some(r => r.displayTitle !== (r.title ?? '') || r.abstract !== null || r.metadata !== null || r.updatedAt !== m.capturedAt || r.reason !== null || r.source !== null || r.run !== null || r.deliveredAt !== null)
      || votes.some(r => r.destinationId !== u.destinationId || r.source !== 'legacy_import')) throw conflict();
    const blocks = await this.db.prepare('SELECT block_index,checksum,records_json FROM import_blocks WHERE session_id=? ORDER BY block_index').bind(id).all<{ block_index: number; checksum: string; records_json: string }>();
    if (blocks.results.length !== m.blocks.length) throw conflict();
    const lookup = new Map(records.map(r => [`${r.kind}:${r.pmid}`, r]));
    let total = 0;
    for (const [i, b] of blocks.results.entries()) {
      const saved = z.array(ImportBlock.shape.records.element).parse(JSON.parse(b.records_json));
      const actual = saved.map(r => lookup.get(`${r.kind}:${r.pmid}`));
      if (b.block_index !== i || saved.length !== m.blocks[i].count || b.checksum !== m.blocks[i].checksum
        || await checksum(saved) !== b.checksum || await checksum(actual.map(r => r ?? null)) !== b.checksum) throw conflict();
      total += saved.length;
    }
    if (total !== records.length) throw conflict();
    const status = await this.status(id);
    const safety = await this.db.prepare(`SELECT
      (SELECT mode FROM system_controls WHERE singleton=1) AS mode,
      (SELECT count(*) FROM digest_runs WHERE user_id=?) AS runs,
      (SELECT count(*) FROM delivery_messages WHERE user_id=?) AS messages`).bind(u.id, u.id).first<{ mode: string; runs: number; messages: number }>();
    if (safety?.mode !== 'legacy' || safety.runs || safety.messages) throw conflict();
    const provenance = await this.db.prepare('SELECT * FROM data_imports WHERE user_id=? ORDER BY kind').bind(u.id).all();
    const expectedProvenance = (['profile', 'state', 'votes'] as const).map(kind => ({ id: `${id}:${kind}`, user_id: u.id, kind,
      source_ref: kind === 'state' ? m.stateSha : id, code_sha: m.codeSha,
      checksum: kind === 'state' ? m.files.ledger : m.files[kind], counts_json: JSON.stringify(m.counts), created_at: m.capturedAt }));
    if (canonical(provenance.results) !== canonical(status.status === 'finalized' ? expectedProvenance : [])) throw conflict();
    if (owner && status.status !== 'finalized') {
      await this.db.batch([
        this.guard(owner, expr.map(({ sql }) => `(${sql})=?`).join(' AND '), expr.flatMap((e, i) => [e.userId, raw[i]])),
        this.guard(owner, "(SELECT count(*) FROM import_blocks WHERE session_id=?)=? AND NOT EXISTS(SELECT 1 FROM digest_runs WHERE user_id=?) AND NOT EXISTS(SELECT 1 FROM delivery_messages WHERE user_id=?)", [id, m.blocks.length, u.id, u.id]),
        ...(['profile', 'state', 'votes'] as const).map(kind => this.db.prepare(`INSERT INTO data_imports(id,user_id,kind,source_ref,code_sha,checksum,counts_json,created_at)
          SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM import_sessions WHERE id=? AND status='open')`).bind(`${id}:${kind}`, u.id, kind, kind === 'state' ? m.stateSha : id, m.codeSha, kind === 'state' ? m.files.ledger : m.files[kind], JSON.stringify(m.counts), m.capturedAt, id)),
        this.db.prepare("UPDATE import_sessions SET status='finalized',finalized_at=coalesce(finalized_at,?) WHERE id=? AND status='open'").bind(new Date().toISOString(), id),
        this.clear(),
      ]);
    }
    return { verified: true, manifestHash: await checksum(m), counts: m.counts };
  }
}
