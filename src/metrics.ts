// What a run actually did, and what it cost. Without this a digest is a black box: you cannot
// tell "nothing was relevant this week" from "every source failed", nor notice cost drifting.

import { appendFileSync } from "node:fs";
import { logger } from "./logger.js";

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export class RunMetrics {
  sourcesOk = 0;
  sourcesFailed = 0;
  /** Sources where PubMed reported more matches than retmax returned. */
  sourcesTruncated = 0;
  /** PMIDs returned across all sources, before any de-duplication. */
  found = 0;
  /** PMIDs left after dropping duplicates and everything already in the ledger. */
  newAfterDedupe = 0;
  fetched = 0;
  droppedByType = 0;
  droppedByDoi = 0;
  scored = 0;
  delivered = 0;
  nearMisses = 0;
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;

  private readonly startedAt = Date.now();

  get durationMs(): number {
    return Date.now() - this.startedAt;
  }

  estimatedCostUsd(pricing: Pricing): number {
    return (
      (this.inputTokens / 1_000_000) * pricing.inputPerMTok +
      (this.outputTokens / 1_000_000) * pricing.outputPerMTok
    );
  }

  /** Compact line appended to the digest itself, so every message carries its own receipt. */
  telegramFooter(pricing: Pricing): string {
    const parts = [
      `${this.newAfterDedupe} nuevos`,
      `${this.scored} puntuados`,
      `${this.delivered} destacados`,
      `~${formatUsd(this.estimatedCostUsd(pricing))}`,
    ];
    if (this.sourcesFailed > 0) parts.push(`⚠️ ${this.sourcesFailed} fuentes fallaron`);
    return `— ${parts.join(" · ")}`;
  }

  toFields(pricing: Pricing): Record<string, unknown> {
    return {
      sourcesOk: this.sourcesOk,
      sourcesFailed: this.sourcesFailed,
      sourcesTruncated: this.sourcesTruncated,
      found: this.found,
      newAfterDedupe: this.newAfterDedupe,
      fetched: this.fetched,
      droppedByType: this.droppedByType,
      droppedByDoi: this.droppedByDoi,
      scored: this.scored,
      delivered: this.delivered,
      nearMisses: this.nearMisses,
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      estimatedUsd: Number(this.estimatedCostUsd(pricing).toFixed(4)),
      durationMs: this.durationMs,
    };
  }

  toMarkdown(pricing: Pricing, title: string): string {
    const rows: [string, string | number][] = [
      ["Fuentes OK / fallidas", `${this.sourcesOk} / ${this.sourcesFailed}`],
      ["Fuentes truncadas", this.sourcesTruncated],
      ["PMIDs encontrados", this.found],
      ["Nuevos tras dedupe", this.newAfterDedupe],
      ["Descartados por tipo", this.droppedByType],
      ["Descartados por DOI duplicado", this.droppedByDoi],
      ["Puntuados", this.scored],
      ["Entregados (+ cerca del umbral)", `${this.delivered} (+${this.nearMisses})`],
      ["Llamadas al modelo", this.calls],
      ["Tokens entrada / salida", `${this.inputTokens} / ${this.outputTokens}`],
      ["Coste estimado", formatUsd(this.estimatedCostUsd(pricing))],
      ["Duración", `${(this.durationMs / 1000).toFixed(1)} s`],
    ];
    return [
      `### ${title}`,
      "",
      "| Métrica | Valor |",
      "| --- | --- |",
      ...rows.map(([k, v]) => `| ${k} | ${v} |`),
      "",
    ].join("\n");
  }
}

function formatUsd(n: number): string {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/**
 * Append a markdown block to the GitHub Actions job summary. A no-op outside Actions, and
 * never fatal: a run must not fail because it could not write its own report.
 */
export function writeStepSummary(markdown: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, markdown + "\n", "utf8");
  } catch (err) {
    logger.warn("could not write the job summary", { error: String(err) });
  }
}
