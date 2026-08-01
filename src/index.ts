import { parseArgs } from "node:util";
import { config } from "./config.js";
import { loadEnv, type Env } from "./env.js";
import { loadProfile } from "./profile.js";
import { PubMedClient } from "./pubmed.js";
import { makeAnthropicScorer } from "./scoring.js";
import { JsonFileStore } from "./state.js";
import { ConsoleDeliverer, MultiDeliverer, TelegramDeliverer, type Deliverer } from "./deliver.js";
import { parseRecipients, selectRecipients } from "./recipients.js";
import { loadCache, saveCache, type CacheSnapshot } from "./cache.js";
import { RunMetrics, writeStepSummary } from "./metrics.js";
import {
  deliverDigest,
  deliverSearch,
  runDigestPipeline,
  runSearchPipeline,
  type PipelineDeps,
} from "./pipeline.js";
import { logger } from "./logger.js";
import { stripArgSeparator } from "./util.js";
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

/** Build everything the pipeline needs from flags and the environment. */
function makeDeps(env: Env, flags: CommonFlags): PipelineDeps {
  const profile = loadProfile();
  return {
    cfg: { ...config, threshold: profile.threshold ?? config.threshold },
    profile,
    pubmed: new PubMedClient({ email: env.EUTILS_EMAIL, apiKey: env.NCBI_API_KEY }),
    scorer: makeAnthropicScorer(env.ANTHROPIC_API_KEY, config.model, config.batchSize),
    deliverer: makeDeliverer(env, flags),
    metrics: new RunMetrics(),
  };
}

async function runDigest(flags: CommonFlags): Promise<void> {
  const env = loadEnv();
  const deps = makeDeps(env, flags);
  const cachePath = flags.cachePath ?? ".cache/digest.json";
  const title = digestTitle();

  try {
    // --- Replay from cache: no PubMed, no Anthropic, no state ---
    if (flags.fromCache) {
      const snap = await loadCache(cachePath);
      logger.info("loaded from cache", { path: cachePath, scored: snap.scored.length });
      deps.metrics.scored = snap.scored.length;
      await deliverDigest(deps, snap.scored, title);
      return;
    }

    // --- Re-score cached papers: skips PubMed, re-runs scoring, no state ---
    if (flags.rescore) {
      const snap = await loadCache(cachePath);
      logger.info("re-scoring cached papers", { path: cachePath, papers: snap.papers.length });
      const scored = await deps.scorer.score(snap.papers, { profile: deps.profile });
      const refined = await deps.scorer.rerank(
        [...scored].sort((a, b) => b.relevance - a.relevance).slice(0, deps.cfg.rerankTopK),
        { profile: deps.profile },
      );
      const merged = mergeScores(scored, refined);
      recordUsage(deps);
      deps.metrics.scored = merged.length;
      if (flags.saveCache) {
        await saveCache(cachePath, snapshot("digest", undefined, snap.papers, merged));
        logger.info("cache updated", { path: cachePath });
      }
      await deliverDigest(deps, merged, title);
      return;
    }

    // --- Normal path ---
    const store = new JsonFileStore(STATE_PATH);
    await store.load();
    logger.info("loaded state", { seen: store.size() });

    const { papers, scored } = await runDigestPipeline(deps, {
      title,
      dryRun: flags.dryRun,
      limit: flags.limit,
      store,
    });

    if (flags.saveCache && papers.length > 0) {
      await saveCache(cachePath, snapshot("digest", undefined, papers, scored));
      logger.info("cache saved", { path: cachePath, papers: papers.length });
    }
  } finally {
    reportRun(deps, "Digest");
  }
}

async function runSearch(topic: string, flags: CommonFlags): Promise<void> {
  const env = loadEnv();
  const deps = makeDeps(env, flags);
  const cachePath = flags.cachePath ?? ".cache/search.json";

  try {
    if (flags.fromCache) {
      const snap = await loadCache(cachePath);
      const t = snap.topic ?? topic;
      logger.info("loaded search from cache", { path: cachePath, scored: snap.scored.length });
      deps.metrics.scored = snap.scored.length;
      await deliverSearch(deps, snap.scored, `Búsqueda: ${t}`);
      return;
    }

    if (flags.rescore) {
      const snap = await loadCache(cachePath);
      const t = snap.topic ?? topic;
      logger.info("re-scoring cached search papers", { path: cachePath, papers: snap.papers.length });
      const scored = await deps.scorer.score(snap.papers, { profile: deps.profile, topic: t });
      recordUsage(deps);
      deps.metrics.scored = scored.length;
      if (flags.saveCache) {
        await saveCache(cachePath, snapshot("search", t, snap.papers, scored));
        logger.info("cache updated", { path: cachePath });
      }
      await deliverSearch(deps, scored, `Búsqueda: ${t}`);
      return;
    }

    const { papers, scored } = await runSearchPipeline(deps, {
      topic,
      title: `Búsqueda: ${topic}`,
      limit: flags.limit,
    });

    if (flags.saveCache && papers.length > 0) {
      await saveCache(cachePath, snapshot("search", topic, papers, scored));
      logger.info("cache saved", { path: cachePath, papers: papers.length });
    }
  } finally {
    reportRun(deps, `Búsqueda: ${topic}`);
  }
}

function mergeScores(all: ScoredPaper[], refined: ScoredPaper[]): ScoredPaper[] {
  const byPmid = new Map(refined.map((p) => [p.pmid, p]));
  return all.map((p) => byPmid.get(p.pmid) ?? p);
}

function recordUsage(deps: PipelineDeps): void {
  deps.metrics.calls = deps.scorer.usage.calls;
  deps.metrics.inputTokens = deps.scorer.usage.inputTokens;
  deps.metrics.outputTokens = deps.scorer.usage.outputTokens;
}

/** Always emit the run report, including when the run failed part-way through. */
function reportRun(deps: PipelineDeps, title: string): void {
  logger.info("run summary", deps.metrics.toFields(deps.cfg.pricing));
  writeStepSummary(deps.metrics.toMarkdown(deps.cfg.pricing, title));
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
      "La cobertura (revistas y búsquedas permanentes) se edita en profile.yaml.",
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  logger.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
