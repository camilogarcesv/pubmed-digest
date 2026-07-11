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
  /**
   * Which PMIDs the digest records in state.json:
   *  - "considered": every paper evaluated this run (so below-threshold papers aren't re-scored,
   *    and re-billed, every week). Recommended for cost control.
   *  - "delivered": only papers actually sent (strict "already sent" semantics).
   */
  markSeenMode: MarkSeenMode;
  /** Journals to follow (matched with the [Journal] tag; ISO abbreviations are safest). */
  journals: string[];
  /**
   * Standing ad-hoc topic queries included in every digest. Plain phrases are wrapped as
   * ("word"[tiab] AND ...); strings that already contain a field tag or AND/OR pass through.
   */
  topics: string[];
}

export const config: AppConfig = {
  model: "claude-haiku-4-5",
  threshold: 7,
  lookbackDays: 8,
  maxAbstractsPerRun: 120,
  batchSize: 18,
  searchTopResults: 15,
  scoreWithoutAbstract: true,
  efetchIdBatchSize: 200,
  markSeenMode: "considered",
  journals: [
    "AJNR Am J Neuroradiol",
    "Clin Neuroradiol",
    "Interv Neuroradiol",
    "Eur Radiol",
    "Emerg Radiol",
  ],
  topics: [
    // Examples (uncomment / edit):
    // '("large vessel occlusion"[tiab] AND "thrombectomy"[tiab])',
    // '("glioma"[tiab] AND "MRI"[tiab])',
  ],
};
