import { parseArgs } from "node:util";
import { config } from "./config.js";
import { loadEnv, type Env } from "./env.js";
import { loadProfile } from "./profile.js";
import { PubMedClient, journalTerm, topicTerm } from "./pubmed.js";
import { makeAnthropicScorer } from "./scoring.js";
import { JsonFileStore } from "./state.js";
import { ConsoleDeliverer, TelegramDeliverer, type Deliverer } from "./deliver.js";
import { filterByThreshold, renderDigest } from "./digest.js";
import { logger } from "./logger.js";
import { chunk, stripArgSeparator } from "./util.js";
import type { Paper } from "./types.js";

const STATE_PATH = "state.json";

interface CommonFlags {
  dryRun: boolean;
  limit?: number;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: stripArgSeparator(process.argv.slice(2)),
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string" },
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
  const flags: CommonFlags = { dryRun: Boolean(values["dry-run"]), limit };

  if (command === "digest") {
    await runDigest(flags);
  } else if (command === "search") {
    const topic = positionals.slice(1).join(" ").trim();
    if (!topic) throw new Error('search requires a topic, e.g. search "glioma MRI"');
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
  const pubmed = new PubMedClient({ email: env.EUTILS_EMAIL, apiKey: env.NCBI_API_KEY });
  const store = new JsonFileStore(STATE_PATH);
  await store.load();
  logger.info("loaded state", { seen: store.size() });

  // 1. Collect new PMIDs across journals + standing topics, de-duplicated across sources
  //    and against the seen ledger.
  const sources = [
    ...config.journals.map((j) => ({ label: j, term: journalTerm(j) })),
    ...config.topics.map((t) => ({ label: t, term: topicTerm(t) })),
  ];

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

  const title = digestTitle();
  if (newPmids.length === 0) {
    logger.info("nothing new to score");
    if (flags.dryRun) await new ConsoleDeliverer().send(renderDigest([], { title }));
    return;
  }

  // 2. Cost guardrail: cap papers scored.
  const cap = Math.min(flags.limit ?? config.maxAbstractsPerRun, config.maxAbstractsPerRun);
  if (newPmids.length > cap) {
    logger.warn("capping papers scored", { from: newPmids.length, to: cap });
    newPmids = newPmids.slice(0, cap);
  }

  // 3. Fetch full records.
  const papers = await fetchPapers(pubmed, newPmids, pmidToSource);

  // 4. No-abstract policy.
  const toScore = config.scoreWithoutAbstract ? papers : papers.filter((p) => p.hasAbstract);
  if (!config.scoreWithoutAbstract && toScore.length < papers.length) {
    logger.info("dropped papers without abstract", { dropped: papers.length - toScore.length });
  }

  // 5. Score, then keep those above the threshold.
  const scorer = makeAnthropicScorer(env.ANTHROPIC_API_KEY, config.model, config.batchSize);
  const scored = await scorer.score(toScore, { profile });
  const kept = filterByThreshold(scored, config.threshold);
  logger.info("scored", { total: scored.length, kept: kept.length, threshold: config.threshold });

  const text = renderDigest(kept, { title });

  // 6. Deliver (or dry-run) and record state.
  if (flags.dryRun) {
    await new ConsoleDeliverer().send(text);
    logger.info("dry-run: not delivering, not updating state");
    return;
  }

  const deliverer = makeTelegram(env);
  await deliverer.send(text);

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
  const pubmed = new PubMedClient({ email: env.EUTILS_EMAIL, apiKey: env.NCBI_API_KEY });

  const term = topicTerm(topic);
  logger.info("search", { topic, term });
  let ids = await pubmed.esearch(term, { reldate: config.lookbackDays, retmax: 200 });
  logger.info("search esearch", { found: ids.length });

  if (ids.length === 0) {
    await new ConsoleDeliverer().send(`Búsqueda: ${topic}\n\nSin resultados recientes.`);
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

  // search ranks top-N descending; the profile threshold is NOT applied here.
  const ranked = [...scored]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, config.searchTopResults);
  const text = renderDigest(ranked, { title: `Búsqueda: ${topic}` });

  if (flags.dryRun) {
    await new ConsoleDeliverer().send(text);
    return;
  }
  const deliverer = makeTelegram(env);
  await deliverer.send(text);
  logger.info("search delivered", { results: ranked.length });
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

function makeTelegram(env: Env): Deliverer {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error(
      "Delivery requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID. Use --dry-run to skip delivery.",
    );
  }
  return new TelegramDeliverer(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
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
      "  pnpm dev:digest -- [--dry-run] [--limit N]",
      '  pnpm dev:search "<tema>" -- [--dry-run] [--limit N]',
      "",
      "Opciones:",
      "  --dry-run     Busca, puntúa e imprime, pero NO entrega ni guarda estado.",
      "  --limit N     Límite de artículos puntuados (para pruebas baratas).",
      "  -h, --help    Muestra esta ayuda.",
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  logger.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
