// `pnpm eval` — measure the ranking against the reader's actual votes, so tuning
// profile.yaml is arithmetic instead of intuition.
//
//   pnpm eval                             # votes from the Worker (VOTES_URL), scores from
//                                         # the ledger + the digest cache
//   pnpm eval -- --votes dump.json        # offline: votes from a local {"votes":[...]} dump
//   pnpm eval -- --rescore                # ALSO re-score the cached papers with the current
//                                         # profile and compare metrics before/after (pays
//                                         # Anthropic once; this is the tuning loop)
//   pnpm eval -- --cache .cache/x.json --k 15
//
// The report goes to stdout; logs to stderr, as everywhere else.

import { parseArgs } from "node:util";
import { config } from "./config.js";
import { loadEnv } from "./env.js";
import { loadProfile } from "./profile.js";
import { loadCache } from "./cache.js";
import { JsonFileStore } from "./state.js";
import { makeAnthropicScorer } from "./scoring.js";
import {
  computeEvalMetrics,
  fetchVotes,
  joinVotes,
  loadVotesFile,
  type EvalMetrics,
  type Vote,
} from "./votes.js";
import { logger } from "./logger.js";
import { stripArgSeparator } from "./util.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: stripArgSeparator(process.argv.slice(2)),
    options: {
      votes: { type: "string" },
      cache: { type: "string", default: ".cache/digest.json" },
      rescore: { type: "boolean", default: false },
      k: { type: "string", default: "10" },
    },
  });

  const env = loadEnv();
  const profile = loadProfile();
  const threshold = profile.threshold ?? config.threshold;
  const k = Number(values.k);
  if (!Number.isFinite(k) || k <= 0) throw new Error(`--k must be a positive number`);

  // 1. Votes: local dump beats the Worker, so eval works offline and in tests.
  let votes: Vote[];
  if (values.votes) {
    votes = await loadVotesFile(values.votes);
  } else if (env.VOTES_URL && env.VOTES_READ_SECRET) {
    votes = await fetchVotes(env.VOTES_URL, env.VOTES_READ_SECRET);
  } else {
    throw new Error(
      "No votes available: pass --votes <file.json> or set VOTES_URL and VOTES_READ_SECRET.",
    );
  }
  logger.info("votes loaded", { count: votes.length });
  if (votes.length === 0) {
    process.stdout.write("Sin votos todavía — pulsa 👍/👎 en un digest primero.\n");
    return;
  }

  // 2. Scores: the ledger holds every considered paper; the cache adds full papers for --rescore.
  const store = new JsonFileStore("state.json");
  await store.load();
  const cache = await loadCache(values.cache).catch(() => undefined);
  const cachedScores = new Map((cache?.scored ?? []).map((p) => [p.pmid, p]));

  const scoreOf = (pmid: string) => {
    const fromCache = cachedScores.get(pmid);
    if (fromCache) return { title: fromCache.title, score: fromCache.relevance };
    const fromLedger = store.get(pmid);
    if (fromLedger) return { title: fromLedger.title, score: fromLedger.relevance };
    return undefined;
  };

  const { joined, unjoined } = joinVotes(votes, scoreOf);
  const metrics = computeEvalMetrics(joined, threshold, k);
  process.stdout.write(renderReport(metrics, threshold, unjoined.length));

  // 3. --rescore: same votes, fresh scores from the CURRENT profile. The delta is the effect
  //    of whatever was just edited in profile.yaml.
  if (values.rescore) {
    if (!cache) throw new Error(`--rescore needs a cache snapshot (${values.cache}).`);
    const votedPmids = new Set(joined.map((j) => j.pmid));
    const papers = cache.papers.filter((p) => votedPmids.has(p.pmid));
    if (papers.length === 0) {
      process.stdout.write("\n--rescore: el caché no contiene ninguno de los papers votados.\n");
      return;
    }

    logger.info("re-scoring voted papers with the current profile", { papers: papers.length });
    const scorer = makeAnthropicScorer(env.ANTHROPIC_API_KEY, config.model, config.batchSize);
    const rescored = await scorer.score(papers, { profile });
    const fresh = new Map(rescored.map((p) => [p.pmid, p]));

    const { joined: joinedNew } = joinVotes(votes, (pmid) => {
      const p = fresh.get(pmid);
      return p ? { title: p.title, score: p.relevance } : undefined;
    });
    const after = computeEvalMetrics(joinedNew, threshold, k);
    process.stdout.write(renderComparison(metrics, after));
  }
}

function fmt(n: number | undefined, digits = 1): string {
  return n === undefined ? "—" : n.toFixed(digits);
}

function renderReport(m: EvalMetrics, threshold: number, unjoined: number): string {
  const lines: string[] = [];
  lines.push(`Eval del ranking — ${m.joined} votos con score (${unjoined} sin score)`);
  lines.push(
    `👍 ${m.liked} · media ${fmt(m.likedAvg)}    👎 ${m.disliked} · media ${fmt(m.dislikedAvg)}` +
      (m.likedAvg !== undefined && m.dislikedAvg !== undefined
        ? `    separación ${fmt(m.likedAvg - m.dislikedAvg)}`
        : ""),
  );
  lines.push(`precision@${m.k}: ${fmt(m.precisionAtK, 2)} (umbral ${threshold})`);

  if (m.disagreements.length > 0) {
    lines.push("");
    lines.push("Desacuerdos (lo que hay que corregir en el perfil):");
    for (const d of m.disagreements) {
      const tag = d.value === 1 ? "👍 pero puntuó" : "👎 pero puntuó";
      lines.push(`  ${tag} ${d.score}/10 — ${d.title || d.pmid}`);
    }
  } else {
    lines.push("Sin desacuerdos: el modelo y el lector están alineados en los papers votados.");
  }
  return lines.join("\n") + "\n";
}

function renderComparison(before: EvalMetrics, after: EvalMetrics): string {
  const delta = (a?: number, b?: number) =>
    a !== undefined && b !== undefined ? ` (antes ${b.toFixed(2)})` : "";
  const sep = (m: EvalMetrics) =>
    m.likedAvg !== undefined && m.dislikedAvg !== undefined
      ? m.likedAvg - m.dislikedAvg
      : undefined;
  return (
    "\n--rescore con el perfil actual:\n" +
    `precision@${after.k}: ${fmt(after.precisionAtK, 2)}${delta(after.precisionAtK, before.precisionAtK)}\n` +
    `separación 👍/👎: ${fmt(sep(after))}${delta(sep(after), sep(before))}\n` +
    `desacuerdos: ${after.disagreements.length} (antes ${before.disagreements.length})\n`
  );
}

main().catch((err) => {
  logger.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
