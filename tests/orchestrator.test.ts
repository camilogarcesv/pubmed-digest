// The D1 multi-user digest against an in-memory backend that follows the Worker's lifecycle rules.

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { config } from "../src/config.js";
import { runDigestPipeline, type PaperFetcher } from "../src/pipeline.js";
import { RunMetrics } from "../src/metrics.js";
import { MemoryStore } from "../src/state.js";
import { journalTerm, topicTerm } from "../src/pubmed.js";
import { voteKeyboard } from "../src/feedback.js";
import type { OutMessage } from "../src/deliver.js";
import type { Scorer, ScoreContext, ScorerUsage } from "../src/scoring.js";
import type { Paper, ScoredPaper } from "../src/types.js";
import { BackendError, type BackendUser, type DigestBackend } from "../src/backend/client.js";
import { digestItems, legacyProfile, outboundMessages, runMultiuserDigest, uploadChunks, type OrchestratorDeps } from "../src/multiuser/orchestrator.js";
import type { CreateRun, DeliveryOutcome, DigestItem, EvalVote, PrepareRun, RunProgress } from "../src/multiuser/contracts.js";
import { makePaper, makeProfile, makeScored } from "./helpers.js";

type Item = z.infer<typeof DigestItem>;
const now = new Date("2026-09-21T12:00:00.000Z");
const period = "2026-W39";
const title = "📚 Digest de artículos (2026-09-21)";

class FakeScorer implements Scorer {
  readonly usage: ScorerUsage = { calls: 0, inputTokens: 100, outputTokens: 20 };
  contexts: ScoreContext[] = [];
  constructor(private readonly fail = false) {}
  async score(papers: Paper[], ctx: ScoreContext): Promise<ScoredPaper[]> {
    if (this.fail) throw new Error("scoring failed");
    this.usage.calls++;
    this.contexts.push(ctx);
    return papers.map((p, i) => ({ ...p, relevance: Math.max(0, 10 - i), reason: `r${p.pmid}` }));
  }
  async rerank(papers: ScoredPaper[]): Promise<ScoredPaper[]> { this.usage.calls++; return papers; }
}

class FakeFetcher implements PaperFetcher {
  searches: string[] = [];
  fetched: string[] = [];
  constructor(private readonly idsByTerm: Record<string, string[]>, private readonly failing = new Set<string>(), private readonly overrides: Record<string, Partial<Paper>> = {}) {}
  async esearch(term: string) {
    this.searches.push(term);
    if (this.failing.has(term)) throw new Error(`boom for ${term}`);
    const ids = this.idsByTerm[term] ?? [];
    return { ids, count: ids.length };
  }
  async efetch(pmids: string[]): Promise<Paper[]> {
    this.fetched.push(...pmids);
    return pmids.map(id => makePaper(id, this.overrides[id] ?? {}));
  }
}

type FakeRun = RunProgress & { input: z.infer<typeof CreateRun>; itemList: Item[]; outbox: Map<string, z.infer<typeof PrepareRun>["destinations"][number]["messages"]>; sent: Map<string, number> };

/** Follows the Worker: idempotent run key, one message per deliver call, history only once all is sent. */
class FakeBackend implements DigestBackend {
  modeValue: "legacy" | "maintenance" | "d1" = "d1";
  users: BackendUser[] = [];
  seenSet = new Set<string>();
  votes = new Map<string, EvalVote[]>();
  runList: FakeRun[] = [];
  writes: string[] = [];
  delivered: { userId: string; destinationId: string; text: string; pmid: string | null; votable: boolean }[] = [];
  alerts: string[] = [];
  script: (DeliveryOutcome | Error)[] = [];
  history = new Map<string, Item[]>();

  async mode() { return this.modeValue; }
  async contexts() { return this.users.filter(u => u.status !== "paused"); }
  async context(slug: string) {
    const user = this.users.find(u => u.slug === slug);
    if (!user) throw new BackendError(404, "not_found");
    return user;
  }
  async seen(pairs: { userId: string; pmid: string }[]) { return pairs.map(p => this.seenSet.has(`${p.userId}:${p.pmid}`)); }
  async evalContext(userId: string) { return this.votes.get(userId) ?? []; }
  async runs(userId: string, p: string) { return this.runList.filter(r => r.userId === userId && r.period === p); }
  async createRun(input: z.infer<typeof CreateRun>) {
    this.writes.push("createRun");
    const existing = this.runList.find(r => r.userId === input.userId && r.runKey === input.runKey);
    const run = existing ?? { id: input.id, userId: input.userId, runKey: input.runKey, period: input.period, status: "draft" as const, expectedItems: input.expectedItems,
      items: 0, messages: {}, input, itemList: [], outbox: new Map(), sent: new Map() };
    if (!existing) this.runList.push(run);
    return { ...run, payloadHash: input.payloadHash, kind: input.kind, profileVersion: input.profileVersion };
  }
  async putItems(userId: string, runId: string, _chunk: number, items: Item[]) {
    this.writes.push("putItems");
    const run = this.find(userId, runId);
    run.itemList.push(...items);
    run.items = run.itemList.length;
  }
  async prepare(userId: string, runId: string, body: z.infer<typeof PrepareRun>) {
    this.writes.push("prepare");
    const run = this.find(userId, runId);
    if (run.itemList.length !== run.expectedItems) throw new BackendError(409, "conflict");
    for (const d of body.destinations) run.outbox.set(d.destinationId, d.messages);
    run.status = "prepared";
    return run;
  }
  async deliver(userId: string, runId: string, destinationId: string): Promise<DeliveryOutcome> {
    this.writes.push("deliver");
    const scripted = this.script.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted) return scripted;
    const run = this.find(userId, runId);
    if (run.status === "succeeded") return { state: "done" };
    const messages = run.outbox.get(destinationId);
    if (!messages) throw new BackendError(404, "not_found");
    const next = run.sent.get(destinationId) ?? 0;
    if (next < messages.length) {
      const m = messages[next]!;
      this.delivered.push({ userId, destinationId, text: m.text, pmid: m.pmid, votable: m.votable });
      run.sent.set(destinationId, next + 1);
      run.status = "delivering";
    }
    const complete = [...run.outbox].every(([d, ms]) => (run.sent.get(d) ?? 0) >= ms.length);
    if (complete) {
      run.status = "succeeded";
      this.history.set(runId, run.itemList);
      for (const i of run.itemList) this.seenSet.add(`${userId}:${i.article.pmid}`);
      return { state: "done" };
    }
    return next < messages.length ? { state: "sent" } : { state: "destination_done" };
  }
  async abort(userId: string, runId: string) {
    this.writes.push("abort");
    const run = this.find(userId, runId);
    run.status = "aborted";
    return run;
  }
  async opsAlert(text: string) { this.writes.push("opsAlert"); this.alerts.push(text); return { sent: 1, failed: 0 }; }
  private find(userId: string, runId: string): FakeRun {
    const run = this.runList.find(r => r.userId === userId && r.id === runId);
    if (!run) throw new BackendError(404, "not_found");
    return run;
  }
}

let counter = 0;
function user(slug: string, sources: { kind: "journal" | "query"; value: string }[], options: { ops?: boolean; status?: "active" | "paused"; description?: string; destinations?: number } = {}): BackendUser {
  const userId = `${String(++counter).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const destinationIds = Array.from({ length: options.destinations ?? 1 }, (_, i) => `${String(counter).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaa${String(i).padStart(2, "0")}`);
  return {
    userId, slug, timezone: "UTC", status: options.status ?? "active",
    profile: { userId, version: 1, createdAt: "2026-09-01T00:00:00.000Z", sources,
      profile: { description: options.description ?? `Perfil de ${slug}`, topics: [], must_have: [], nice_to_have: [], exclude: [], exemplar_papers: [] } },
    destinationIds, opsDestinationIds: options.ops === false ? [] : destinationIds.slice(0, 1),
  };
}

function deps(backend: FakeBackend, pubmed: PaperFetcher, scorers: FakeScorer[] = [], extra: Partial<OrchestratorDeps> = {}) {
  const printed: string[] = [];
  const waits: number[] = [];
  const created: FakeScorer[] = [];
  const d: OrchestratorDeps = {
    cfg: config, pubmed, backend, now: () => now, print: t => printed.push(t),
    wait: async ms => { waits.push(ms); },
    scorerFor: () => { const s = scorers.shift() ?? new FakeScorer(); created.push(s); return s; },
    ...extra,
  };
  return { d, printed, waits, created };
}

/** A run of a given week already frozen with two messages, the first already sent. */
function started(backend: FakeBackend, owner: BackendUser, status: RunProgress["status"], week = period) {
  const messages = [{ kind: "header" as const, text: "h", pmid: null, votable: false }, { kind: "footer" as const, text: "f", pmid: null, votable: false }];
  const id = crypto.randomUUID();
  backend.runList.push({ id, userId: owner.userId, runKey: `weekly:${week}:${backend.runList.length + 1}`, period: week, status, expectedItems: 0, items: 0, messages: {},
    input: {} as z.infer<typeof CreateRun>, itemList: [], outbox: new Map([[owner.destinationIds[0]!, messages]]), sent: new Map([[owner.destinationIds[0]!, 1]]) });
  return id;
}

describe("parity with the legacy digest for one user", () => {
  it("renders the same messages, uses the same exemplars and records the same history", async () => {
    const journals = ["AJNR", "Radiology"], queries = ["glioma MRI"];
    const ids = {
      [journalTerm("AJNR")]: ["1", "2", "3", "9"], [journalTerm("Radiology")]: ["3", "4", "5"], [topicTerm("glioma MRI")]: ["6", "7", "8"],
    };
    const overrides = { "4": { publicationTypes: ["Editorial"] }, "7": { doi: "10.1/x" }, "8": { doi: "10.1/x" } };
    // Legacy: ledger with one seen paper and titled vote targets.
    const store = new MemoryStore();
    store.record([{ pmid: "9", title: "Visto", firstSeen: "2026-09-01T00:00:00.000Z", delivered: false },
      { pmid: "50", title: "Me gustó", firstSeen: "2026-09-01T00:00:00.000Z", relevance: 9, delivered: true },
      { pmid: "51", title: "No me gustó", firstSeen: "2026-09-01T00:00:00.000Z", relevance: 8, delivered: true }]);
    const legacyVotes = [{ pmid: "50", value: 1 as const, chatId: "1", votedAt: "2026-09-20T10:00:00.000Z" }, { pmid: "51", value: 0 as const, chatId: "1", votedAt: "2026-09-20T11:00:00.000Z" }];
    const sent: OutMessage[][] = [];
    const legacyScorer = new FakeScorer();
    await runDigestPipeline({ cfg: config, profile: makeProfile({ sources: { journals, queries } }), pubmed: new FakeFetcher(ids, undefined, overrides),
      scorer: legacyScorer, deliverer: { send: async m => { sent.push(m); } }, metrics: new RunMetrics(), votes: legacyVotes }, { title, dryRun: false, store });

    // D1: the same profile, seen state and votes behind the backend.
    const backend = new FakeBackend();
    const owner = user("owner", [...journals.map(value => ({ kind: "journal" as const, value })), ...queries.map(value => ({ kind: "query" as const, value }))], { description: "Perfil de prueba." });
    backend.users = [owner];
    for (const pmid of ["9", "50", "51"]) backend.seenSet.add(`${owner.userId}:${pmid}`);
    backend.votes.set(owner.userId, [{ pmid: "51", title: "No me gustó", value: 0, score: 8, votedAt: "2026-09-20T11:00:00.000Z" },
      { pmid: "50", title: "Me gustó", value: 1, score: 9, votedAt: "2026-09-20T10:00:00.000Z" }]);
    const d1Scorer = new FakeScorer();
    const { d } = deps(backend, new FakeFetcher(ids, undefined, overrides), [d1Scorer]);
    const summary = await runMultiuserDigest(d, { title, dryRun: false });

    expect(summary.outcomes.map(o => o.state)).toEqual(["delivered"]);
    const legacyMessages = sent[0]!.map(m => ({ text: m.text, keyboard: m.keyboard }));
    const d1Messages = backend.delivered.map(m => ({ text: m.text, keyboard: m.votable && m.pmid ? voteKeyboard(m.pmid) : undefined }));
    expect(d1Messages).toEqual(legacyMessages);
    expect(d1Scorer.contexts.map(c => c.exemplars)).toEqual(legacyScorer.contexts.map(c => c.exemplars));
    expect(d1Scorer.contexts[0]!.exemplars).toEqual({ liked: ["Me gustó"], disliked: ["No me gustó"] });
    const legacyRecords = store.entries().filter(e => !["9", "50", "51"].includes(e.pmid))
      .map(e => ({ pmid: e.pmid, title: e.title, relevance: e.relevance ?? null, delivered: e.delivered })).sort((a, b) => a.pmid.localeCompare(b.pmid));
    const d1Records = backend.runList[0]!.itemList.map(i => ({ pmid: i.article.pmid, title: i.article.title, relevance: i.relevance, delivered: i.disposition === "selected" }))
      .sort((a, b) => a.pmid.localeCompare(b.pmid));
    expect(d1Records).toEqual(legacyRecords);
    expect(backend.runList[0]).toMatchObject({ runKey: `weekly:${period}:1`, period, status: "succeeded" });
  });

  it("builds the scorer profile from the D1 profile version, including its threshold", () => {
    const u = user("x", [{ kind: "journal", value: "AJNR" }, { kind: "query", value: "MRI" }]);
    u.profile.profile.threshold = 6;
    expect(legacyProfile(u)).toEqual({ ...makeProfile({ description: "Perfil de x", sources: { journals: ["AJNR"], queries: ["MRI"] } }), threshold: 6 });
  });
});

describe("multi-user execution", () => {
  it("searches each source once, fetches shared PMIDs once and keeps seen state per user", async () => {
    const backend = new FakeBackend();
    const alice = user("alice", [{ kind: "journal", value: "AJNR" }]);
    const bob = user("bob", [{ kind: "journal", value: "AJNR" }, { kind: "journal", value: "Radiology" }]);
    backend.users = [bob, alice];
    backend.seenSet.add(`${alice.userId}:1`);
    const pubmed = new FakeFetcher({ [journalTerm("AJNR")]: ["1", "2"], [journalTerm("Radiology")]: ["3"] });
    const { d, created } = deps(backend, pubmed);
    const summary = await runMultiuserDigest(d, { title, dryRun: false });
    expect(summary.outcomes.map(o => [o.slug, o.state])).toEqual([["alice", "delivered"], ["bob", "delivered"]]);
    expect(pubmed.searches).toEqual([journalTerm("AJNR"), journalTerm("Radiology")]);
    expect(pubmed.fetched.sort()).toEqual(["1", "2", "3"]);
    expect(backend.runList.map(r => r.itemList.map(i => i.article.pmid))).toEqual([["2"], ["1", "2", "3"]]);
    expect(created.map(s => s.contexts[0]!.profile.description)).toEqual(["Perfil de alice", "Perfil de bob"]);
    expect(backend.delivered.filter(m => m.userId === alice.userId && m.votable).map(m => m.pmid)).toEqual(["2"]);
  });

  it("splits the global budget fairly across users", async () => {
    const backend = new FakeBackend();
    const alice = user("alice", [{ kind: "journal", value: "A" }]);
    const bob = user("bob", [{ kind: "journal", value: "B" }]);
    backend.users = [alice, bob];
    const pubmed = new FakeFetcher({ [journalTerm("A")]: ["1", "2", "3", "4"], [journalTerm("B")]: ["5"] });
    const { d } = deps(backend, pubmed);
    await runMultiuserDigest(d, { title, dryRun: false, limit: 3 });
    expect(backend.runList.map(r => r.itemList.map(i => i.article.pmid))).toEqual([["1", "2"], ["5"]]);
  });

  it("isolates one user's failure, alerts operators with run states only and ends in need of attention", async () => {
    const backend = new FakeBackend();
    const alice = user("alice", [{ kind: "journal", value: "A" }]);
    const bob = user("bob", [{ kind: "journal", value: "B" }]);
    const carol = user("carol", [{ kind: "journal", value: "C" }]);
    backend.users = [alice, bob, carol];
    const pubmed = new FakeFetcher({ [journalTerm("A")]: ["1"], [journalTerm("B")]: ["2"], [journalTerm("C")]: ["3"] }, new Set([journalTerm("C")]));
    const { d } = deps(backend, pubmed, [new FakeScorer(), new FakeScorer(true)]);
    const summary = await runMultiuserDigest(d, { title, dryRun: false });
    expect(summary.outcomes.map(o => [o.slug, o.state, o.error])).toEqual([
      ["carol", "failed", "Every source of this profile failed"], ["bob", "failed", "scoring failed"], ["alice", "delivered", undefined],
    ]);
    expect(backend.alerts).toHaveLength(1);
    expect(backend.alerts[0]).toContain("2 ejecución(es)");
    for (const u of [alice, bob, carol]) expect(backend.alerts[0]).not.toContain(u.slug);
    expect(backend.runList.map(r => r.userId)).toEqual([alice.userId]);
  });

  it("refuses to report an empty week when every source failed, yet still delivers started runs", async () => {
    const backend = new FakeBackend();
    const alice = user("alice", [{ kind: "journal", value: "A" }]);
    const bob = user("bob", [{ kind: "journal", value: "A" }]);
    backend.users = [alice, bob];
    const bobRun = started(backend, bob, "delivering");
    const { d } = deps(backend, new FakeFetcher({}, new Set([journalTerm("A")])));
    const summary = await runMultiuserDigest(d, { title, dryRun: false });
    expect(summary.outcomes.map(o => [o.slug, o.state, o.runId])).toEqual([["alice", "failed", undefined], ["bob", "delivered", bobRun]]);
    expect(summary.outcomes[0]!.error).toContain("Every source failed");
    expect(backend.writes.filter(w => w !== "deliver")).toEqual(["opsAlert"]);
  });

  it("still delivers an explicit empty digest when nothing is new", async () => {
    const backend = new FakeBackend();
    const alice = user("alice", [{ kind: "journal", value: "A" }]);
    backend.users = [alice];
    backend.seenSet.add(`${alice.userId}:1`);
    const { d, created } = deps(backend, new FakeFetcher({ [journalTerm("A")]: ["1"] }));
    expect((await runMultiuserDigest(d, { title, dryRun: false })).outcomes[0]!.state).toBe("delivered");
    expect(backend.delivered.map(m => m.text)).toEqual([expect.stringContaining("No hay artículos que superen el umbral")]);
    expect(backend.runList[0]!.expectedItems).toBe(0);
    expect(created[0]!.contexts).toEqual([]);
  });

  it("puts the cost receipt only on operations destinations", async () => {
    const backend = new FakeBackend();
    const alice = user("alice", [{ kind: "journal", value: "A" }], { destinations: 2 });
    backend.users = [alice];
    const { d } = deps(backend, new FakeFetcher({ [journalTerm("A")]: ["1"] }));
    await runMultiuserDigest(d, { title, dryRun: false });
    const [ops, reader] = alice.destinationIds;
    const texts = (id: string) => backend.delivered.filter(m => m.destinationId === id).map(m => m.text);
    expect(texts(ops!).at(-1)).toContain("puntuados");
    expect(texts(reader!).some(t => t.includes("puntuados"))).toBe(false);
    expect(texts(reader!)).toEqual(texts(ops!).slice(0, -1));
  });
});

describe("resuming and refusing", () => {

  it("continues a started run without scoring again, and never repeats a delivered week", async () => {
    const backend = new FakeBackend();
    const owner = user("owner", [{ kind: "journal", value: "A" }]);
    backend.users = [owner];
    const runId = started(backend, owner, "delivering");
    const pubmed = new FakeFetcher({ [journalTerm("A")]: ["1"] });
    const { d, created } = deps(backend, pubmed);
    expect((await runMultiuserDigest(d, { title, dryRun: false })).outcomes).toMatchObject([{ state: "delivered", runId }]);
    expect(backend.delivered.map(m => m.text)).toEqual(["f"]);
    expect(pubmed.searches).toEqual([]);
    expect(created).toEqual([]);
    const again = await runMultiuserDigest(d, { title, dryRun: false });
    expect(again.outcomes).toMatchObject([{ state: "already_delivered", runId }]);
    expect(backend.delivered).toHaveLength(1);
  });

  it("aborts a draft left by a crash and starts the next attempt", async () => {
    const backend = new FakeBackend();
    const owner = user("owner", [{ kind: "journal", value: "A" }]);
    backend.users = [owner];
    const draftId = started(backend, owner, "draft");
    const { d } = deps(backend, new FakeFetcher({ [journalTerm("A")]: ["1"] }));
    await runMultiuserDigest(d, { title, dryRun: false });
    expect(backend.runList.map(r => [r.id === draftId ? "draft" : "new", r.status, r.runKey])).toEqual([
      ["draft", "aborted", `weekly:${period}:1`], ["new", "succeeded", `weekly:${period}:2`],
    ]);
  });

  it("reports a blocked run for reconciliation and alerts operators", async () => {
    const backend = new FakeBackend();
    const owner = user("owner", [{ kind: "journal", value: "A" }]);
    backend.users = [owner];
    const runId = started(backend, owner, "needs_reconciliation");
    backend.script = [{ state: "blocked", messageId: "m-1" }];
    const { d } = deps(backend, new FakeFetcher({}));
    expect((await runMultiuserDigest(d, { title, dryRun: false })).outcomes).toMatchObject([{ state: "blocked", runId, messageId: "m-1" }]);
    expect(backend.alerts[0]).toContain(runId);
  });

  it("honors flood control and pauses a run that keeps being throttled", async () => {
    const backend = new FakeBackend();
    const owner = user("owner", [{ kind: "journal", value: "A" }]);
    backend.users = [owner];
    started(backend, owner, "delivering");
    backend.script = [{ state: "retry", retryAfter: 3 }];
    const first = deps(backend, new FakeFetcher({}));
    expect((await runMultiuserDigest(first.d, { title, dryRun: false })).outcomes[0]!.state).toBe("delivered");
    expect(first.waits).toContain(3000);

    const throttled = new FakeBackend();
    const other = user("other", [{ kind: "journal", value: "A" }]);
    throttled.users = [other];
    started(throttled, other, "delivering");
    throttled.script = Array(10).fill({ state: "retry", retryAfter: 120 });
    const second = deps(throttled, new FakeFetcher({}));
    expect((await runMultiuserDigest(second.d, { title, dryRun: false })).outcomes[0]!.state).toBe("paused");
    expect(Math.max(...second.waits)).toBe(60_000);
  });

  it("stops at the first sign of a mode change and still reports what was done", async () => {
    const backend = new FakeBackend();
    const owner = user("owner", [{ kind: "journal", value: "A" }]);
    const other = user("other", [{ kind: "journal", value: "A" }]);
    backend.users = [owner, other];
    const ownerRun = started(backend, owner, "delivering");
    const otherRun = started(backend, other, "delivering");
    backend.script = [new BackendError(409, "mode_unavailable")];
    const { d } = deps(backend, new FakeFetcher({}));
    const summary = await runMultiuserDigest(d, { title, dryRun: false });
    expect(summary.halted).toBe("mode_unavailable");
    expect(summary.outcomes.map(o => [o.runId, o.state])).toEqual([[otherRun, "failed"], [ownerRun, "failed"]]);
    expect(backend.writes).toEqual(["deliver"]);
  });

  it("releases abandoned runs of earlier weeks and resumes started ones before this week's run", async () => {
    const backend = new FakeBackend();
    const owner = user("owner", [{ kind: "journal", value: "A" }]);
    backend.users = [owner];
    const lastWeek = "2026-W38", older = "2026-W36";
    const draft = started(backend, owner, "draft", lastWeek);
    const prepared = started(backend, owner, "prepared", older);
    const partial = started(backend, owner, "delivering", lastWeek);
    const { d } = deps(backend, new FakeFetcher({ [journalTerm("A")]: ["1"] }));
    const summary = await runMultiuserDigest(d, { title, dryRun: false });
    expect(backend.runList.find(r => r.id === draft)!.status).toBe("aborted");
    expect(backend.runList.find(r => r.id === prepared)!.status).toBe("aborted");
    expect(summary.outcomes.map(o => [o.runId === partial ? "partial" : "this week", o.state])).toEqual([["partial", "delivered"], ["this week", "delivered"]]);
    expect(backend.runList.filter(r => r.period === period).map(r => r.status)).toEqual(["succeeded"]);
  });

  it.each([["legacy", "use --dry-run"], ["maintenance", "maintenance"]] as const)("refuses a real run in %s mode", async (mode, message) => {
    const backend = new FakeBackend();
    backend.modeValue = mode;
    backend.users = [user("owner", [{ kind: "journal", value: "A" }])];
    const { d } = deps(backend, new FakeFetcher({}));
    await expect(runMultiuserDigest(d, { title, dryRun: false })).rejects.toThrow(message);
    expect(backend.writes).toEqual([]);
  });

  it("previews a paused user in legacy mode by slug without any write", async () => {
    const backend = new FakeBackend();
    backend.modeValue = "legacy";
    const owner = user("owner", [{ kind: "journal", value: "A" }], { status: "paused" });
    backend.users = [owner];
    const { d, printed } = deps(backend, new FakeFetcher({ [journalTerm("A")]: ["1", "2"] }));
    await expect(runMultiuserDigest(d, { title, dryRun: false })).rejects.toThrow();
    const summary = await runMultiuserDigest(d, { title, dryRun: true, user: "owner", limit: 1 });
    expect(summary.outcomes).toMatchObject([{ state: "previewed" }]);
    expect(printed[0]).toContain("Título 1");
    expect(printed[0]).not.toContain("Título 2");
    expect(backend.writes).toEqual([]);
    await expect(runMultiuserDigest(d, { title, dryRun: true })).rejects.toThrow("No active users");
  });
});

describe("refusals before any cost", () => {
  it("never scores a paused user, one with too many destinations, or an empty --user", async () => {
    const backend = new FakeBackend();
    const paused = user("paused", [{ kind: "journal", value: "A" }], { status: "paused" });
    const crowded = user("crowded", [{ kind: "journal", value: "A" }], { destinations: 3 });
    backend.users = [paused, crowded];
    const pubmed = new FakeFetcher({ [journalTerm("A")]: ["1"] });
    const { d, created } = deps(backend, pubmed);
    expect((await runMultiuserDigest(d, { title, dryRun: false, user: "paused" })).outcomes).toMatchObject([{ state: "failed", error: "User is paused" }]);
    expect((await runMultiuserDigest(d, { title, dryRun: false, user: "crowded" })).outcomes).toMatchObject([{ state: "failed", error: "More than 2 digest destinations" }]);
    await expect(runMultiuserDigest(d, { title, dryRun: false, user: "" })).rejects.toThrow("slug");
    expect(pubmed.searches).toEqual([]);
    expect(created).toEqual([]);
    expect(backend.runList).toEqual([]);
  });

  it("fails a user with no budget share instead of sealing a false empty week", async () => {
    const backend = new FakeBackend();
    const alice = user("alice", [{ kind: "journal", value: "A" }]);
    const bob = user("bob", [{ kind: "journal", value: "B" }]);
    backend.users = [alice, bob];
    const { d } = deps(backend, new FakeFetcher({ [journalTerm("A")]: ["1"], [journalTerm("B")]: ["2"] }));
    const summary = await runMultiuserDigest(d, { title, dryRun: false, limit: 1 });
    expect(summary.outcomes.map(o => [o.slug, o.state])).toEqual([["bob", "failed"], ["alice", "delivered"]]);
    expect(summary.outcomes[0]!.error).toContain("No scoring budget");
    expect(backend.runList.map(r => r.userId)).toEqual([alice.userId]);
  });

  it("names the draft in the failure when a run fails after it was created", async () => {
    const backend = new FakeBackend();
    backend.users = [user("alice", [{ kind: "journal", value: "A" }])];
    backend.prepare = async () => { throw new BackendError(409, "conflict"); };
    const { d } = deps(backend, new FakeFetcher({ [journalTerm("A")]: ["1"] }));
    const [failed] = (await runMultiuserDigest(d, { title, dryRun: false })).outcomes;
    expect(failed).toMatchObject({ state: "failed", runId: backend.runList[0]!.id });
    expect(backend.alerts[0]).toContain(backend.runList[0]!.id);
  });

  it("refuses a configuration whose ledger semantics the D1 path does not implement", async () => {
    const backend = new FakeBackend();
    backend.users = [user("alice", [{ kind: "journal", value: "A" }])];
    const { d } = deps(backend, new FakeFetcher({}), [], { cfg: { ...config, markSeenMode: "delivered" } });
    await expect(runMultiuserDigest(d, { title, dryRun: true })).rejects.toThrow("markSeenMode");
  });
});

describe("run payloads", () => {
  it("splits long messages and keeps the keyboard on the last chunk", () => {
    const long = makeScored("7", 9, { title: "t", reason: "x".repeat(300) });
    const selection = { kept: [long], nearMisses: [] };
    const messages = outboundMessages(selection, title, "pie");
    expect(messages.map(m => [m.kind, m.pmid, m.votable])).toEqual([["header", null, false], ["paper", "7", true], ["footer", null, false]]);
    const huge = outboundMessages({ kept: [], nearMisses: [] }, "x".repeat(5000));
    expect(huge.length).toBeGreaterThan(1);
    expect(huge.every(m => m.text.length <= 4096 && m.kind === "empty" && !m.votable)).toBe(true);
  });

  it("classifies every fetched article and bounds what is stored", () => {
    const fetched = ["1", "2", "3", "4"].map(id => makePaper(id, { authors: Array.from({ length: 30 }, (_, i) => ({ lastName: `A${i}` })), abstract: "a".repeat(30_000) }));
    const scored = [makeScored("1", 9), makeScored("2", 6), makeScored("3", 2)];
    const items = digestItems(fetched, scored, { kept: [scored[0]!], nearMisses: [scored[1]!] }, now);
    expect(items.map(i => [i.article.pmid, i.disposition, i.relevance])).toEqual([["1", "selected", 9], ["2", "near_miss", 6], ["3", "below_threshold", 2], ["4", "filtered", null]]);
    expect(items[0]!.article.metadata).toMatchObject({ authorCount: 30, authors: expect.any(Array) });
    expect((items[0]!.article.metadata!.authors as unknown[]).length).toBe(10);
    expect(items[0]!.article.abstract!.length).toBe(20_000);
    expect(items[0]!.article.updatedAt).toBe(now.toISOString());
  });

  it("uploads at most fifteen items and about 200 KiB per chunk", () => {
    const small = digestItems(Array.from({ length: 16 }, (_, i) => makePaper(String(i + 1))), [], { kept: [], nearMisses: [] }, now);
    expect(uploadChunks(small).map(c => c.length)).toEqual([15, 1]);
    const big = digestItems(Array.from({ length: 12 }, (_, i) => makePaper(String(i + 1), { abstract: "a".repeat(19_000) })), [], { kept: [], nearMisses: [] }, now);
    const chunks = uploadChunks(big);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => new TextEncoder().encode(JSON.stringify({ items: c })).byteLength < 256 * 1024)).toBe(true);
    expect(chunks.flat()).toEqual(big);
  });
});
