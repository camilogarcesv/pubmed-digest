import { z } from 'zod';
import { InterestProfile, Pmid, ProfileVersion, Sha256, Timestamp, User } from './contracts.js';

export const ImportIdentity = User.pick({ id: true, slug: true, email: true, timezone: true }).extend({
  destinationId: z.uuid(), chatId: z.string().regex(/^-?\d{1,20}$/),
});
export const ImportRecord = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('article'), pmid: Pmid, title: z.string().max(8000).nullable(), firstSeen: Timestamp,
    relevance: z.number().int().min(0).max(10).nullable(), delivered: z.boolean() }),
  z.strictObject({ kind: z.literal('vote'), pmid: Pmid, chatId: z.string().regex(/^-?\d{1,20}$/),
    value: z.union([z.literal(0), z.literal(1)]), votedAt: Timestamp }),
]);
export const ImportBlock = z.strictObject({ index: z.number().int().min(0).max(9999), checksum: Sha256,
  records: z.array(ImportRecord).min(1).max(15) });
const count = z.number().int().min(0).max(150000);
export const ImportManifest = z.strictObject({
  format: z.literal(1), id: z.uuid(), identity: ImportIdentity, capturedAt: Timestamp,
  stateSha: z.string().regex(/^[a-f0-9]{40}$/), codeSha: z.string().regex(/^[a-f0-9]{40}$/),
  profile: InterestProfile.extend({ threshold: z.literal(7) }), sources: ProfileVersion.shape.sources,
  files: z.strictObject({ ledger: Sha256, profile: Sha256, config: Sha256, votes: Sha256, backup: Sha256, identity: Sha256 }),
  counts: z.strictObject({ articles: count, scored: count, delivered: count, untitled: count, votes: count }),
  blocks: z.array(z.strictObject({ checksum: Sha256, count: z.number().int().min(1).max(15) })).max(10000),
});
export const ImportLease = z.strictObject({ owner: z.uuid() });
export type Manifest = z.infer<typeof ImportManifest>;
export type Block = z.infer<typeof ImportBlock>;
export type Record = z.infer<typeof ImportRecord>;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export async function checksum(value: unknown): Promise<string> {
  return sha256(new TextEncoder().encode(canonical(value)));
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function counts(records: Record[]): Manifest['counts'] {
  const articles = records.filter(r => r.kind === 'article');
  return { articles: articles.length, scored: articles.filter(r => r.relevance !== null).length,
    delivered: articles.filter(r => r.delivered).length, untitled: articles.filter(r => r.title === '' || r.title === null).length,
    votes: records.filter(r => r.kind === 'vote').length };
}
