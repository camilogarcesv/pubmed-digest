// Non-secret configuration. Secrets live only in the environment (see env.ts).
// Edit journals/topics/threshold here; edit the relevance definition in profile.yaml.

export type MarkSeenMode = "considered" | "delivered";

export interface AppConfig {
  /** Anthropic model. Alias tracks the latest snapshot; pin the dated id for reproducibility. */
  model: string;
  /** Digest keeps papers with relevance >= threshold (search ignores this; it ranks top-N). */
  threshold: number;
  /** Maps directly to E-utilities `reldate` with `datetype=edat`. 8 = one day of slack over a weekly cron. */
  lookbackDays: number;
  /** Hard cap on papers scored per run (cost guardrail; the --limit flag can lower it further). */
  maxAbstractsPerRun: number;
  /** Abstracts per Anthropic scoring call. */
  batchSize: number;
  /** How many ranked results `search` shows/delivers. */
  searchTopResults: number;
  /** Score epub-ahead-of-print records that still lack an abstract (by title). false = skip them. */
  scoreWithoutAbstract: boolean;
  /** PMIDs per efetch request. */
  efetchIdBatchSize: number;
  /** Max PMIDs esearch may return per source. Above this the run warns about truncation. */
  esearchRetmax: number;
  /**
   * NLM publication types dropped before scoring. These are editorial artifacts, not research:
   * filtering them here removes digest noise AND the cost of scoring them.
   */
  excludedPublicationTypes: string[];
  /**
   * Second scoring pass that re-ranks only the best candidates against each other. A model's
   * absolute 0-10 score drifts between batches; comparing the finalists head-to-head fixes the
   * ordering for the price of one extra call. 0 disables it.
   */
  rerankTopK: number;
  /** Hard cap on delivered papers, applied after the threshold. */
  maxDelivered: number;
  /**
   * If fewer than this many papers clear the threshold, fill up to `minDelivered` with the
   * next best ones so a quiet week still produces a useful digest instead of an empty one.
   */
  minDelivered: number;
  /** Anthropic price per 1M tokens, for the estimated cost in the run summary. */
  pricing: { inputPerMTok: number; outputPerMTok: number };
  /**
   * Which PMIDs the digest records in state.json:
   *  - "considered": every paper evaluated this run (so below-threshold papers aren't re-scored,
   *    and re-billed, every week). Recommended for cost control.
   *  - "delivered": only papers actually sent (strict "already sent" semantics).
   */
  markSeenMode: MarkSeenMode;
}

export const config: AppConfig = {
  model: "claude-haiku-4-5",
  threshold: 7,
  lookbackDays: 8,
  maxAbstractsPerRun: 250,
  batchSize: 18,
  searchTopResults: 15,
  scoreWithoutAbstract: true,
  efetchIdBatchSize: 200,
  esearchRetmax: 200,
  excludedPublicationTypes: [
    "Published Erratum",
    "Comment",
    "Retraction of Publication",
    "Retracted Publication",
    "Editorial",
    "News",
    "Congress",
  ],
  rerankTopK: 15,
  maxDelivered: 12,
  minDelivered: 3,
  pricing: { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  markSeenMode: "considered",
};
