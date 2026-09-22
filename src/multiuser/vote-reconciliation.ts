import { z } from 'zod';
import { Pmid, Sha256, Timestamp } from './contracts.js';
import { ImportRecord, canonical, checksum } from './import-contracts.js';

// KV stays the vote authority until the D1 cutover. A reconciliation copies a strict KV
// capture into D1 and seals the exact before/after of every vote it changed. Runtime-
// independent: shared by the operator CLI (Node) and the Worker.

/** D1 Free allows 50 queries per invocation; a verified step uses at most 43 queries. */
export const MAX_STEP_CHANGES = 20;
export const MAX_CAPTURED_VOTES = 2000;

export const CapturedVote = ImportRecord.options[1].omit({ kind: true });
export type CapturedVote = z.infer<typeof CapturedVote>;
export const VoteCapture = z.strictObject({
  format: z.literal(1), id: z.uuid(), capturedAt: Timestamp,
  codeSha: z.string().regex(/^[a-f0-9]{40}$/), checksum: Sha256,
  votes: z.array(CapturedVote).max(MAX_CAPTURED_VOTES),
}).refine(c => new Set(c.votes.map(v => `${v.chatId}:${v.pmid}`)).size === c.votes.length, 'Duplicate captured vote');
export type VoteCapture = z.infer<typeof VoteCapture>;

export const VoteState = z.strictObject({ value: z.union([z.literal(0), z.literal(1)]), votedAt: Timestamp });
export type VoteState = z.infer<typeof VoteState>;
export const VoteChange = z.strictObject({ pmid: Pmid, before: VoteState.nullable(), after: VoteState });
export type VoteChange = z.infer<typeof VoteChange>;
export type VoteMap = Map<string, VoteState>;

export class ReplayError extends Error {
  override readonly name = 'ReplayError';
}

/** Parse a capture and prove its votes are the ones its checksum was taken over. */
export async function parseCapture(input: unknown): Promise<VoteCapture> {
  const capture = VoteCapture.parse(input);
  if (await checksum(capture.votes) !== capture.checksum) throw new ReplayError('Capture checksum mismatch');
  return capture;
}

export interface ReconciliationPlan {
  counts: { captured: number; unmapped: number; new: number; update: number; unchanged: number; unresolved: number; conflict: number; d1Only: number };
  /** New and updated votes, by PMID. Applied in steps of MAX_STEP_CHANGES. */
  changes: VoteChange[];
  /** Voted PMIDs absent from this user's imported ledger: kept in KV, not invented in D1. */
  unresolved: string[];
  /** D1 newer than, or contradicting, the authority. Blocks every step. */
  conflicts: Array<{ pmid: string; captured: VoteState; current: VoteState }>;
  /** Votes D1 has and the capture lacks. KV never deletes votes, so this also blocks. */
  d1Only: string[];
}

/**
 * Classify a capture against D1. `votes` are this user's captured votes (already mapped
 * from their destinations); `unmapped` counts captured votes of other chats.
 */
export function planReconciliation(votes: CapturedVote[], current: VoteMap, resolvable: ReadonlySet<string>, unmapped = 0): ReconciliationPlan {
  const plan: ReconciliationPlan = { counts: { captured: votes.length + unmapped, unmapped, new: 0, update: 0, unchanged: 0, unresolved: 0, conflict: 0, d1Only: 0 }, changes: [], unresolved: [], conflicts: [], d1Only: [] };
  const captured = new Set<string>();
  for (const vote of [...votes].sort((a, b) => a.pmid.localeCompare(b.pmid))) {
    if (captured.has(vote.pmid)) throw new ReplayError('Duplicate vote for one user');
    captured.add(vote.pmid);
    const after = { value: vote.value, votedAt: vote.votedAt };
    const before = current.get(vote.pmid) ?? null;
    if (!resolvable.has(vote.pmid)) { plan.unresolved.push(vote.pmid); plan.counts.unresolved++; }
    else if (!before) { plan.changes.push({ pmid: vote.pmid, before, after }); plan.counts.new++; }
    else if (after.votedAt > before.votedAt) { plan.changes.push({ pmid: vote.pmid, before, after }); plan.counts.update++; }
    else if (after.votedAt === before.votedAt && after.value === before.value) plan.counts.unchanged++;
    else { plan.conflicts.push({ pmid: vote.pmid, captured: after, current: before }); plan.counts.conflict++; }
  }
  plan.d1Only = [...current.keys()].filter(pmid => !captured.has(pmid)).sort();
  plan.counts.d1Only = plan.d1Only.length;
  return plan;
}

const same = (a: VoteState | null | undefined, b: VoteState | null) => canonical(a ?? null) === canonical(b);
function checkStep(step: VoteChange[]) {
  if (new Set(step.map(c => c.pmid)).size !== step.length) throw new ReplayError('Duplicate change in one step');
}

/** Apply sealed steps in sequence; every change must start from the state it recorded. */
export function replayForward(base: VoteMap, steps: VoteChange[][]): VoteMap {
  const state = new Map(base);
  for (const step of steps) {
    checkStep(step);
    for (const change of step) {
      if (!same(state.get(change.pmid), change.before)) throw new ReplayError('Reconciliation chain broken');
      state.set(change.pmid, change.after);
    }
  }
  return state;
}

/** Undo sealed steps from the current state, newest first, back to the imported votes. */
export function replayReverse(current: VoteMap, steps: VoteChange[][]): VoteMap {
  const state = new Map(current);
  for (const step of [...steps].reverse()) {
    checkStep(step);
    for (const change of [...step].reverse()) {
      if (!same(state.get(change.pmid), change.after)) throw new ReplayError('Reconciliation chain broken');
      if (change.before) state.set(change.pmid, change.before);
      else state.delete(change.pmid);
    }
  }
  return state;
}
