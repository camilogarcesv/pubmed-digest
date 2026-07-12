import { parseArgs } from "node:util";
import { config } from "./config.js";
import { loadEnv, type Env } from "./env.js";
import { loadProfile } from "./profile.js";
import { PubMedClient, journalTerm, topicTerm } from "./pubmed.js";
import { makeAnthropicScorer } from "./scoring.js";
import { JsonFileStore } from "./state.js";
import { ConsoleDeliverer, MultiDeliverer, TelegramDeliverer, type Deliverer } from "./deliver.js";
import { parseRecipients, selectRecipients } from "./recipients.js";
import { loadCache, saveCache, type CacheSnapshot } from "./cache.js";
import { filterByThreshold, renderDigest } from "./digest.js";
import { logger } from "./logger.js";
import { chunk, stripArgSeparator } from "./util.js";
import type { Paper, ScoredPaper } from "./types.js";

const STATE_PATH = "state.json";

interface CommonFlags {
  dryRun: boolean;
  limit?: number;
  saveCache: boolean;
  fromCache: boolean;
  rescore: boolean;
  cachePath?: string;
  to?: string;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: stripArgSeparator(process.argv.slice(2)),
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string" },
      "save-cache": { type: "boolean", default: false },
      "from-cache": { type: "boolean", default: false },
      rescore: { type: "boolean", default: false },
      cache: { type: "string" },
      to: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    printHelp();
    return;
  }

  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`--limit must be a positive number, got "${values.limit}"`);
    }
  }

  const flags: CommonFlags = {
    dryRun: Boolean(values["dry-run"]),
    limit,
    saveCache: Boolean(values["save-cache"]),
    fromCache: Boolean(values["from-cache"]),
    rescore: Boolean(values.rescore),
    cachePath: values.cache,
    to: values.to,
  };

  if (flags.fromCache && flags.rescore) {
    throw new Error("--from-cache and --rescore are mutually exclusive.");
  }

  if (command === "digest") {
    await runDigest(flags);
  } else if (command === "search") {
    const topic = positionals.slice(1).join(" ").trim();
    if (!topic && !flags.fromCache && !flags.rescore) {
      throw new Error('search requires a topic, e.g. search "glioma MRI"');
    }
    await runSearch(topic, flags);
  } else {
    logger.error("unknown command", { command });
    printHelp();
    process.exitCode = 1;
  }
}

async function runDigest(flags: CommonFlags): Promise<void> {
  const env = loadEnv();
  const profile = loadProfile();
  const deliverer = makeDeliverer(env, flags);
  const cachePath = flags.cachePath ?? ".cache/digest.json";
  const title = digestTitle();

  // --- Replay from cache: no PubMed, no Anthropic, no state ---
  if (flags.fromCache) {
    const snap = await loadCache(cachePath);
    logger.info("loaded from cache", { path: cachePath, scored: snap.scored.length });
    const kept = filterByThreshold(snap.scored, config.threshold);
    await deliverer.send(renderDigest(kept, { title }));
    logger.info("digest replayed from cache", { kept: kept.length });
    return;
  }

  // --- Re-score cached papers: skips PubMed, re-runs scoring, no state ---
  if (flags.rescore) {
    const snap = await loadCache(cachePath);
    logger.info("re-scoring cached papers", { path: cachePath, papers: snap.papers.length });
    const scorer = makeAnthropicScorer(env.ANTHROPIC_API_KEY, config.model, config.batchSize);
    const scored = await scorer.score(snap.papers, { profile });
    if (flags.saveCache) {
      await saveCache(cachePath, snapshot("digest", undefined, snap.papers, scored));
      logger.info("cache updated", { path: cachePath });
    }
    const kept = filterByThreshold(scored, config.threshold);
    await deliverer.send(renderDigest(kept, { title }));
    logger.info("digest delivered (rescore)", { kept: kept.length });
    return;
  }

  // --- Normal path: fetch + dedupe + score (+ optional cache) + deliver + state ---
  const store = new JsonFileStore(STATE_PATH);
  await store.load();
  logger.info("loaded state", { seen: store.size() });

  const sources = [
    ...config.journals.map((j) => ({ label: j, term: journalTerm(j) })),
    ...config.topics.map((t) => ({ label: t, term: topicTerm(t) })),
  ];

  const pubmed = new PubMedClient({ email: env.EUTILS_EMAIL, apiKey: env.NCBI_API_KEY });
  const pmidToSource = new Map<string, string>();
  for (const s of sources) {
    try {
      const ids = await pubmed.esearch(s.term, { reldate: config.lookbackDays, retmax: 200 });
      logger.info("esearch", { source: s.label, found: ids.length });
      for (const id of ids) {
        if (store.has(id)) continue; // already handled in a previous run
        if (!pmidToSource.has(id)) pmidToSource.set(id, s.label); // dedupe within this run
      }
    } catch (err) {
      logger.error("esearch failed, skipping source", { source: s.label, error: String(err) });
    }
  }

  let newPmids = [...pmidToSource.keys()];
  logger.info("new PMIDs after dedupe", { count: newPmids.length });
  if (newPmids.length === 0) {
    logger.info("nothing new to score");
    if (flags.dryRun) await deliverer.send(renderDigest([], { title }));
    return;
  }

  const cap = Math.min(flags.limit ?? config.maxAbstractsPerRun, config.maxAbstractsPerRun);
  if (newPmids.length > cap) {
    logger.warn("capping papers scored", { from: newPmids.length, to: cap });
    newPmids = newPmids.slice(0, cap);
  }

  const papers = await fetchPapers(pubmed, newPmids, pmidToSource);
  const toScore = config.scoreWithoutAbstract ? papers : papers.filter((p) => p.hasAbstract);
  if (!config.scoreWithoutAbstract && toScore.length < papers.length) {
    logger.info("dropped papers without abstract", { dropped: papers.length - toScore.length });
  }

  const scorer = makeAnthropicScorer(env.ANTHROPIC_API_KEY, config.model, config.batchSize);
  const scored = await scorer.score(toScore, { profile });

  if (flags.saveCache) {
    await saveCache(cachePath, snapshot("digest", undefined, papers, scored));
    logger.info("cache saved", { path: cachePath, papers: papers.length });
  }

  const kept = filterByThreshold(scored, config.threshold);
  logger.info("scored", { total: scored.length, kept: kept.length, threshold: config.threshold });

  await deliverer.send(renderDigest(kept, { title }));

  if (flags.dryRun) {
    logger.info("dry-run: state not updated");
    return;
  }

  const toMark =
    config.markSeenMode === "delivered" ? kept.map((p) => p.pmid) : papers.map((p) => p.pmid);
  store.add(toMark);
  await store.save();
  logger.info("digest delivered and state saved", {
    delivered: kept.length,
    marked: toMark.length,
    seenTotal: store.size(),
  });
}

async function runSearch(topic: string, flags: CommonFlags): Promise<void> {
  const env = loadEnv();
  const profile = loadProfile();
  const deliverer = makeDeliverer(env, flags);
  const cachePath = flags.cachePath ?? ".cache/search.json";

  if (flags.fromCache) {
    const snap = await loadCache(cachePath);
    const t = snap.topic ?? topic;
    logger.info("loaded search from cache", { path: cachePath, scored: snap.scored.length });
    await deliverer.send(renderDigest(topN(snap.scored), { title: `Búsqueda: ${t}` }));
    return;
  }

  if (flags.rescore) {
    const snap = await loadCache(cachePath);
    const t = snap.topic ?? topic;
    logger.info("re-scoring cached search papers", { path: cachePath, papers: snap.papers.length });
    const scorer = makeAnthropicScorer(env.ANTHROPIC_API_KEY, config.model, config.batchSize);
    const scored = await scorer.score(snap.papers, { profile, topic: t });
    if (flags.saveCache) {
      await saveCache(cachePath, snapshot("search", t, snap.papers, scored));
      logger.info("cache updated", { path: cachePath });
    }
    await deliverer.send(renderDigest(topN(scored), { title: `Búsqueda: ${t}` }));
    return;
  }

  const pubmed = new PubMedClient({ email: env.EUTILS_EMAIL, apiKey: env.NCBI_API_KEY });
  const term = topicTerm(topic);
  logger.info("search", { topic, term });
  let ids = await pubmed.esearch(term, { reldate: config.lookbackDays, retmax: 200 });
  logger.info("search esearch", { found: ids.length });

  if (ids.length === 0) {
    await deliverer.send(`Búsqueda: ${topic}\n\nSin resultados recientes.`);
    return;
  }

  const cap = Math.min(flags.limit ?? config.maxAbstractsPerRun, config.maxAbstractsPerRun);
  if (ids.length > cap) {
    logger.warn("capping search papers", { from: ids.length, to: cap });
    ids = ids.slice(0, cap);
  }

  const source = new Map(ids.map((id) => [id, topic] as const));
  const papers = await fetchPapers(pubmed, ids, source);
  const toScore = config.scoreWithoutAbstract ? papers : papers.filter((p) => p.hasAbstract);

  const scorer = makeAnthropicScorer(env.ANTHROPIC_API_KEY, config.model, config.batchSize);
  const scored = await scorer.score(toScore, { profile, topic });

  if (flags.saveCache) {
    await saveCache(cachePath, snapshot("search", topic, papers, scored));
    logger.info("cache saved", { path: cachePath, papers: papers.length });
  }

  // search ranks top-N descending; the profile threshold is NOT applied here.
  await deliverer.send(renderDigest(topN(scored), { title: `Búsqueda: ${topic}` }));
  logger.info("search delivered", { results: Math.min(scored.length, config.searchTopResults) });
}

function topN(scored: ScoredPaper[]): ScoredPaper[] {
  return [...scored].sort((a, b) => b.relevance - a.relevance).slice(0, config.searchTopResults);
}

function snapshot(
  command: "digest" | "search",
  topic: string | undefined,
  papers: Paper[],
  scored: ScoredPaper[],
): CacheSnapshot {
  return {
    version: 1,
    command,
    topic,
    createdAt: new Date().toISOString(),
    model: config.model,
    papers,
    scored,
  };
}

async function fetchPapers(
  pubmed: PubMedClient,
  pmids: string[],
  source: ReadonlyMap<string, string>,
): Promise<Paper[]> {
  const out: Paper[] = [];
  for (const batch of chunk(pmids, config.efetchIdBatchSize)) {
    const papers = await pubmed.efetch(batch);
    for (const p of papers) p.source = source.get(p.pmid) ?? "";
    out.push(...papers);
  }
  return out;
}

/** ConsoleDeliverer for --dry-run (nobody); otherwise a MultiDeliverer over the selected recipients. */
function makeDeliverer(env: Env, flags: CommonFlags): Deliverer {
  if (flags.dryRun) return new ConsoleDeliverer();

  const recipients = selectRecipients(parseRecipients(env), flags.to);
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("Delivery requires TELEGRAM_BOT_TOKEN. Use --dry-run to skip delivery.");
  }
  return new MultiDeliverer(
    recipients.map((r) => ({ name: r.name, deliverer: new TelegramDeliverer(token, r.chatId) })),
  );
}

function digestTitle(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `📚 Digest de artículos (${today})`;
}

function printHelp(): void {
  process.stdout.write(
    [
      "pubmed-digest — relevancia de PubMed puntuada con IA",
      "",
      "Uso:",
      "  pnpm dev:digest -- [opciones]",
      '  pnpm dev:search "<tema>" -- [opciones]',
      "",
      "Opciones:",
      "  --dry-run          Busca, puntúa e imprime; NO entrega ni guarda estado.",
      "  --limit N          Límite de artículos puntuados (pruebas baratas).",
      "  --to <nombres>     Destinatarios: 'me', 'me,amigo' o 'all'. Por defecto: solo 'me'.",
      "  --save-cache       Guarda la corrida (papers + puntajes) en el caché.",
      "  --from-cache       Reproduce desde el caché (sin PubMed ni Anthropic).",
      "  --rescore          Re-puntúa los papers cacheados (sin PubMed; sí usa Anthropic).",
      "  --cache <ruta>     Ruta del caché (por defecto .cache/<comando>.json).",
      "  -h, --help         Muestra esta ayuda.",
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  logger.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
