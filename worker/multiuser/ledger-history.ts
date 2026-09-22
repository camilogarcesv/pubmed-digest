import { snapshotRows, type VerifiedSnapshot } from './verified-snapshot.js';
import { DomainError } from '../../src/multiuser/contracts.js';
import { canonical, checksum } from '../../src/multiuser/import-contracts.js';
import { LedgerArticle, LedgerBlock, LedgerManifest, articleHash } from '../../src/multiuser/ledger-extension.js';

export const articlesSnapshotSql = "SELECT json_group_array(json_object('pmid',a.pmid,'title',u.legacy_title,'displayTitle',a.title,'firstSeen',u.first_seen,'relevance',u.relevance,'delivered',u.delivered,'abstract',a.abstract,'metadata',a.metadata_json,'updatedAt',a.updated_at,'reason',u.reason,'source',u.source,'run',u.run_id,'deliveredAt',u.delivered_at)) FROM (SELECT * FROM user_articles WHERE user_id=? ORDER BY pmid) u JOIN articles a ON a.pmid=u.pmid";
export type ArticleRow = { [key: string]: unknown };
export function articleRecords(rows: ArticleRow[]): LedgerArticle[] {
  return rows.map(r => LedgerArticle.parse({ kind: 'article', pmid: r.pmid, title: r.title, firstSeen: r.firstSeen, relevance: r.relevance, delivered: r.delivered === 1 }));
}
const conflict = () => new DomainError('conflict', 'Ledger history conflict');
/** Verify every applied block, undo additions, and return the immutable original ledger. */
export async function undoLedgerExtensions(db: D1Database, userId: string, rows: ArticleRow[], snapshots?: VerifiedSnapshot[]) {
  const [sessions, blocks] = await Promise.all([
    snapshotRows<ArticleRow>(db, 'SELECT * FROM ledger_extensions WHERE user_id=? ORDER BY sequence',
      ['id', 'user_id', 'sequence', 'manifest_hash', 'manifest_json', 'status'], userId, snapshots),
    snapshotRows<ArticleRow>(db, `SELECT b.* FROM ledger_extension_blocks b JOIN ledger_extensions e ON e.id=b.extension_id
      WHERE e.user_id=? ORDER BY e.sequence,b.block_index`, ['extension_id', 'block_index', 'checksum', 'records_json'], userId, snapshots),
  ]);
  const state = new Map(articleRecords(rows).map(r => [r.pmid, r]));
  const timestamps = new Map(rows.map(r => [String(r.pmid), r.updatedAt]));
  const originals = new Set(state.keys());
  const finalized: LedgerManifest[] = [];
  for (let i = sessions.length - 1; i >= 0; i--) {
    const session = sessions[i];
    const m = LedgerManifest.parse(JSON.parse(String(session.manifest_json)));
    if (session.sequence !== i + 1 || m.userId !== userId || m.id !== session.id || await checksum(m) !== session.manifest_hash
      || (session.status !== 'finalized' && (session.status !== 'open' || i !== sessions.length - 1))) throw conflict();
    const saved = blocks.filter(b => b.extension_id === m.id);
    if (saved.length > m.blocks.length || (session.status === 'finalized' && saved.length !== m.blocks.length)) throw conflict();
    if (saved.length === m.blocks.length && (state.size !== m.afterCount || await articleHash([...state.values()]) !== m.afterHash)) throw conflict();
    for (const [index, block] of saved.entries()) {
      const b = LedgerBlock.parse({ index: block.block_index, checksum: block.checksum, records: JSON.parse(String(block.records_json)) });
      if (b.index !== index || b.checksum !== m.blocks[index].checksum || b.records.length !== m.blocks[index].count || await checksum(b.records) !== b.checksum) throw conflict();
      for (const article of b.records) {
        if (canonical(state.get(article.pmid) ?? null) !== canonical(article) || timestamps.get(article.pmid) !== m.capturedAt) throw conflict();
        state.delete(article.pmid); originals.delete(article.pmid);
      }
    }
    if (state.size !== m.beforeCount || await articleHash([...state.values()]) !== m.beforeHash) throw conflict();
    if (session.status === 'finalized') finalized.push(m);
  }
  return { records: [...state.values()], originals, finalized, extensions: sessions.length };
}
export function ledgerProvenance(m: LedgerManifest) {
  return { id: `${m.id}:state`, user_id: m.userId, kind: 'state', source_ref: m.stateSha, code_sha: m.codeSha,
    checksum: m.ledgerChecksum, counts_json: JSON.stringify({ articles: m.afterCount, added: m.afterCount - m.beforeCount }), created_at: m.capturedAt };
}
