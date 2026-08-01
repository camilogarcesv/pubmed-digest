// Reads the votes the Cloudflare Worker collected (GET /votes, bearer-protected) and turns
// them into scoring signal. Everything here is optional at runtime: without VOTES_URL the
// digest behaves exactly as before.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { SeenStore } from "./state.js";
import { logger } from "./logger.js";

export const VoteSchema = z.object({
  pmid: z.string(),
  value: z.union([z.literal(0), z.literal(1)]),
  chatId: z.string(),
  votedAt: z.string(),
});
const VotesResponseSchema = z.object({ votes: z.array(VoteSchema) });

export type Vote = z.infer<typeof VoteSchema>;

/** Fetch every vote from the Worker. Throws on HTTP/shape errors — callers decide tolerance. */
export async function fetchVotes(
  url: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Vote[]> {
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${secret}` } });
  if (!res.ok) throw new Error(`votes endpoint failed: HTTP ${res.status}`);
  const parsed = VotesResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`votes endpoint returned an unexpected shape: ${parsed.error.message}`);
  }
  return parsed.data.votes;
}

/** Load votes from a local JSON dump ({"votes": [...]}) — offline eval and tests. */
export async function loadVotesFile(path: string): Promise<Vote[]> {
  const raw = await readFile(path, "utf8");
  const parsed = VotesResponseSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`votes file ${path} failed validation: ${parsed.error.message}`);
  }
  return parsed.data.votes;
}

// -------------------- Eval: measuring the ranking against the votes --------------------

export interface JoinedVote {
  pmid: string;
  title: string;
  value: 0 | 1;
  /** The score the model gave this paper (from the ledger or a cache snapshot). */
  score: number;
}

export interface EvalMetrics {
  votes: number;
  joined: number;
  liked: number;
  disliked: number;
  likedAvg?: number;
  dislikedAvg?: number;
  /** Of the k best-scored voted papers, the fraction the reader actually liked. */
  precisionAtK?: number;
  k: number;
  /** Where reader and model disagree — the exact list that says what to fix in the profile. */
  disagreements: JoinedVote[];
}

/** Deduplicate votes (newest per pmid wins) and attach each one's title and score. */
export function joinVotes(
  votes: Vote[],
  scoreOf: (pmid: string) => { title?: string; score?: number } | undefined,
): { joined: JoinedVote[]; unjoined: Vote[] } {
  const newestFirst = [...votes].sort((a, b) => b.votedAt.localeCompare(a.votedAt));
  const decided = new Map<string, Vote>();
  for (const v of newestFirst) {
    if (!decided.has(v.pmid)) decided.set(v.pmid, v);
  }

  const joined: JoinedVote[] = [];
  const unjoined: Vote[] = [];
  for (const v of decided.values()) {
    const info = scoreOf(v.pmid);
    if (info?.score === undefined) {
      unjoined.push(v);
      continue;
    }
    joined.push({ pmid: v.pmid, title: info.title ?? "", value: v.value, score: info.score });
  }
  return { joined, unjoined };
}

export function computeEvalMetrics(
  joined: JoinedVote[],
  threshold: number,
  k = 10,
): EvalMetrics {
  const liked = joined.filter((j) => j.value === 1);
  const disliked = joined.filter((j) => j.value === 0);
  const avg = (xs: JoinedVote[]) =>
    xs.length ? xs.reduce((s, j) => s + j.score, 0) / xs.length : undefined;

  const kEff = Math.min(k, joined.length);
  const topK = [...joined].sort((a, b) => b.score - a.score).slice(0, kEff);
  const precisionAtK = kEff > 0 ? topK.filter((j) => j.value === 1).length / kEff : undefined;

  // A liked paper the model scored below the bar, or a disliked one it scored clearly above.
  const disagreements = joined
    .filter((j) => (j.value === 1 && j.score < threshold) || (j.value === 0 && j.score > threshold))
    .sort((a, b) => Math.abs(b.score - threshold) - Math.abs(a.score - threshold));

  return {
    votes: joined.length,
    joined: joined.length,
    liked: liked.length,
    disliked: disliked.length,
    likedAvg: avg(liked),
    dislikedAvg: avg(disliked),
    precisionAtK,
    k: kEff,
    disagreements,
  };
}

export interface DynamicExemplars {
  liked: string[];
  disliked: string[];
}

/**
 * Turn votes into few-shot titles for the scoring prompt, newest votes first. A paper voted
 * both ways (re-votes overwrite per chat, but two chats can disagree) counts by its most
 * recent vote. Titles come from the ledger — votes only carry PMIDs.
 */
export function dynamicExemplars(votes: Vote[], store: SeenStore, max: number): DynamicExemplars {
  const newestFirst = [...votes].sort((a, b) => b.votedAt.localeCompare(a.votedAt));
  const decided = new Map<string, Vote>();
  for (const v of newestFirst) {
    if (!decided.has(v.pmid)) decided.set(v.pmid, v);
  }

  const liked: string[] = [];
  const disliked: string[] = [];
  for (const v of decided.values()) {
    const title = store.get(v.pmid)?.title;
    if (!title) {
      logger.debug("vote for a pmid the ledger no longer has", { pmid: v.pmid });
      continue;
    }
    const bucket = v.value === 1 ? liked : disliked;
    if (bucket.length < max) bucket.push(title);
  }
  return { liked, disliked };
}
