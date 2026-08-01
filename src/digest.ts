import type { ScoredPaper } from "./types.js";

export interface RenderOptions {
  title: string;
  /** Optional one-line run summary appended at the end (counts and estimated cost). */
  footer?: string;
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
 * Render the digest as Telegram HTML. HTML (not MarkdownV2) because it only requires escaping
 * three characters — MarkdownV2 needs 18 escaped anywhere in the text, and paper titles are
 * full of exactly that punctuation.
 */
export function renderDigest(
  papers: ScoredPaper[],
  opts: RenderOptions,
  nearMisses: ScoredPaper[] = [],
): string {
  const sections: string[] = [`<b>${escapeHtml(opts.title)}</b>`];

  if (papers.length === 0 && nearMisses.length === 0) {
    sections.push("No hay artículos que superen el umbral esta vez.");
  } else {
    if (papers.length > 0) {
      sections.push([...papers].sort(byRelevance).map(renderItem).join("\n\n"));
    }
    if (nearMisses.length > 0) {
      sections.push(
        `<i>Cerca del umbral (semana floja):</i>\n\n` +
          [...nearMisses].sort(byRelevance).map(renderItem).join("\n\n"),
      );
    }
  }

  if (opts.footer) sections.push(`<i>${escapeHtml(opts.footer)}</i>`);
  return sections.join("\n\n");
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
