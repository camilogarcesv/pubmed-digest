// Orchestration tests with fake dependencies — no network, no Anthropic, no files.

import { describe, expect, it } from "vitest";
import { config, type AppConfig } from "../src/config.js";
import { runDigestPipeline, type PaperFetcher, type PipelineDeps } from "../src/pipeline.js";
import { RunMetrics } from "../src/metrics.js";
import { MemoryStore } from "../src/state.js";
import type { Deliverer, OutMessage } from "../src/deliver.js";
import type { Scorer, ScoreContext, ScorerUsage } from "../src/scoring.js";
import type { Paper, ScoredPaper } from "../src/types.js";
import { makePaper, makeProfile } from "./helpers.js";

class CapturingDeliverer implements Deliverer {
  /** One entry per send() call; each call is the full message sequence. */
  readonly sent: OutMessage[][] = [];
  async send(messages: OutMessage[]): Promise<void> {
    this.sent.push(messages);
  }
  /** All text of the first delivery, for content assertions. */
  get firstText(): string {
    return (this.sent[0] ?? []).map((m) => m.text).join("\n\n");
  }
}

/** Scores by position so results are deterministic: first paper 10, then 9, 8... */
class FakeScorer implements Scorer {
  readonly usage: ScorerUsage = { calls: 0, inputTokens: 100, outputTokens: 20 };
  rerankCalls = 0;
  lastCtx?: ScoreContext;

  async score(papers: Paper[], ctx: ScoreContext): Promise<ScoredPaper[]> {
    this.usage.calls++;
    this.lastCtx = ctx;
    return papers.map((p, i) => ({ ...p, relevance: Math.max(0, 10 - i), reason: `r${p.pmid}` }));
  }
  async rerank(papers: ScoredPaper[], ctx: ScoreContext): Promise<ScoredPaper[]> {
    this.rerankCalls++;
    this.usage.calls++;
    this.lastCtx = ctx;
    return papers;
  }
}

class FailingLaterBatchScorer implements Scorer {
  readonly usage: ScorerUsage = { calls: 2, inputTokens: 100, outputTokens: 20 };
  async score(): Promise<ScoredPaper[]> {
    throw new Error("second scoring batch failed");
  }
  async rerank(papers: ScoredPaper[]): Promise<ScoredPaper[]> {
    return papers;
  }
}

class TrackingStore extends MemoryStore {
  saves = 0;
  override async save(): Promise<void> {
    this.saves++;
  }
}

/** esearch returns the ids it was configured with; efetch returns a paper per id. */
class FakeFetcher implements PaperFetcher {
  constructor(
    private readonly idsByTerm: Record<string, string[]>,
    private readonly failing = new Set<string>(),
    private readonly overrides: Record<string, Partial<Paper>> = {},
  ) {}

  async esearch(term: string) {
    if (this.failing.has(term)) throw new Error(`boom for ${term}`);
    const ids = this.idsByTerm[term] ?? [];
    return { ids, count: ids.length };
  }
  async efetch(pmids: string[]): Promise<Paper[]> {
    return pmids.map((id) => makePaper(id, this.overrides[id] ?? {}));
  }
}

function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps & {
  deliverer: CapturingDeliverer;
  scorer: FakeScorer;
} {
  const cfg: AppConfig = { ...config, rerankTopK: 0, threshold: 7, maxDelivered: 10, minDelivered: 0 };
  return {
    cfg,
    profile: makeProfile({ sources: { journals: ["J1"], queries: [] } }),
    pubmed: new FakeFetcher({ '"J1"[Journal]': ["1", "2"] }),
    scorer: new FakeScorer(),
    deliverer: new CapturingDeliverer(),
    metrics: new RunMetrics(),
    ...overrides,
  } as PipelineDeps & { deliverer: CapturingDeliverer; scorer: FakeScorer };
}

const OPTS = { title: "T", dryRun: false, store: new MemoryStore() };

describe("runDigestPipeline", () => {
  it("fetches, scores and delivers, recording every paper considered", async () => {
    const deps = makeDeps();
    const store = new MemoryStore();

    const { scored } = await runDigestPipeline(deps, { ...OPTS, store });

    expect(scored.map((p) => p.pmid)).toEqual(["1", "2"]);
    expect(deps.deliverer.sent).toHaveLength(1);
    expect(deps.deliverer.firstText).toContain("Título 1");
    expect(store.size()).toBe(2); // markSeenMode "considered"
  });

  // The bug this guards: a total source failure used to log, return early and exit 0, so a
  // broken week looked exactly like a quiet one and the failure alert never fired.
  it("throws when every source fails", async () => {
    const deps = makeDeps({
      pubmed: new FakeFetcher({}, new Set(['"J1"[Journal]'])),
    });

    await expect(runDigestPipeline(deps, { ...OPTS, store: new MemoryStore() })).rejects.toThrow(
      /Every source failed/,
    );
    expect(deps.deliverer.sent).toHaveLength(0);
  });

  it("tolerates a partial source failure and counts it", async () => {
    const deps = makeDeps({
      profile: makeProfile({ sources: { journals: ["J1", "J2"], queries: [] } }),
      pubmed: new FakeFetcher({ '"J1"[Journal]': ["1"] }, new Set(['"J2"[Journal]'])),
    });

    await runDigestPipeline(deps, { ...OPTS, store: new MemoryStore() });

    expect(deps.metrics.sourcesOk).toBe(1);
    expect(deps.metrics.sourcesFailed).toBe(1);
    expect(deps.deliverer.firstText).toContain("1 fuentes fallaron"); // surfaced in the footer
  });

  // Silence must always mean "broken", never "nothing new".
  it("still delivers a digest when there is nothing new", async () => {
    const deps = makeDeps({ pubmed: new FakeFetcher({ '"J1"[Journal]': [] }) });

    await runDigestPipeline(deps, { ...OPTS, store: new MemoryStore() });

    expect(deps.deliverer.sent).toHaveLength(1);
    expect(deps.deliverer.firstText).toContain("No hay artículos");
  });

  it("skips PMIDs already in the ledger", async () => {
    const deps = makeDeps();
    const store = new MemoryStore();
    store.record([{ pmid: "1", title: "t", firstSeen: "2026-07-01T00:00:00Z", delivered: false }]);

    const { scored } = await runDigestPipeline(deps, { ...OPTS, store });

    expect(scored.map((p) => p.pmid)).toEqual(["2"]);
  });

  it("records score, title and delivery flag in the ledger", async () => {
    const deps = makeDeps();
    const store = new MemoryStore();

    await runDigestPipeline(deps, { ...OPTS, store });

    // FakeScorer gives paper "1" a 10 (>= threshold 7) and "2" a 9 — both delivered.
    expect(store.get("1")).toMatchObject({ title: "Título 1", relevance: 10, delivered: true });
    expect(store.get("2")).toMatchObject({ relevance: 9, delivered: true });
  });

  it("turns votes into dynamic exemplars via the ledger, newest vote wins", async () => {
    const deps = makeDeps();
    const store = new MemoryStore();
    store.record([
      { pmid: "900", title: "Título votado 👍", firstSeen: "2026-07-20T00:00:00Z", delivered: true },
      { pmid: "901", title: "Título votado 👎", firstSeen: "2026-07-20T00:00:00Z", delivered: true },
    ]);
    deps.votes = [
      { pmid: "900", value: 0, chatId: "1", votedAt: "2026-07-21T00:00:00Z" },
      { pmid: "900", value: 1, chatId: "1", votedAt: "2026-07-22T00:00:00Z" }, // re-vote wins
      { pmid: "901", value: 0, chatId: "1", votedAt: "2026-07-21T00:00:00Z" },
      { pmid: "999", value: 1, chatId: "1", votedAt: "2026-07-21T00:00:00Z" }, // not in ledger
    ];

    await runDigestPipeline(deps, { ...OPTS, store });

    expect(deps.scorer.lastCtx?.exemplars).toEqual({
      liked: ["Título votado 👍"],
      disliked: ["Título votado 👎"],
    });
  });

  it("scores without exemplars when there are no votes", async () => {
    const deps = makeDeps();
    await runDigestPipeline(deps, { ...OPTS, store: new MemoryStore() });
    expect(deps.scorer.lastCtx?.exemplars).toBeUndefined();
  });

  it("drops excluded publication types and duplicate DOIs before scoring", async () => {
    const deps = makeDeps({
      pubmed: new FakeFetcher({ '"J1"[Journal]': ["1", "2", "3"] }, new Set(), {
        "2": { publicationTypes: ["Published Erratum"] },
        "3": { doi: "10.1/dup" },
        "1": { doi: "10.1/dup" },
      }),
    });

    const { scored } = await runDigestPipeline(deps, { ...OPTS, store: new MemoryStore() });

    expect(scored.map((p) => p.pmid)).toEqual(["1"]);
    expect(deps.metrics.droppedByType).toBe(1);
    expect(deps.metrics.droppedByDoi).toBe(1);
    // Everything fetched is still marked, so the dropped ones are never fetched again.
    expect(deps.metrics.fetched).toBe(3);
  });

  it("does not write state on a dry run", async () => {
    const deps = makeDeps();
    const store = new MemoryStore();

    await runDigestPipeline(deps, { ...OPTS, dryRun: true, store });

    expect(store.size()).toBe(0);
    expect(deps.deliverer.sent).toHaveLength(1);
  });

  it("does not deliver or persist when scoring fails", async () => {
    const deps = makeDeps({ scorer: new FailingLaterBatchScorer() });
    const store = new TrackingStore();
    store.record([
      { pmid: "existing", title: "Already there", firstSeen: "2026-08-01", delivered: true },
    ]);

    await expect(runDigestPipeline(deps, { ...OPTS, store })).rejects.toThrow(
      "second scoring batch failed",
    );

    expect(deps.deliverer.sent).toHaveLength(0);
    expect(store.entries()).toHaveLength(1);
    expect(store.get("existing")).toBeDefined();
    expect(store.saves).toBe(0);
    expect(deps.metrics).toMatchObject({ calls: 2, inputTokens: 100, outputTokens: 20 });
  });

  it("records only delivered papers under markSeenMode 'delivered'", async () => {
    const deps = makeDeps();
    deps.cfg = { ...deps.cfg, markSeenMode: "delivered", threshold: 10 }; // only the top paper
    const store = new MemoryStore();

    await runDigestPipeline(deps, { ...OPTS, store });

    expect(store.size()).toBe(1);
    expect(store.has("1")).toBe(true);
  });

  it("re-ranks the finalists when rerankTopK is set", async () => {
    const deps = makeDeps();
    deps.cfg = { ...deps.cfg, rerankTopK: 5 };

    await runDigestPipeline(deps, { ...OPTS, store: new MemoryStore() });

    expect(deps.scorer.rerankCalls).toBe(1);
    expect(deps.metrics.calls).toBe(deps.scorer.usage.calls);
  });

  it("honours --limit as a cap on papers scored", async () => {
    const deps = makeDeps({
      pubmed: new FakeFetcher({ '"J1"[Journal]': ["1", "2", "3", "4"] }),
    });

    const { scored } = await runDigestPipeline(deps, { ...OPTS, store: new MemoryStore(), limit: 2 });

    expect(scored).toHaveLength(2);
  });

  it("refuses to run with a profile that defines no sources", async () => {
    const deps = makeDeps({ profile: makeProfile() });

    await expect(runDigestPipeline(deps, { ...OPTS, store: new MemoryStore() })).rejects.toThrow(
      /no sources/,
    );
  });
});
