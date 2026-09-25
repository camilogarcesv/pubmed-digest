// The weekly digest for every active D1 user: shared discovery, per-profile scoring, and delivery
// through the Worker. Scoring, selection and rendering are the legacy pipeline's own functions, so
// for one user this path produces exactly the messages and records the legacy digest does.

import type { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Profile } from "../profile.js";
import type { Paper, ScoredPaper } from "../types.js";
import type { Scorer } from "../scoring.js";
import { journalTerm, topicTerm } from "../pubmed.js";
import { collectFromResults, prefilter, scoreAndRerank, searchSources, type PaperFetcher, type PipelineDeps, type Source } from "../pipeline.js";
import { renderDigestParts, selectForDigest, type Selection } from "../digest.js";
import { INTER_MESSAGE_MS, splitForTelegram, type Deliverer } from "../deliver.js";
import { exemplarsFromVotes } from "../votes.js";
import { RunMetrics } from "../metrics.js";
import { logger } from "../logger.js";
import { chunk, sleep } from "../util.js";
import { checksum } from "./import-contracts.js";
import { allocate, isoWeek } from "./allocation.js";
import { PrepareRun, type DigestItem, type OutboundMessage } from "./contracts.js";
import { BackendError, type BackendUser, type DigestBackend } from "../backend/client.js";

type Item = z.infer<typeof DigestItem>;
type Outbound = z.infer<typeof OutboundMessage>;

export interface OrchestratorDeps {
  cfg: AppConfig;
  pubmed: PaperFetcher;
  backend: DigestBackend;
  /** A fresh scorer per user, so usage and cost are attributed to that user's run. */
  scorerFor: () => Scorer;
  wait?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Receives each previewed digest in --dry-run (stdout in the CLI). */
  print?: (text: string) => void;
}

export interface OrchestratorOptions {
  title: string;
  dryRun: boolean;
  /** Global cap on user-PMID pairs scored in this run (never above cfg.maxAbstractsPerRun). */
  limit?: number;
  /** Only this user, by slug, whatever its status (dry runs and canaries read paused users). */
  user?: string;
}

export type UserState = "delivered" | "already_delivered" | "previewed" | "blocked" | "paused" | "failed";
export interface UserOutcome {
  slug: string;
  userId: string;
  state: UserState;
  runId?: string;
  /** A message awaiting reconciliation when the state is blocked. */
  messageId?: string;
  error?: string;
  metrics?: RunMetrics;
}
export interface DigestSummary {
  period: string;
  outcomes: UserOutcome[];
  /** Set when the operating mode changed mid-run: everything after that point was left untouched. */
  halted?: "mode_unavailable";
}

/** An outcome that needs the operator: the job ends non-zero and operators are alerted. */
export const needsAttention = (o: UserOutcome) => o.state === "failed" || o.state === "blocked" || o.state === "paused";

/** Longest single wait honored for Telegram flood control, and the total before a run is paused. */
const MAX_RETRY_WAIT_MS = 60_000;
const MAX_TOTAL_WAIT_MS = 300_000;
const MAX_BUSY = 5;
/** Items per upload, bounded again by size so a chunk stays well below the Worker's 256 KiB body. */
const ITEMS_PER_CHUNK = 15;
const CHUNK_BYTES = 200 * 1024;
const MAX_AUTHORS = 10;
/** The Worker's per-transaction message budget (worker/multiuser/runs.ts MAX_PREPARED_MESSAGES). */
const MAX_PREPARED_MESSAGES = 36;
const MAX_ABSTRACT = 20_000;

/** Earlier weeks checked for runs left open, so none keeps its articles reserved unnoticed. */
const LOOKBACK_WEEKS = 8;
/** One prepare transaction fits this many destinations (see PrepareRun). */
const MAX_DESTINATIONS = 2;

const NO_DELIVERY: Deliverer = { send: async () => { throw new Error("The D1 path delivers through the Worker"); } };
const halts = (error: unknown) => error instanceof BackendError && error.code === "mode_unavailable";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

interface Fresh { user: BackendUser; attempt: number; metrics: RunMetrics; sources: Source[]; unseen: string[]; pmidToSource: Map<string, string>; runId?: string }
interface Pending { user: BackendUser; runId: string; metrics?: RunMetrics }

/** The profile shape the legacy scorer expects, from the user's active D1 profile version. */
export function legacyProfile(user: BackendUser): Profile {
  const p = user.profile.profile;
  return {
    description: p.description, topics: p.topics, must_have: p.must_have, nice_to_have: p.nice_to_have,
    exclude: p.exclude, exemplar_papers: p.exemplar_papers,
    sources: {
      journals: user.profile.sources.filter(s => s.kind === "journal").map(s => s.value),
      queries: user.profile.sources.filter(s => s.kind === "query").map(s => s.value),
    },
    ...(p.threshold === undefined ? {} : { threshold: p.threshold }),
  };
}

/** A D1 profile keeps one total source order; legacy profiles list journals, then queries. */
function sourcesOf(user: BackendUser): Source[] {
  return user.profile.sources.map(s => ({ label: s.value, term: s.kind === "journal" ? journalTerm(s.value) : topicTerm(s.value) }));
}

export async function runMultiuserDigest(deps: OrchestratorDeps, opts: OrchestratorOptions): Promise<DigestSummary> {
  if (deps.cfg.markSeenMode !== "considered") throw new Error("The D1 path records every considered article; markSeenMode must be \"considered\".");
  if (opts.user !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(opts.user)) throw new Error("--user needs a user slug.");
  const now = deps.now?.() ?? new Date();
  const wait = deps.wait ?? sleep;
  const mode = await deps.backend.mode();
  if (mode === "maintenance") throw new Error("The system is in maintenance: nothing was scored or sent.");
  if (mode === "legacy" && !opts.dryRun) throw new Error("D1 is not the operating mode yet: use --dry-run for a preview.");
  const users = (opts.user !== undefined ? [await deps.backend.context(opts.user)] : await deps.backend.contexts())
    .sort((a, b) => a.slug.localeCompare(b.slug));
  if (users.length === 0) throw new Error("No active users: refusing to report an empty run as success.");
  const period = isoWeek(now);
  const outcomes: UserOutcome[] = [];
  let halted = false;
  const outcome = (user: BackendUser, state: UserState, extra: Partial<UserOutcome> = {}): void => {
    outcomes.push({ slug: user.slug, userId: user.userId, state, ...extra });
  };
  const stopped = { error: "Stopped: the operating mode changed during the run" };

  // 1. What each user needs: nothing, the rest of a started run, or a fresh run for this week.
  const fresh: Fresh[] = [];
  const pending: Pending[] = [];
  for (const user of users) {
    const base = { user, metrics: new RunMetrics(), sources: sourcesOf(user), unseen: [], pmidToSource: new Map<string, string>() };
    if (opts.dryRun) { fresh.push({ ...base, attempt: 0 }); continue; }
    if (halted) { outcome(user, "failed", stopped); continue; }
    try {
      // Refused before any scoring: these would only be rejected by the Worker after paying for it.
      if (user.status === "paused") { outcome(user, "failed", { error: "User is paused" }); continue; }
      if (user.destinationIds.length === 0) { outcome(user, "failed", { error: "No active digest destination" }); continue; }
      if (user.destinationIds.length > MAX_DESTINATIONS) { outcome(user, "failed", { error: `More than ${MAX_DESTINATIONS} digest destinations` }); continue; }
      const plan = await planUser(deps.backend, user, period, now);
      pending.push(...plan.resume);
      if (plan.delivered) outcome(user, "already_delivered", { runId: plan.delivered });
      else if (plan.fresh) fresh.push({ ...base, attempt: plan.attempt });
    } catch (error) {
      if (halts(error)) { halted = true; outcome(user, "failed", stopped); continue; }
      outcome(user, "failed", { error: message(error) });
    }
  }

  // 2. Shared discovery. A shared failure (PubMed down) fails the fresh runs, never started ones.
  let scoring: Scoring[] = [];
  if (fresh.length && !halted) {
    try {
      scoring = await discover(deps, fresh, opts, outcome);
    } catch (error) {
      if (halts(error)) halted = true;
      for (const f of fresh) outcome(f.user, "failed", halted ? stopped : { error: message(error), metrics: f.metrics });
    }
  }

  // 3. Per user: prefilter, score against the user's own profile, select, then freeze the run.
  for (const f of scoring) {
    if (halted) { outcome(f.user, "failed", { ...stopped, metrics: f.metrics }); continue; }
    try {
      const prepared = await scoreUser(deps, f, opts, period, now);
      if (prepared) pending.push(prepared);
      else outcome(f.user, "previewed", { metrics: f.metrics });
    } catch (error) {
      if (halts(error)) halted = true;
      else logger.error("user digest failed", { runId: f.runId, error: message(error) });
      outcome(f.user, "failed", { ...(halted ? stopped : { error: message(error) }), metrics: f.metrics, ...(f.runId ? { runId: f.runId } : {}) });
    }
  }

  // 4. Delivery, one run and one destination at a time, strictly in message order.
  for (const p of pending) {
    const extra = p.metrics ? { metrics: p.metrics } : {};
    if (halted) { outcome(p.user, "failed", { ...stopped, runId: p.runId, ...extra }); continue; }
    try {
      outcomes.push({ slug: p.user.slug, userId: p.user.userId, ...(await deliverRun(deps.backend, p, wait)), ...extra });
    } catch (error) {
      if (halts(error)) halted = true;
      outcome(p.user, "failed", { ...(halted ? stopped : { error: message(error) }), runId: p.runId, ...extra });
    }
  }

  // Alerts go through the Worker, which refuses them outside D1 mode; the job still ends non-zero.
  if (!opts.dryRun && !halted) await alertOperators(deps.backend, period, outcomes);
  return { period, outcomes, ...(halted ? { halted: "mode_unavailable" as const } : {}) };
}

/**
 * Open runs of this week and of recent weeks. A draft, or an earlier week's run still only prepared
 * (nothing attempted), is aborted so its articles are no longer reserved; a run whose delivery
 * started is resumed, whatever week it belongs to. This week gets a fresh run unless it has one.
 */
async function planUser(backend: DigestBackend, user: BackendUser, period: string, now: Date) {
  const weeks = [...new Set(Array.from({ length: LOOKBACK_WEEKS + 1 }, (_, k) => isoWeek(new Date(now.getTime() - 7 * k * 86_400_000))))];
  const resume: Pending[] = [];
  let attempt = 1, delivered: string | undefined, startedThisWeek = false;
  for (const week of weeks) {
    const current = week === period;
    const runs = await backend.runs(user.userId, week);
    if (current) {
      attempt = runs.length + 1;
      delivered = runs.find(r => r.status === "succeeded")?.id;
    }
    for (const r of runs) {
      if (r.status === "draft" || (r.status === "prepared" && !current)) {
        await backend.abort(user.userId, r.id);
        logger.info("released an abandoned run", { runId: r.id, status: r.status });
      } else if (r.status === "prepared" || r.status === "delivering" || r.status === "needs_reconciliation") {
        resume.push({ user, runId: r.id });
        if (current) startedThisWeek = true;
      }
    }
  }
  return { resume, attempt, delivered, fresh: !delivered && !startedThisWeek };
}

type Scoring = Fresh & { allocated: string[]; papers: Map<string, Paper> };

async function discover(deps: OrchestratorDeps, fresh: Fresh[], opts: OrchestratorOptions,
  outcome: (user: BackendUser, state: UserState, extra?: Partial<UserOutcome>) => void): Promise<Scoring[]> {
  const { cfg } = deps;
  const results = await searchSources(deps, fresh.flatMap(f => f.sources.map(s => s.term)));
  if (results.size && [...results.values()].every(r => r instanceof Error)) {
    throw new Error(`Every source failed (${results.size}/${results.size}). PubMed may be down or the ` +
      "query/credentials may be wrong — refusing to report an empty digest as success.");
  }

  const searched: Fresh[] = [];
  for (const f of fresh) {
    if (f.sources.length === 0) { outcome(f.user, "failed", { error: "The profile defines no sources", metrics: f.metrics }); continue; }
    // Journals and queries are the user's private preferences: logs name them by position only.
    f.pmidToSource = collectFromResults(f.metrics, f.sources, results, () => false, { privateSources: true });
    if (f.metrics.sourcesFailed === f.sources.length) { outcome(f.user, "failed", { error: "Every source of this profile failed", metrics: f.metrics }); continue; }
    searched.push(f);
  }

  // Seen is per user: an article one user already has is still new to the others.
  const pairs = searched.flatMap(f => [...f.pmidToSource.keys()].map(pmid => ({ userId: f.user.userId, pmid })));
  const seen = pairs.length ? await deps.backend.seen(pairs) : [];
  let at = 0;
  for (const f of searched) {
    f.unseen = [...f.pmidToSource.keys()].filter(() => !seen[at++]);
    f.metrics.newAfterDedupe = f.unseen.length;
  }
  const cap = Math.min(opts.limit ?? cfg.maxAbstractsPerRun, cfg.maxAbstractsPerRun);
  const allocation = allocate(new Map(searched.map(f => [f.user.userId, f.unseen])), cap);

  // PubMed metadata is global: a PMID wanted by several users is fetched once.
  const union = [...new Set(searched.flatMap(f => allocation.get(f.user.userId) ?? []))];
  const papers = new Map<string, Paper>();
  for (const batch of chunk(union, cfg.efetchIdBatchSize)) {
    for (const p of await deps.pubmed.efetch(batch)) papers.set(p.pmid, p);
  }
  return searched.map(f => {
    const allocated = allocation.get(f.user.userId) ?? [];
    if (allocated.length < f.unseen.length) logger.warn("capping papers scored", { from: f.unseen.length, to: allocated.length });
    return Object.assign(f, { allocated, papers });
  });
}

/** Score one user's allocation; in --dry-run print it, otherwise create, upload and prepare the run. */
async function scoreUser(deps: OrchestratorDeps, f: Scoring, opts: OrchestratorOptions, period: string, now: Date): Promise<Pending | null> {
  const m = f.metrics;
  // New articles but no share of the budget: an empty digest would falsely seal the week.
  if (f.unseen.length > 0 && f.allocated.length === 0) throw new Error("No scoring budget left for this user in this run");
  const profile = legacyProfile(f.user);
  const cfg = { ...deps.cfg, threshold: profile.threshold ?? deps.cfg.threshold };
  const fetched = f.allocated.flatMap(pmid => {
    const p = f.papers.get(pmid);
    return p ? [{ ...p, source: f.pmidToSource.get(pmid) ?? "" }] : [];
  });
  m.fetched = fetched.length;
  const shim: PipelineDeps = { cfg, profile, pubmed: deps.pubmed, scorer: deps.scorerFor(), deliverer: NO_DELIVERY, metrics: m };

  let scored: ScoredPaper[] = [];
  if (f.allocated.length > 0) {
    // Recent votes become few-shot exemplars. Enrichment only: without them scoring runs as before.
    let exemplars: { liked: string[]; disliked: string[] } | undefined;
    try {
      const votes = await deps.backend.evalContext(f.user.userId);
      const titles = new Map(votes.map(v => [v.pmid, v.title]));
      exemplars = votes.length ? exemplarsFromVotes(votes, pmid => titles.get(pmid), cfg.dynamicExemplarsMax) : undefined;
      if (exemplars) logger.info("dynamic exemplars from votes", { liked: exemplars.liked.length, disliked: exemplars.disliked.length });
    } catch (error) {
      if (error instanceof BackendError && error.code === "mode_unavailable") throw error;
      logger.warn("could not read votes, continuing without", { error: String(error) });
    }
    scored = await scoreAndRerank(shim, prefilter(shim, fetched), undefined, exemplars);
  }
  const selection = selectForDigest(scored, { threshold: cfg.threshold, max: cfg.maxDelivered, min: cfg.minDelivered });
  m.delivered = selection.kept.length;
  m.nearMisses = selection.nearMisses.length;
  logger.info("selected", { scored: scored.length, kept: selection.kept.length, nearMisses: selection.nearMisses.length, threshold: cfg.threshold });
  const footer = m.telegramFooter(cfg.pricing);

  if (opts.dryRun) {
    const text = outboundMessages(selection, opts.title, footer).map(x => x.text).join("\n\n");
    deps.print?.(text.endsWith("\n") ? text : text + "\n");
    return null;
  }

  const items = digestItems(fetched, scored, selection, now);
  const userId = f.user.userId;
  // The cost receipt is operator information: only destinations that also receive operations see it.
  const ops = new Set(f.user.opsDestinationIds);
  const prepared = PrepareRun.safeParse({
    metrics: JSON.parse(JSON.stringify(m.toFields(cfg.pricing))),
    destinations: [...f.user.destinationIds].sort().map(destinationId => ({
      destinationId, messages: outboundMessages(selection, opts.title, ops.has(destinationId) ? footer : undefined),
    })),
  });
  // Checked before the run exists, so an oversized digest never leaves a draft behind.
  if (!prepared.success || prepared.data.destinations.reduce((n, d) => n + d.messages.length, 0) > MAX_PREPARED_MESSAGES) {
    throw new Error("The digest does not fit in one delivery transaction");
  }
  const run = await deps.backend.createRun({
    id: crypto.randomUUID(), userId, profileVersion: f.user.profile.version, runKey: `weekly:${period}:${f.attempt}`,
    payloadHash: await checksum(items), kind: "weekly", expectedItems: items.length, createdAt: now.toISOString(), period,
  });
  f.runId = run.id;
  if (run.status !== "draft") throw new Error("Run was already created by another attempt");
  for (const [index, part] of uploadChunks(items).entries()) await deps.backend.putItems(userId, run.id, index, part);
  await deps.backend.prepare(userId, run.id, prepared.data);
  logger.info("digest run prepared", { runId: run.id, items: items.length, destinations: prepared.data.destinations.length });
  return { user: f.user, runId: run.id, metrics: m };
}

/** The legacy digest messages, split to Telegram's limit, with the vote keyboard on each paper's last chunk. */
export function outboundMessages(selection: Selection, title: string, footer?: string): Outbound[] {
  return renderDigestParts(selection.kept, { title, footer, withKeyboards: true }, selection.nearMisses).flatMap(part => {
    const chunks = splitForTelegram(part.message.text);
    return chunks.map((text, i) => ({ kind: part.kind, text, pmid: part.pmid, votable: part.pmid !== null && i === chunks.length - 1 }));
  });
}

/**
 * Every fetched article becomes an item, as the legacy ledger records every considered paper.
 * below_threshold means "scored, not delivered": papers above the bar cut by maxDelivered keep their
 * relevance, which is what tells them apart.
 */
export function digestItems(fetched: Paper[], scored: ScoredPaper[], selection: Selection, now: Date): Item[] {
  const scores = new Map(scored.map(p => [p.pmid, p]));
  const kept = new Set(selection.kept.map(p => p.pmid));
  const near = new Set(selection.nearMisses.map(p => p.pmid));
  return fetched.map(p => {
    const s = scores.get(p.pmid);
    const metadata = Object.fromEntries(Object.entries({
      journal: p.journal, pubDate: p.pubDate, doi: p.doi, publicationStatus: p.publicationStatus,
      authors: p.authors.slice(0, MAX_AUTHORS).map(a => ({ ...(a.lastName ? { lastName: a.lastName } : {}), ...(a.foreName ? { foreName: a.foreName } : {}) })),
      authorCount: p.authors.length, publicationTypes: p.publicationTypes, meshTerms: p.meshTerms, keywords: p.keywords,
    }).filter(([, v]) => v !== undefined));
    return {
      article: { pmid: p.pmid, title: p.title, abstract: p.hasAbstract ? p.abstract.slice(0, MAX_ABSTRACT) : null, metadata, updatedAt: now.toISOString() },
      relevance: s ? s.relevance : null,
      reason: s ? s.reason : null,
      source: p.source,
      disposition: kept.has(p.pmid) ? "selected" : near.has(p.pmid) ? "near_miss" : s ? "below_threshold" : "filtered",
    } as Item;
  });
}

/** Upload chunks of at most 15 items and ~200 KiB of JSON each. */
export function uploadChunks(items: Item[]): Item[][] {
  const out: Item[][] = [];
  let current: Item[] = [], bytes = 0;
  for (const item of items) {
    const size = new TextEncoder().encode(JSON.stringify(item)).byteLength;
    if (current.length && (current.length === ITEMS_PER_CHUNK || bytes + size > CHUNK_BYTES)) { out.push(current); current = []; bytes = 0; }
    current.push(item);
    bytes += size;
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * Drive the Worker through one run: each destination in order, one message per call, pausing like the
 * legacy sender and honoring flood control. A blocked destination never stops the others.
 */
async function deliverRun(backend: DigestBackend, p: Pending, wait: (ms: number) => Promise<void>): Promise<Omit<UserOutcome, "slug" | "userId">> {
  const blocked: string[] = [];
  let busy = 0, waited = 0;
  for (const destinationId of [...p.user.destinationIds].sort()) {
    for (;;) {
      let o;
      try {
        o = await backend.deliver(p.user.userId, p.runId, destinationId);
      } catch (error) {
        if (error instanceof BackendError && error.status === 404) break; // destination added after this run was prepared
        throw error;
      }
      if (o.state === "done") return { state: "delivered", runId: p.runId };
      if (o.state === "destination_done") break;
      if (o.state === "blocked") { blocked.push(o.messageId ?? ""); logger.error("delivery blocked", { runId: p.runId, messageId: o.messageId }); break; }
      if (o.state === "sent") { await wait(INTER_MESSAGE_MS); continue; }
      if (o.state === "retry") {
        const ms = Math.min((o.retryAfter ?? 1) * 1000, MAX_RETRY_WAIT_MS);
        waited += ms;
        if (waited > MAX_TOTAL_WAIT_MS) return { state: "paused", runId: p.runId, error: "Telegram flood control; run again to resume" };
        await wait(ms);
        continue;
      }
      if (++busy > MAX_BUSY) return { state: "failed", runId: p.runId, error: "Another delivery of this run is in progress" };
      await wait(2000);
    }
  }
  if (blocked.length) return { state: "blocked", runId: p.runId, messageId: blocked[0] };
  return { state: "failed", runId: p.runId, error: "Messages remain for a destination that is no longer active" };
}

/** Plain-text operator alert with run ids and states only: no user data travels in alerts. */
async function alertOperators(backend: DigestBackend, period: string, outcomes: UserOutcome[]): Promise<void> {
  const problems = outcomes.filter(needsAttention);
  if (!problems.length) return;
  const lines = problems.map(o => `• ${o.runId ?? "sin run"}: ${o.state}${o.messageId ? ` (mensaje ${o.messageId})` : ""}`);
  try {
    const result = await backend.opsAlert([`⚠️ Digest ${period}: ${problems.length} ejecución(es) requieren atención.`, ...lines].join("\n").slice(0, 1500));
    if (result.sent === 0) logger.error("operator alert reached nobody", result);
  } catch (error) {
    logger.error("operator alert failed", { error: String(error) });
  }
}
