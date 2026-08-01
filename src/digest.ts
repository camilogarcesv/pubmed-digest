import type { ScoredPaper } from "./types.js";
import type { OutMessage } from "./deliver.js";
import { voteKeyboard } from "./feedback.js";

export interface RenderOptions {
  title: string;
  /** Optional one-line run summary appended at the end (counts and estimated cost). */
  footer?: string;
  /**
   * Attach a 👍/👎 inline keyboard to every paper. On for the digest (votes feed the eval and
   * the dynamic exemplars); off for search, whose topic-primary scores aren't comparable with
   * the profile's and would pollute the vote signal.
   */
  withKeyboards?: boolean;
}

export interface SelectOptions {
  threshold: number;
  /** Hard cap on delivered papers, so a busy week doesn't produce a wall of text. */
  max: number;
  /** Deliver at least this many by relaxing the threshold, so a quiet week isn't empty. */
  min: number;
}

/** How far below the threshold a paper may be pulled in to satisfy `min`. */
const NEAR_MISS_MARGIN = 2;

export interface Selection {
  /** Papers at or above the threshold. */
  kept: ScoredPaper[];
  /** Near misses added only because fewer than `min` papers cleared the threshold. */
  nearMisses: ScoredPaper[];
}

/**
 * Pick what actually gets delivered. A fixed threshold alone either floods the digest or
 * empties it; this caps the good weeks and, on quiet ones, tops up with near misses so the
 * reader still gets something useful (clearly labeled as below the bar).
 */
export function selectForDigest(papers: ScoredPaper[], opts: SelectOptions): Selection {
  const ranked = [...papers].sort((a, b) => b.relevance - a.relevance);
  const kept = ranked.filter((p) => p.relevance >= opts.threshold).slice(0, opts.max);

  if (kept.length >= opts.min) return { kept, nearMisses: [] };

  const floor = opts.threshold - NEAR_MISS_MARGIN;
  const nearMisses = ranked
    .filter((p) => p.relevance < opts.threshold && p.relevance >= floor)
    .slice(0, opts.min - kept.length);
  return { kept, nearMisses };
}

/**
 * Render the digest as a sequence of Telegram-HTML messages: a header, one message per paper
 * (each carrying its own 👍/👎 keyboard — Telegram anchors an inline keyboard to a single
 * message, which is why the digest is not one big blob), an optional near-miss section, and a
 * footer with the run receipt. HTML (not MarkdownV2) because it only requires escaping three
 * characters — MarkdownV2 needs 18 escaped anywhere, and paper titles are full of exactly
 * that punctuation.
 */
export function renderDigestMessages(
  papers: ScoredPaper[],
  opts: RenderOptions,
  nearMisses: ScoredPaper[] = [],
): OutMessage[] {
  const header = `<b>${escapeHtml(opts.title)}</b>`;

  if (papers.length === 0 && nearMisses.length === 0) {
    const parts = [header, "No hay artículos que superen el umbral esta vez."];
    if (opts.footer) parts.push(`<i>${escapeHtml(opts.footer)}</i>`);
    return [{ text: parts.join("\n\n") }];
  }

  const messages: OutMessage[] = [{ text: header }];
  for (const p of [...papers].sort(byRelevance)) messages.push(paperMessage(p, opts));

  if (nearMisses.length > 0) {
    messages.push({ text: "<i>Cerca del umbral (semana floja):</i>" });
    // Near-miss votes are extra-valuable signal: they say exactly where the bar sits wrong.
    for (const p of [...nearMisses].sort(byRelevance)) messages.push(paperMessage(p, opts));
  }

  if (opts.footer) messages.push({ text: `<i>${escapeHtml(opts.footer)}</i>` });
  return messages;
}

function paperMessage(p: ScoredPaper, opts: RenderOptions): OutMessage {
  return {
    text: renderItem(p),
    keyboard: opts.withKeyboards ? voteKeyboard(p.pmid) : undefined,
  };
}

function byRelevance(a: ScoredPaper, b: ScoredPaper): number {
  return b.relevance - a.relevance;
}

function renderItem(p: ScoredPaper): string {
  const badge = p.relevance >= 9 ? "🔥" : "⭐";
  const meta = [firstAuthorEtAl(p), p.journal, p.pubDate, studyTypeLabel(p)]
    .filter(Boolean)
    .map(escapeHtml)
    .join(" · ");

  const links = [`<a href="https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/">PubMed</a>`];
  if (p.doi) links.push(`<a href="https://doi.org/${encodeURI(p.doi)}">DOI</a>`);

  return [
    `${badge} ${p.relevance}/10 — <b>${escapeHtml(truncate(p.title, 300))}</b>`,
    meta,
    `→ ${escapeHtml(truncate(p.reason, 300))}`,
    links.join(" · "),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The most informative publication type, in Spanish. Ordered by how much it tells the reader
 * about the strength of the evidence; "Journal Article" is deliberately absent because every
 * record carries it and it says nothing.
 */
const STUDY_TYPES: [string, string][] = [
  ["meta-analysis", "Metaanálisis"],
  ["systematic review", "Revisión sistemática"],
  ["randomized controlled trial", "Ensayo aleatorizado"],
  ["practice guideline", "Guía clínica"],
  ["guideline", "Guía clínica"],
  ["clinical trial", "Ensayo clínico"],
  ["multicenter study", "Estudio multicéntrico"],
  ["observational study", "Estudio observacional"],
  ["comparative study", "Estudio comparativo"],
  ["review", "Revisión"],
  ["case reports", "Reporte de casos"],
];

function studyTypeLabel(p: ScoredPaper): string {
  const types = new Set(p.publicationTypes.map((t) => t.toLowerCase()));
  for (const [needle, label] of STUDY_TYPES) {
    if (types.has(needle)) return label;
  }
  return "";
}

function firstAuthorEtAl(p: ScoredPaper): string {
  const a = p.authors[0];
  if (!a) return "";
  const name = [a.lastName, a.foreName].filter(Boolean).join(" ");
  return p.authors.length > 1 ? `${name} et al.` : name;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Telegram HTML needs exactly these three escaped; attribute values additionally need quotes. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
