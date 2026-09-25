// `pnpm d1:lag -- --user <slug> --state state.json` — how far one user's D1 copy trails the legacy
// authorities: the state ledger and the KV votes. Read-only; prints counts only.

import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { Ledger } from "./import-package.js";
import { fetchStrictVotes } from "./import-user.js";
import { backendFromEnv, type DigestBackend } from "../backend/client.js";
import { stripArgSeparator } from "../util.js";

export const LegacyVoteOwner = z.strictObject({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  chatId: z.string().regex(/^-?\d{1,20}$/),
});

type KvVote = { pmid: string; value: 0 | 1; chatId: string; votedAt: string };
export interface Lag {
  ledgerArticles: number;
  /** Ledger articles D1 neither holds in the history nor reserves in an open run. */
  ledgerMissingInD1: number;
  /** Number of chats in the export; only the explicitly mapped owner is compared. */
  kvChats: number;
  kvVotesOtherChats: number;
  kvVotedArticles: number;
  d1VotedArticles: number;
  kvVotesMissingInD1: number;
  /** Newer KV votes, matching the reconciliation update rule. */
  kvVotesChangedInD1: number;
  kvVotesConflictingWithD1: number;
  d1VotesMissingInKV: number;
}

export async function measureLag(backend: DigestBackend, owner: z.infer<typeof LegacyVoteOwner>, ledgerPmids: string[], kvVotes: KvVote[]): Promise<Lag> {
  const mapping = LegacyVoteOwner.parse(owner);
  const user = await backend.context(mapping.slug);
  const [seen, d1Rows] = await Promise.all([
    ledgerPmids.length ? backend.seen(ledgerPmids.map(pmid => ({ userId: user.userId, pmid }))) : Promise.resolve([]),
    backend.evalContext(user.userId),
  ]);
  const d1 = new Map(d1Rows.map(v => [v.pmid, v]));
  const newest = new Map<string, KvVote>();
  for (const v of kvVotes.filter(v => v.chatId === mapping.chatId)) {
    if (newest.has(v.pmid)) throw new Error("Duplicate owner vote");
    newest.set(v.pmid, v);
  }
  const missing = [...newest.keys()].filter(pmid => !d1.has(pmid));
  const changed = [...newest.values()].filter(v => { const r = d1.get(v.pmid); return r !== undefined && r.votedAt < v.votedAt; });
  const conflicts = [...newest.values()].filter(v => { const r = d1.get(v.pmid); return r !== undefined && (r.votedAt > v.votedAt || (r.votedAt === v.votedAt && r.value !== v.value)); });
  return {
    ledgerArticles: ledgerPmids.length,
    ledgerMissingInD1: seen.filter(s => !s).length,
    kvChats: new Set(kvVotes.map(v => v.chatId)).size,
    kvVotesOtherChats: kvVotes.filter(v => v.chatId !== mapping.chatId).length,
    kvVotedArticles: newest.size,
    d1VotedArticles: d1.size,
    kvVotesMissingInD1: missing.length,
    kvVotesChangedInD1: changed.length,
    kvVotesConflictingWithD1: conflicts.length,
    d1VotesMissingInKV: [...d1.keys()].filter(pmid => !newest.has(pmid)).length,
  };
}

async function main(): Promise<void> {
  // Same local setup as the digest and eval commands; variables already set win over .env.
  if (existsSync(".env")) process.loadEnvFile(".env");
  const { values } = parseArgs({ args: stripArgSeparator(process.argv.slice(2)), options: { user: { type: "string" }, state: { type: "string" } } });
  const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).parse(values.user);
  const owner = LegacyVoteOwner.parse(JSON.parse(z.string().min(1).parse(process.env.LEGACY_VOTE_OWNER)));
  if (owner.slug !== slug) throw new Error("Legacy vote owner does not match requested user");
  // Strict: an unreadable or invalid ledger fails loudly instead of reading as "no lag".
  const ledger = Ledger.parse(JSON.parse(readFileSync(z.string().min(1).parse(values.state), "utf8")));
  const votesUrl = new URL(z.string().url().parse(process.env.VOTES_URL));
  const exported = await fetchStrictVotes(votesUrl.origin, z.string().min(1).parse(process.env.VOTES_READ_SECRET));
  const lag = await measureLag(backendFromEnv(process.env), owner, Object.keys(ledger.papers), exported.votes);
  process.stdout.write(JSON.stringify({ d1Lag: lag }, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Validation and transport errors may contain ledger keys, vote records or private URLs.
    console.error(JSON.stringify({ error: "d1_lag_failed" }));
    process.exitCode = 1;
  });
}
