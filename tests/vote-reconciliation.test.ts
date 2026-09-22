import { describe, expect, it, vi } from 'vitest';
import { checksum } from '../src/multiuser/import-contracts.js';
import {
  MAX_STEP_CHANGES, ReplayError, parseCapture, planReconciliation, replayForward, replayReverse,
  type CapturedVote, type VoteChange, type VoteMap,
} from '../src/multiuser/vote-reconciliation.js';
import { applyCapture } from '../src/operations/reconcile-votes.js';

const t0 = '2026-09-15T12:00:00.000Z';
const t1 = '2026-09-20T09:30:00.000Z';
const t2 = '2026-09-21T18:05:00.000Z';
const vote = (pmid: string, value: 0 | 1, votedAt = t1, chatId = '100'): CapturedVote => ({ pmid, chatId, value, votedAt });
const state = (entries: Array<[string, 0 | 1, string]>): VoteMap => new Map(entries.map(([pmid, value, votedAt]) => [pmid, { value, votedAt }]));
const userId = '11111111-1111-4111-8111-111111111111';

describe('reconciliation plan', () => {
  it('classifies every captured vote exactly once and never proposes a deletion', () => {
    const current = state([['1', 1, t0], ['2', 0, t0], ['3', 1, t1], ['4', 0, t0]]);
    const plan = planReconciliation(
      [vote('1', 1, t0), vote('2', 1, t1), vote('3', 0, t0), vote('5', 1), vote('9', 1)],
      current, new Set(['1', '2', '3', '4', '5']), 2,
    );
    expect(plan.counts).toEqual({ captured: 7, unmapped: 2, new: 1, update: 1, unchanged: 1, unresolved: 1, conflict: 1, d1Only: 1 });
    expect(plan.changes.map(c => c.pmid)).toEqual(['2', '5']);
    expect(plan.conflicts).toEqual([{ pmid: '3', captured: { value: 0, votedAt: t0 }, current: { value: 1, votedAt: t1 } }]);
    expect(plan.unresolved).toEqual(['9']);
    expect(plan.d1Only).toEqual(['4']);
  });

  it('refuses two captured votes for the same PMID of one user', () => {
    expect(() => planReconciliation([vote('1', 1), vote('1', 0, t2)], new Map(), new Set(['1']))).toThrow(ReplayError);
  });
});

describe('sealed replay', () => {
  const steps: VoteChange[][] = [
    [{ pmid: '1', before: { value: 0, votedAt: t0 }, after: { value: 1, votedAt: t1 } }, { pmid: '2', before: null, after: { value: 1, votedAt: t1 } }],
    [{ pmid: '1', before: { value: 1, votedAt: t1 }, after: { value: 0, votedAt: t2 } }],
  ];

  it('treats forward and reverse replay as exact inverses across steps', () => {
    const imported = state([['1', 0, t0], ['3', 1, t0]]);
    const now = replayForward(imported, steps);
    expect(now).toEqual(state([['1', 0, t2], ['3', 1, t0], ['2', 1, t1]]));
    expect(replayReverse(now, steps)).toEqual(imported);
  });

  it('detects a change that does not start or end where the chain says', () => {
    expect(() => replayForward(state([['1', 1, t0]]), steps)).toThrow('chain broken');
    expect(() => replayReverse(state([['1', 1, t2], ['2', 1, t1]]), steps)).toThrow('chain broken');
    expect(() => replayReverse(state([['1', 0, t2]]), steps)).toThrow('chain broken'); // '2' missing
  });

  it('rejects a step that changes one PMID twice', () => {
    const doubled = [[steps[0]![0]!, { ...steps[0]![0]!, before: steps[0]![0]!.after, after: { value: 0 as const, votedAt: t2 } }]];
    expect(() => replayForward(state([['1', 0, t0]]), doubled)).toThrow('Duplicate change');
  });
});

describe('capture integrity', () => {
  it('proves the votes are the ones the checksum covers', async () => {
    const votes = [vote('1', 1), vote('2', 0)];
    const capture = { format: 1, id: crypto.randomUUID(), capturedAt: t2, codeSha: 'e'.repeat(40), checksum: await checksum(votes), votes };
    await expect(parseCapture(capture)).resolves.toMatchObject({ votes });
    await expect(parseCapture({ ...capture, votes: [vote('1', 0), vote('2', 0)] })).rejects.toThrow('checksum');
    const duplicated = [vote('1', 1), vote('1', 1)];
    await expect(parseCapture({ ...capture, votes: duplicated, checksum: await checksum(duplicated) })).rejects.toThrow();
  });
});

describe('reconciliation client', () => {
  const capture = { format: 1 as const, id: '44444444-4444-4444-8444-444444444444', capturedAt: t2, codeSha: 'e'.repeat(40), checksum: 'f'.repeat(64), votes: [] };
  const counts = { captured: 3, unmapped: 0, new: 0, update: 0, unchanged: 0, unresolved: 0, conflict: 0, d1Only: 0 };
  function server(plan: { counts?: Partial<typeof counts>; changes?: number }, steps: Array<{ remaining: number } | Error> = []) {
    const calls: string[] = [];
    let remaining = plan.changes ?? 0, committed = 0;
    const request = vi.fn(async (path: string, _body?: unknown, method?: string): Promise<unknown> => {
      calls.push(`${method ?? (_body === undefined ? 'GET' : 'POST')} ${path}`);
      if (path.endsWith('/plan')) return { counts: { ...counts, ...plan.counts }, changes: Array.from({ length: remaining }) };
      if (path.endsWith('/verify')) return { verified: true, reconciliations: committed, votes: 3 };
      if (path.endsWith('/vote-reconciliations')) {
        const next = steps.shift();
        if (next instanceof Error) throw next;
        remaining = next?.remaining ?? 0;
        committed++;
        return { applied: true, changed: 1, remaining };
      }
      return {};
    });
    return { request, calls };
  }

  it('stops before taking the lease when the plan has conflicts or D1-only votes', async () => {
    for (const blocked of [{ conflict: 1 }, { d1Only: 1 }]) {
      const { request, calls } = server({ counts: blocked, changes: 2 });
      await expect(applyCapture(userId, capture, request)).rejects.toThrow('blocked');
      expect(calls).toEqual([`POST /users/${userId}/vote-reconciliations/plan`]);
    }
  });

  it('only verifies, without a lease, when there is nothing to apply', async () => {
    const { request, calls } = server({ changes: 0 });
    expect(await applyCapture(userId, capture, request)).toMatchObject({ steps: 0, changed: 0, verify: { verified: true } });
    expect(calls.some(c => c.includes('/lease'))).toBe(false);
  });

  it('applies bounded steps under one renewed lease and verifies before releasing it', async () => {
    const { request, calls } = server({ changes: MAX_STEP_CHANGES + 5 }, [{ remaining: 5 }, { remaining: 0 }]);
    expect(await applyCapture(userId, capture, request)).toMatchObject({ steps: 2 });
    expect(calls.filter(c => c === 'POST /lease')).toHaveLength(1);
    expect(calls.filter(c => c === 'POST /lease/renew')).toHaveLength(2);
    expect(calls.slice(-2)).toEqual([`GET /users/${userId}/vote-reconciliations/verify`, 'DELETE /lease']);
  });

  it('retries a step with an unknown outcome once, then gives up and still releases the lease', async () => {
    const once = server({ changes: 1 }, [new Error('timeout'), { remaining: 0 }]);
    expect(await applyCapture(userId, capture, once.request)).toMatchObject({ steps: 1 });

    const twice = server({ changes: 1 }, [new Error('timeout'), new Error('timeout')]);
    await expect(applyCapture(userId, capture, twice.request)).rejects.toThrow('timeout');
    expect(twice.calls.at(-1)).toBe('DELETE /lease');
  });

  it('counts a committed step even when its response is lost, without retrying it', async () => {
    let committed = false, writes = 0;
    const request = vi.fn(async (path: string): Promise<unknown> => {
      if (path.endsWith('/plan')) return { counts, changes: committed ? [] : [{}] };
      if (path.endsWith('/verify')) return { verified: true, reconciliations: committed ? 8 : 7, votes: 3 };
      if (path.endsWith('/vote-reconciliations')) { writes++; committed = true; throw new Error('timeout after commit'); }
      return {};
    });
    expect(await applyCapture(userId, capture, request)).toMatchObject({ steps: 1, changed: 1, verify: { reconciliations: 8 } });
    expect(writes).toBe(1);
    expect(request.mock.calls.at(-1)?.[0]).toBe('/lease');
  });

  it('refuses a server that keeps reporting remaining changes', async () => {
    const { request, calls } = server({ changes: 2 }, Array.from({ length: 10 }, () => ({ remaining: 2 })));
    await expect(applyCapture(userId, capture, request)).rejects.toThrow('converge');
    expect(calls.at(-1)).toBe('DELETE /lease');
  });
});
