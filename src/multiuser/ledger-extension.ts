import { z } from 'zod';
import { Sha256, Timestamp, UserId } from './contracts.js';
import { ImportRecord, canonical, checksum } from './import-contracts.js';

// Additions only: a later capture must preserve every previously imported article exactly.
export const LedgerArticle = ImportRecord.options[0];
export type LedgerArticle = z.infer<typeof LedgerArticle>;
export const LEDGER_BLOCK_SIZE = 10;
export const LedgerBlock = z.strictObject({ index: z.number().int().nonnegative(), checksum: Sha256,
  records: z.array(LedgerArticle).min(1).max(LEDGER_BLOCK_SIZE),
}).refine(b => new Set(b.records.map(r => r.pmid)).size === b.records.length, 'Duplicate article');
export type LedgerBlock = z.infer<typeof LedgerBlock>;
const count = z.number().int().nonnegative().max(150000);
export const LedgerManifest = z.strictObject({
  format: z.literal(1), id: z.uuid(), userId: UserId, capturedAt: Timestamp,
  stateSha: z.string().regex(/^[a-f0-9]{40}$/), codeSha: z.string().regex(/^[a-f0-9]{40}$/),
  ledgerChecksum: Sha256, backupChecksum: Sha256,
  beforeHash: Sha256, afterHash: Sha256, beforeCount: count, afterCount: count,
  blocks: z.array(z.strictObject({ checksum: Sha256, count: z.number().int().min(1).max(LEDGER_BLOCK_SIZE) })).min(1).max(10000),
}).refine(m => m.afterCount === m.beforeCount + m.blocks.reduce((sum, b) => sum + b.count, 0), 'Incorrect article counts');
export type LedgerManifest = z.infer<typeof LedgerManifest>;
export const sortedArticles = (records: LedgerArticle[]) => [...records].sort((a, b) => a.pmid.localeCompare(b.pmid));
export async function articleHash(records: LedgerArticle[]) { return checksum(sortedArticles(records)); }
export function ledgerAdditions(before: LedgerArticle[], after: LedgerArticle[]) {
  for (const records of [before, after]) if (new Set(records.map(r => r.pmid)).size !== records.length) throw new Error('Duplicate article');
  const next = new Map(after.map(r => [r.pmid, r]));
  if (before.some(r => canonical(r) !== canonical(next.get(r.pmid) ?? null))) throw new Error('Existing ledger changed or removed');
  const prior = new Set(before.map(r => r.pmid));
  return sortedArticles(after.filter(r => !prior.has(r.pmid)));
}
export async function buildLedgerExtension(before: LedgerArticle[], after: LedgerArticle[], input: Pick<LedgerManifest, 'id' | 'userId' | 'capturedAt' | 'stateSha' | 'codeSha' | 'ledgerChecksum' | 'backupChecksum'>) {
  before = z.array(LedgerArticle).parse(before); after = z.array(LedgerArticle).parse(after);
  const additions = ledgerAdditions(before, after);
  if (!additions.length) throw new Error('No ledger additions');
  if (new TextEncoder().encode(canonical(after)).byteLength > 1024 * 1024) throw new Error('Ledger requires a larger importer');
  const blocks: LedgerBlock[] = [];
  for (let i = 0; i < additions.length; i += LEDGER_BLOCK_SIZE) {
    const records = additions.slice(i, i + LEDGER_BLOCK_SIZE);
    blocks.push(LedgerBlock.parse({ index: blocks.length, checksum: await checksum(records), records }));
  }
  const manifest = LedgerManifest.parse({ format: 1, ...input, beforeHash: await articleHash(before), afterHash: await articleHash(after), beforeCount: before.length, afterCount: after.length, blocks: blocks.map(b => ({ checksum: b.checksum, count: b.records.length })) });
  for (const body of [{ manifest, owner: crypto.randomUUID() }, ...blocks.map(block => ({ block, owner: crypto.randomUUID() }))]) {
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 256 * 1024) throw new Error('Oversized ledger request');
  }
  return { manifest, blocks };
}
