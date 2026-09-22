import { z } from 'zod';
import { parse as yaml } from 'yaml';
import { ImportBlock, ImportIdentity, ImportManifest, ImportRecord, canonical, checksum, counts, sha256, type Block, type Manifest, type Record } from '../multiuser/import-contracts.js';
import { Pmid, Timestamp } from '../multiuser/contracts.js';

export const packageFiles = { ledger: 'ledger.json', profile: 'profile.yaml', config: 'config.ts', votes: 'votes.json', backup: 'backup.sql', identity: 'identity.json' } as const;
export type Capture = { -readonly [K in keyof typeof packageFiles]: string };
export const Ledger = z.object({ version: z.literal(2), papers: z.record(Pmid, z.strictObject({
  title: z.string().max(8000).optional(), firstSeen: Timestamp,
  relevance: z.number().int().min(0).max(10).optional(), delivered: z.boolean(),
})), updatedAt: z.string().optional() }).strict();
export const StrictVotes = z.strictObject({ format: z.literal(1), scanned: z.number().int().nonnegative(), invalid: z.literal(0),
  votes: z.array(ImportRecord.options[1].omit({ kind: true })) }).refine(v => v.scanned === v.votes.length);

export async function transformCapture(capture: Capture) {
  const identity = ImportIdentity.parse(JSON.parse(capture.identity));
  const ledger = Ledger.parse(JSON.parse(capture.ledger));
  const votes = StrictVotes.parse(JSON.parse(capture.votes));
  const rawProfile = z.object({ sources: z.strictObject({ journals: z.array(z.string()).default([]), queries: z.array(z.string()).default([]) }).default({ journals: [], queries: [] }) }).passthrough().parse(yaml(capture.profile));
  const { sources: sourceInput, ...profileInput } = rawProfile;
  const thresholds = [...capture.config.matchAll(/^\s*threshold:\s*(\d+)\s*,/gm)];
  if (thresholds.length !== 1) throw new Error('Cannot resolve captured threshold');
  const profile = ImportManifest.shape.profile.parse({ topics: [], must_have: [], nice_to_have: [], exclude: [], exemplar_papers: [], ...profileInput, threshold: profileInput.threshold ?? Number(thresholds[0][1]) });
  const sources = ImportManifest.shape.sources.parse([
    ...sourceInput.journals.map(value => ({ kind: 'journal', value })),
    ...sourceInput.queries.map(value => ({ kind: 'query', value })),
  ]);
  const records: Record[] = Object.entries(ledger.papers).sort(([a], [b]) => a.localeCompare(b)).map(([pmid, p]) => ({
    kind: 'article', pmid, title: p.title ?? null, firstSeen: p.firstSeen, relevance: p.relevance ?? null, delivered: p.delivered,
  }));
  const distinct = new Map<string, Record>();
  for (const vote of votes.votes) {
    if (vote.chatId !== identity.chatId || !ledger.papers[vote.pmid]) throw new Error('Unresolved vote owner or article');
    const record: Record = { kind: 'vote', ...vote };
    const previous = distinct.get(vote.pmid);
    if (previous && canonical(previous) !== canonical(record)) throw new Error('Contradictory duplicate vote');
    distinct.set(vote.pmid, record);
  }
  records.push(...[...distinct.values()].sort((a, b) => a.pmid.localeCompare(b.pmid)));
  // Verification compares a bounded snapshot inside the final transaction.
  if (Buffer.byteLength(canonical(records)) > 1024 * 1024) throw new Error('Capture requires a larger-format importer');
  const blocks: Block[] = [];
  for (let index = 0; index < records.length; index += 15) {
    const chunk = records.slice(index, index + 15);
    const block = ImportBlock.parse({ index: blocks.length, checksum: await checksum(chunk), records: chunk });
    if (Buffer.byteLength(JSON.stringify({ owner: crypto.randomUUID(), block })) > 256 * 1024) throw new Error('Oversized block');
    blocks.push(block);
  }
  const files = {} as Manifest['files'];
  for (const name of Object.keys(packageFiles) as (keyof Capture)[]) files[name] = await sha256(new TextEncoder().encode(capture[name]));
  return { identity, profile, sources, records, blocks, files, counts: counts(records) };
}

export async function buildPackage(capture: Capture, input: Pick<Manifest, 'id' | 'capturedAt' | 'stateSha' | 'codeSha'>) {
  const data = await transformCapture(capture);
  const manifest = ImportManifest.parse({ format: 1, ...input, identity: data.identity, profile: data.profile, sources: data.sources,
    files: data.files, counts: data.counts, blocks: data.blocks.map(b => ({ checksum: b.checksum, count: b.records.length })) });
  if (Buffer.byteLength(JSON.stringify({ owner: crypto.randomUUID(), manifest })) > 256 * 1024) throw new Error('Oversized manifest');
  return { manifest, blocks: data.blocks };
}
export async function verifyPackage(capture: Capture, input: unknown, blockInput: unknown) {
  const manifest = ImportManifest.parse(input);
  const reconstructed = await buildPackage(capture, manifest);
  if (canonical(manifest) !== canonical(reconstructed.manifest) || canonical(blockInput) !== canonical(reconstructed.blocks)) throw new Error('Package checksum mismatch');
  return reconstructed;
}
