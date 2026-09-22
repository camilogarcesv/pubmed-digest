import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { articleHash, buildLedgerExtension, ledgerAdditions, type LedgerArticle } from '../src/multiuser/ledger-extension.js';
import { checksum, sha256 } from '../src/multiuser/import-contracts.js';
import { applyLedgerExtension, capturedArticles, verifyLedgerExtension, verifyLedgerPackage } from '../src/operations/extend-ledger.js';

const timestamp = '2026-09-22T04:00:00.000Z';
const article = (pmid: string): LedgerArticle => ({ kind: 'article', pmid, title: null, firstSeen: timestamp, relevance: 0, delivered: true });
const input = { id: '22222222-2222-4222-8222-222222222222', userId: '11111111-1111-4111-8111-111111111111', capturedAt: timestamp,
  stateSha: 'a'.repeat(40), codeSha: 'b'.repeat(40), ledgerChecksum: 'c'.repeat(64), backupChecksum: 'd'.repeat(64) };

describe('ledger extension package', () => {
  it('preserves zero, absent titles, empty titles and unknown scores', () => {
    const records = capturedArticles(JSON.stringify({ version: 2, papers: {
      '1': { firstSeen: timestamp, relevance: 0, delivered: true }, '2': { title: '', firstSeen: timestamp, delivered: false },
    } }));
    expect(records).toEqual([article('1'), { ...article('2'), title: '', relevance: null, delivered: false }]);
  });
  it('rejects modifications, removals and duplicates rather than overwriting history', () => {
    for (const after of [[], [{ ...article('1'), title: '' }], [article('1'), article('1')]]) {
      expect(() => ledgerAdditions([article('1')], after)).toThrow();
    }
    expect(ledgerAdditions([article('1')], [article('2'), article('1')])).toEqual([article('2')]);
  });
  it('builds deterministic bounded blocks and verifies every private input checksum', async () => {
    const before = [article('1')], after = [...before, ...Array.from({ length: 12 }, (_, i) => article(String(i + 2)))];
    const ledger = JSON.stringify({ version: 2, papers: Object.fromEntries(after.map(r => [r.pmid, { firstSeen: r.firstSeen, relevance: r.relevance, delivered: r.delivered }])) });
    const backup = '-- synthetic backup\n';
    const built = await buildLedgerExtension(before, after, { ...input, ledgerChecksum: await sha256(new TextEncoder().encode(ledger)), backupChecksum: await sha256(new TextEncoder().encode(backup)) });
    expect(built.blocks.map(b => b.records.length)).toEqual([10, 2]);
    const dir = await mkdtemp(join(tmpdir(), 'ledger-extension-'));
    try {
      for (const [file, contents] of Object.entries({ 'manifest.json': JSON.stringify(built.manifest), 'blocks.json': JSON.stringify(built.blocks),
        'before.json': JSON.stringify({ userId: input.userId, records: before, checksum: await articleHash(before) }), 'ledger.json': ledger, 'backup.sql': backup })) await writeFile(join(dir, file), contents);
      expect(await verifyLedgerPackage(dir)).toEqual(built);
      await writeFile(join(dir, 'backup.sql'), backup + '-- altered');
      await expect(verifyLedgerPackage(dir)).rejects.toThrow('changed');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('ledger extension client recovery', () => {
  async function server(timeout: 'before' | 'after' | 'finalize' | 'create' | 'none') {
    const data = await buildLedgerExtension([article('1')], [article('1'), article('2')], input);
    const manifestHash = await checksum(data.manifest);
    let applied = false, finalized = false, failed = false, created = false;
    const calls: string[] = [];
    const verified = { verified: true, finalized: true, extensionId: input.id, manifestHash, articles: 2, checksum: data.manifest.afterHash };
    const request = vi.fn(async (path: string, body?: unknown, method?: string): Promise<unknown> => {
      calls.push(`${method ?? (body === undefined ? 'GET' : 'POST')} ${path}`);
      if (path.endsWith('/verify')) { if (!finalized) throw new Error('Not sealed'); return verified; }
      if (path.endsWith('/ledger-extensions')) { created = true; if (timeout === 'create' && !failed) { failed = true; throw new Error('timeout'); } }
      if (path.endsWith('/blocks')) {
        if (timeout === 'before' && !failed) { failed = true; throw new Error('timeout'); }
        if (applied) throw new Error('Unexpected duplicate write');
        applied = true;
        if (timeout === 'after' && !failed) { failed = true; throw new Error('timeout'); }
        return {};
      }
      if (path.endsWith('/finalize')) { finalized = true; if (timeout === 'finalize' && !failed) { failed = true; throw new Error('timeout'); } return {}; }
      if (!path.includes('/lease')) {
        if (!created) throw new Error('Not created');
        return { status: finalized ? 'finalized' : 'open', manifestHash, blocks: applied ? [{ blockIndex: 0, checksum: data.blocks[0].checksum }] : [] };
      }
      return {};
    });
    return { ...data, request, calls, verified };
  }
  it.each(['before', 'after', 'create', 'finalize', 'none'] as const)('recovers a %s timeout from checkpoints and verifies before releasing', async timeout => {
    const f = await server(timeout);
    expect(await applyLedgerExtension(f.manifest, f.blocks, f.request)).toEqual(f.verified);
    expect(f.calls.at(-1)).toBe('DELETE /lease');
    expect(f.calls.at(-2)).toMatch(/\/verify$/);
    const count = f.calls.filter(c => c.endsWith('/blocks')).length;
    expect(count).toBe(timeout === 'before' ? 2 : 1);
    expect(await applyLedgerExtension(f.manifest, f.blocks, f.request)).toEqual(f.verified);
    expect(f.calls.filter(c => c.endsWith('/blocks'))).toHaveLength(count);
  });
  it('requires the requested extension to be sealed and rejects a different verified identity', async () => {
    const f = await server('none');
    await expect(verifyLedgerExtension(f.manifest, f.request)).rejects.toThrow('Not sealed');
    await expect(verifyLedgerExtension(f.manifest, async () => ({ ...f.verified, manifestHash: '0'.repeat(64) }))).rejects.toThrow('identity');
    await expect(verifyLedgerExtension(f.manifest, async () => ({ ...f.verified, finalized: false }))).rejects.toThrow();
  });
  it('stops on lost lease and still attempts release', async () => {
    const f = await server('none');
    const request = vi.fn(async (path: string, body?: unknown, method?: string) => {
      if (path === '/lease/renew') throw new Error('Lease lost');
      return f.request(path, body, method);
    });
    await expect(applyLedgerExtension(f.manifest, f.blocks, request)).rejects.toThrow('Lease lost');
    expect(f.calls.at(-1)).toBe('DELETE /lease');
    expect(f.calls.some(c => c.endsWith('/blocks'))).toBe(false);
  });
});
