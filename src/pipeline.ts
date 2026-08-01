// Orchestration, separated from CLI wiring so it can be tested with fakes. index.ts parses
// flags and builds the real dependencies; everything that decides what happens lives here.

import type { AppConfig } from "./config.js";
import type { Profile } from "./profile.js";
import type { Paper, ScoredPaper } from "./types.js";
import type { Deliverer } from "./deliver.js";
import type { Scorer } from "./scoring.js";
import type { SeenStore } from "./state.js";
import type { ESearchOptions, ESearchResult } from "./pubmed.js";
import { journalTerm, topicTerm } from "./pubmed.js";
import { dedupeByDoi, excludeByPublicationType } from "./filter.js";
import { renderDigestMessages, selectForDigest, type Selection } from "./digest.js";
import { dynamicExemplars, type Vote } from "./votes.js";
import { RunMetrics } from "./metrics.js";
import { logger } from "./logger.js";
import { chunk } from "./util.js";

/** The slice of PubMedClient the pipeline needs — lets tests inject a fake without HTTP. */
export interface PaperFetcher {
  esearch(term: string, opts: ESearchOptions): Promise<ESearchResult>;
  efetch(pmids: string[]): Promise<Paper[]>;
}

export interface PipelineDeps {
  cfg: AppConfig;
  profile: Profile;
  pubmed: PaperFetcher;
  scorer: Scorer;
  deliverer: Deliverer;
  metrics: RunMetrics;
  /** Recent 👍/👎 votes from the Worker; undefined/empty leaves scoring exactly as before. */
  votes?: Vote[];
}

export interface DigestOptions {
  title: string;
  dryRun: boolean;
  limit?: number;
  store: SeenStore;
}

interface Source {
  label: string;
  term: string;
}

/** Journals plus standing queries, both owned by the profile. */
export function sourcesFor(profile: Profile): Source[] {
  return [
    ...profile.sources.journals.map((j) => ({ label: j, term: journalTerm(j) })),
    ...profile.sources.queries.map((q) => ({ label: q, term: topicTerm(q) })),
  ];
}

/**
 * Collect new PMIDs across every source. Individual failures are tolerated (one dead journal
 * shouldn't cancel the week), but a total failure throws: otherwise the run would report
 * "nothing new" and exit 0, which is indistinguishable from a genuinely quiet week.
 */
async function collectPmids(
  deps: PipelineDeps,
  sources: Source[],
  isSeen: (pmid: string) => boolean,
): Promise<Map<string, string>> {
  const { cfg, pubmed, metrics } = deps;
  const pmidToSource = new Map<string, string>();

  for (const s of sources) {
    try {
      const { ids, count } = await pubmed.esearch(s.term, {
        reldate: cfg.lookbackDays,
        retmax: cfg.esearchRetmax,
      });
      metrics.sourcesOk++;
      metrics.found += ids.length;
      if (count > ids.length) {
        metrics.sourcesTruncated++;
        logger.warn("source truncated by retmax; widen retmax or narrow the query", {
          source: s.label,
          returned: ids.length,
          total: count,
        });
      }
      logger.info("esearch", { source: s.label, found: ids.length, total: count });
      for (const id of ids) {
        if (isSeen(id)) continue; // handled in a previous run
        if (!pmidToSource.has(id)) pmidToSource.set(id, s.label); // dedupe within this run
      }
    } catch (err) {
      metrics.sourcesFailed++;
      logger.error("esearch failed, skipping source", { source: s.label, error: String(err) });
    }
  }

  if (sources.length > 0 && metrics.sourcesFailed === sources.length) {
    throw new Error(
      `Every source failed (${sources.length}/${sources.length}). PubMed may be down or the ` +
        "query/credentials may be wrong — refusing to report an empty digest as success.",
    );
  }
  return pmidToSource;
}

async function fetchPapers(
  deps: PipelineDeps,
  pmids: string[],
  source: ReadonlyMap<string, string>,
): Promise<Paper[]> {
  const out: Paper[] = [];
  for (const batch of chunk(pmids, deps.cfg.efetchIdBatchSize)) {
    const papers = await deps.pubmed.efetch(batch);
    for (const p of papers) p.source = source.get(p.pmid) ?? "";
    out.push(...papers);
  }
  deps.metrics.fetched += out.length;
  return out;
}

/** Drop editorial noise and duplicate DOIs before anything is billed. */
export function prefilter(deps: PipelineDeps, papers: Paper[]): Paper[] {
  const byType = excludeByPublicationType(papers, deps.cfg.excludedPublicationTypes);
  const byDoi = dedupeByDoi(byType.kept);
  deps.metrics.droppedByType += byType.dropped.length;
  deps.metrics.droppedByDoi += byDoi.dropped.length;

  for (const { paper, reason } of [...byType.dropped, ...byDoi.dropped]) {
    logger.info("dropped before scoring", { pmid: paper.pmid, reason });
  }
  return byDoi.kept;
}

/** Score everything, then re-rank the finalists against each other. */
async function scoreAndRerank(
  deps: PipelineDeps,
  papers: Paper[],
  topic?: string,
  exemplars?: { liked: string[]; disliked: string[] },
): Promise<ScoredPaper[]> {
  const { cfg, scorer, profile, metrics } = deps;
  const toScore = cfg.scoreWithoutAbstract ? papers : papers.filter((p) => p.hasAbstract);
  if (!cfg.scoreWithoutAbstract && toScore.length < papers.length) {
    logger.info("dropped papers without abstract", { dropped: papers.length - toScore.length });
  }

  const scored = await scorer.score(toScore, { profile, topic, exemplars });
  metrics.scored += scored.length;

  const refined = await rerankFinalists(deps, scored, topic, exemplars);
  metrics.calls = scorer.usage.calls;
  metrics.inputTokens = scorer.usage.inputTokens;
  metrics.outputTokens = scorer.usage.outputTokens;
  return refined;
}

async function rerankFinalists(
  deps: PipelineDeps,
  scored: ScoredPaper[],
  topic?: string,
  exemplars?: { liked: string[]; disliked: string[] },
): Promise<ScoredPaper[]> {
  const k = deps.cfg.rerankTopK;
  if (k <= 0 || scored.length < 2) return scored;

  const ranked = [...scored].sort((a, b) => b.relevance - a.relevance);
  const finalists = ranked.slice(0, k);
  if (finalists.length < 2) return scored;

  logger.info("re-ranking finalists", { count: finalists.length });
  const refined = await deps.scorer.rerank(finalists, { profile: deps.profile, topic, exemplars });
  const byPmid = new Map(refined.map((p) => [p.pmid, p]));
  return scored.map((p) => byPmid.get(p.pmid) ?? p);
}

/** Select, render and deliver. Shared by the live run and both cache replay paths. */
export async function deliverDigest(
  deps: PipelineDeps,
  scored: ScoredPaper[],
  title: string,
): Promise<Selection> {
  const { cfg, metrics, deliverer } = deps;
  const selection = selectForDigest(scored, {
    threshold: cfg.threshold,
    max: cfg.maxDelivered,
    min: cfg.minDelivered,
  });
  metrics.delivered = selection.kept.length;
  metrics.nearMisses = selection.nearMisses.length;

  logger.info("selected", {
    scored: scored.length,
    kept: selection.kept.length,
    nearMisses: selection.nearMisses.length,
    threshold: cfg.threshold,
  });

  const footer = metrics.telegramFooter(cfg.pricing);
  await deliverer.send(
    renderDigestMessages(selection.kept, { title, footer, withKeyboards: true }, selection.nearMisses),
  );
  return selection;
}

export interface DigestResult {
  papers: Paper[];
  scored: ScoredPaper[];
}

/** The weekly digest: search → fetch → prefilter → score → re-rank → deliver → record. */
export async function runDigestPipeline(
  deps: PipelineDeps,
  opts: DigestOptions,
): Promise<DigestResult> {
  const { cfg, metrics } = deps;
  const { store } = opts;

  const sources = sourcesFor(deps.profile);
  if (sources.length === 0) {
    throw new Error("The profile defines no sources. Add sources.journals or sources.queries.");
  }

  const pmidToSource = await collectPmids(deps, sources, (id) => store.has(id));
  let newPmids = [...pmidToSource.keys()];
  metrics.newAfterDedupe = newPmids.length;
  logger.info("new PMIDs after dedupe", { count: newPmids.length });

  // Always deliver, even with nothing new: a silent Monday must mean "broken", never "quiet".
  if (newPmids.length === 0) {
    logger.info("nothing new to score");
    await deliverDigest(deps, [], opts.title);
    return { papers: [], scored: [] };
  }

  const cap = Math.min(opts.limit ?? cfg.maxAbstractsPerRun, cfg.maxAbstractsPerRun);
  if (newPmids.length > cap) {
    logger.warn("capping papers scored", { from: newPmids.length, to: cap });
    newPmids = newPmids.slice(0, cap);
  }

  const fetched = await fetchPapers(deps, newPmids, pmidToSource);
  const papers = prefilter(deps, fetched);

  // Recent votes become few-shot exemplars: the titles come from the ledger (votes only carry
  // PMIDs), so this is a pure local join — no extra network or cost.
  const exemplars = deps.votes?.length
    ? dynamicExemplars(deps.votes, store, cfg.dynamicExemplarsMax)
    : undefined;
  if (exemplars) {
    logger.info("dynamic exemplars from votes", {
      liked: exemplars.liked.length,
      disliked: exemplars.disliked.length,
    });
  }

  const scored = await scoreAndRerank(deps, papers, undefined, exemplars);

  const selection = await deliverDigest(deps, scored, opts.title);

  if (opts.dryRun) {
    logger.info("dry-run: state not updated");
    return { papers, scored };
  }

  // Record everything fetched — including papers the prefilter dropped — so nothing is ever
  // fetched (or billed) twice. Under "delivered" mode only what was actually sent is recorded.
  const deliveredSet = new Set(selection.kept.map((p) => p.pmid));
  const scoreByPmid = new Map(scored.map((p) => [p.pmid, p.relevance]));
  const now = new Date().toISOString();
  const toRecord = (cfg.markSeenMode === "delivered"
    ? fetched.filter((p) => deliveredSet.has(p.pmid))
    : fetched
  ).map((p) => ({
    pmid: p.pmid,
    title: p.title,
    firstSeen: now,
    relevance: scoreByPmid.get(p.pmid),
    delivered: deliveredSet.has(p.pmid),
  }));
  store.record(toRecord);
  await store.save();
  logger.info("digest delivered and state saved", {
    marked: toRecord.length,
    seenTotal: store.size(),
  });

  return { papers, scored };
}

export interface SearchOptions {
  topic: string;
  title: string;
  limit?: number;
}

/** Ad-hoc search: the topic is the primary criterion and there is no threshold or state. */
export async function runSearchPipeline(
  deps: PipelineDeps,
  opts: SearchOptions,
): Promise<DigestResult> {
  const { cfg, metrics, deliverer } = deps;
  const term = topicTerm(opts.topic);
  logger.info("search", { topic: opts.topic, term });

  const { ids, count } = await deps.pubmed.esearch(term, {
    reldate: cfg.lookbackDays,
    retmax: cfg.esearchRetmax,
  });
  metrics.sourcesOk++;
  metrics.found = ids.length;
  metrics.newAfterDedupe = ids.length;
  if (count > ids.length) metrics.sourcesTruncated++;
  logger.info("search esearch", { found: ids.length, total: count });

  if (ids.length === 0) {
    await deliverer.send([{ text: `<b>${opts.title}</b>\n\nSin resultados recientes.` }]);
    return { papers: [], scored: [] };
  }

  const cap = Math.min(opts.limit ?? cfg.maxAbstractsPerRun, cfg.maxAbstractsPerRun);
  const capped = ids.length > cap ? ids.slice(0, cap) : ids;
  if (capped.length < ids.length) {
    logger.warn("capping search papers", { from: ids.length, to: cap });
  }

  const source = new Map(capped.map((id) => [id, opts.topic] as const));
  const fetched = await fetchPapers(deps, capped, source);
  const papers = prefilter(deps, fetched);
  const scored = await scoreAndRerank(deps, papers, opts.topic);

  await deliverSearch(deps, scored, opts.title);
  return { papers, scored };
}

/**
 * Search shows the top-N ranked; the digest threshold does not apply here, and neither do the
 * vote keyboards — topic-primary scores aren't comparable with the profile's, so votes on
 * search results would pollute the feedback signal.
 */
export async function deliverSearch(
  deps: PipelineDeps,
  scored: ScoredPaper[],
  title: string,
): Promise<void> {
  const { cfg, metrics, deliverer } = deps;
  const top = [...scored].sort((a, b) => b.relevance - a.relevance).slice(0, cfg.searchTopResults);
  metrics.delivered = top.length;
  await deliverer.send(
    renderDigestMessages(top, { title, footer: metrics.telegramFooter(cfg.pricing) }),
  );
  logger.info("search delivered", { results: top.length });
}
