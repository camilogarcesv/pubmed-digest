import { describe, expect, it, vi } from 'vitest';
import { applyPackage, importClient } from '../src/operations/import-user.js';
import { buildPackage, verifyPackage, type Capture } from '../src/operations/import-package.js';
import { checksum } from '../src/multiuser/import-contracts.js';
import { computeEvalMetrics, joinVotes } from '../src/votes.js';

const timestamp = '2026-09-15T12:00:00.000Z';
const metadata = { id: '44444444-4444-4444-8444-444444444444', capturedAt: timestamp, stateSha: 'a'.repeat(40), codeSha: 'b'.repeat(40) };
function capture(): Capture {
  return {
    identity: JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', destinationId: '22222222-2222-4222-8222-222222222222', email: 'owner@example.test', slug: 'owner', timezone: 'UTC', chatId: '100' }),
    ledger: JSON.stringify({ version: 2, papers: {
      '123': { title: '', firstSeen: timestamp, relevance: 0, delivered: true },
      '456': { firstSeen: timestamp, delivered: false },
      '789': { title: 'MRI study', firstSeen: timestamp, relevance: 9, delivered: true },
    } }),
    profile: 'description: Synthetic profile\nsources:\n  journals: [AJNR, Radiology]\n  queries: [MRI]\n',
    config: 'export const config = {\n  threshold: 7,\n};',
    votes: JSON.stringify({ format: 1, scanned: 3, invalid: 0, votes: [
      { pmid: '123', chatId: '100', value: 0, votedAt: timestamp },
      { pmid: '456', chatId: '100', value: 1, votedAt: timestamp },
      { pmid: '789', chatId: '100', value: 1, votedAt: timestamp },
    ] }), backup: 'CREATE TABLE backup_test(id TEXT);',
  };
}
describe('private capture transformation', () => {
  it('uses manifest counts, preserves source order, missing fields, zero and effective threshold', async () => {
    const c = capture(), result = await buildPackage(c, metadata);
    expect(result.manifest.counts).toEqual({ articles: 3, scored: 2, delivered: 2, untitled: 2, votes: 3 });
    expect(result.manifest.profile.threshold).toBe(7);
    expect(result.manifest.sources.map(s => s.value)).toEqual(['AJNR', 'Radiology', 'MRI']);
    expect(result.blocks[0].records[0]).toMatchObject({ relevance: 0, title: '' });
    expect(result.blocks[0].records[1]).toMatchObject({ relevance: null, title: null });
    expect(await verifyPackage(c, result.manifest, result.blocks)).toEqual(result);
  });
  it.each(['ledger', 'profile', 'config', 'votes', 'backup', 'identity'] as const)('detects alteration of captured %s', async name => {
    const c = capture(), result = await buildPackage(c, metadata);
    c[name] += '\n';
    await expect(verifyPackage(c, result.manifest, result.blocks)).rejects.toThrow();
  });
  it('rejects counts, manifest hash descriptors and block tampering', async () => {
    const c = capture(), result = await buildPackage(c, metadata);
    await expect(verifyPackage(c, { ...result.manifest, counts: { ...result.manifest.counts, articles: 10 } }, result.blocks)).rejects.toThrow();
    await expect(verifyPackage(c, result.manifest, [])).rejects.toThrow();
  });
  it.each(['foreign-chat', 'unresolved', 'duplicate', 'invalid', 'incomplete'])('rejects unsafe vote capture: %s', async kind => {
    const c = capture(), votes = JSON.parse(c.votes);
    if (kind === 'foreign-chat') votes.votes[0].chatId = '200';
    if (kind === 'unresolved') votes.votes[0].pmid = '999';
    if (kind === 'duplicate') { votes.votes.push({ ...votes.votes[0], value: 1 }); votes.scanned++; }
    if (kind === 'invalid') votes.invalid = 1;
    if (kind === 'incomplete') votes.scanned++;
    c.votes = JSON.stringify(votes);
    await expect(buildPackage(c, metadata)).rejects.toThrow();
  });
  it('deduplicates identical observations and rejects identity inference or changed threshold', async () => {
    const c = capture(), v = JSON.parse(c.votes);
    v.votes.push(v.votes[0]); v.scanned++;
    c.votes = JSON.stringify(v);
    expect((await buildPackage(c, metadata)).manifest.counts.votes).toBe(3);
    await expect(buildPackage({ ...c, identity: '{}' }, metadata)).rejects.toThrow();
    await expect(buildPackage({ ...c, config: c.config.replace('7', '8') }, metadata)).rejects.toThrow();
  });
  it('produces identical offline legacy and import evaluation, retaining insufficient_data', async () => {
    const c = capture(), result = await buildPackage(c, metadata);
    const ledger = JSON.parse(c.ledger).papers;
    const legacy = joinVotes(JSON.parse(c.votes).votes, pmid => ledger[pmid] ? { title: ledger[pmid].title ?? '', score: ledger[pmid].relevance } : undefined);
    const records = result.blocks.flatMap(b => b.records);
    const imported = records.filter(r => r.kind === 'vote').flatMap(v => {
      const a = records.find(r => r.kind === 'article' && r.pmid === v.pmid);
      return a?.kind === 'article' && a.relevance !== null ? [{ pmid: v.pmid, title: a.title ?? '', score: a.relevance, value: v.value }] : [];
    });
    expect(imported).toEqual(legacy.joined);
    expect(computeEvalMetrics(imported, 7)).toEqual(computeEvalMetrics(legacy.joined, 7));
    expect(computeEvalMetrics(imported, 7).status).toBe('insufficient_data');
  });
});

describe('resumable import client', () => {
  it('waits for finalization before releasing the lease', async () => {
    const { manifest, blocks } = await buildPackage(capture(), metadata);
    let finalizeStarted!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { finalizeStarted = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const calls: string[] = [];
    const request = vi.fn(async (path: string, _body?: unknown, method?: string): Promise<unknown> => {
      calls.push(`${method ?? 'POST'} ${path}`);
      if (path === '') return { status: 'open', manifest_hash: await checksum(manifest), blocks: [] };
      if (path.endsWith('/finalize')) { finalizeStarted(); await pending; }
      return {};
    });
    const running = applyPackage(manifest, blocks, request);
    await started;
    expect(calls).not.toContain('DELETE /lease');
    finish(); await running;
    expect(calls.at(-1)).toBe('DELETE /lease');
  });
  it.each([false, true])('resolves timeout by inspecting checkpoint (committed=%s)', async committed => {
    const { manifest, blocks } = await buildPackage(capture(), metadata);
    let writes = 0, checked = false;
    const request = vi.fn(async (path: string): Promise<unknown> => {
      if (path === '') return { status: 'open', manifest_hash: await checksum(manifest), blocks: [] };
      if (path.endsWith('/blocks')) { writes++; if (writes === 1) throw new Error('timeout'); expect(checked).toBe(true); }
      if (path === `/${manifest.id}`) { checked = true; return { status: 'open', manifest_hash: await checksum(manifest), blocks: committed ? [{ blockIndex: 0, checksum: blocks[0].checksum }] : [] }; }
      return {};
    });
    await applyPackage(manifest, blocks, request);
    expect(checked).toBe(true); expect(writes).toBe(committed ? 1 : 2);
  });
  it('stops after a lost renewal and never retries writes', async () => {
    const { manifest, blocks } = await buildPackage(capture(), metadata);
    const request = vi.fn(async (path: string): Promise<unknown> => {
      if (path === '') return { status: 'open', manifest_hash: await checksum(manifest), blocks: [] };
      if (path.endsWith('/renew')) throw new Error('lost lease');
      return {};
    });
    await expect(applyPackage(manifest, blocks, request)).rejects.toThrow();
    expect(request.mock.calls.some(([path]) => path.endsWith('/blocks'))).toBe(false);
  });
  it('rejects unsafe origins and non-no-store responses', async () => {
    expect(() => importClient('https://user:pass@example.test/', 'a'.repeat(64))).toThrow();
    expect(() => importClient('http://example.test/', 'a'.repeat(64))).toThrow();
    const request = importClient('https://example.test/', 'a'.repeat(64), vi.fn(async () => Response.json({})));
    await expect(request('')).rejects.toThrow();
  });
});
