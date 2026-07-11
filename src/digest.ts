import type { ScoredPaper } from "./types.js";

export interface RenderOptions {
  title: string;
}

/** Keep papers at or above the threshold, ranked highest-first. */
export function filterByThreshold(papers: ScoredPaper[], threshold: number): ScoredPaper[] {
  return papers
    .filter((p) => p.relevance >= threshold)
    .sort((a, b) => b.relevance - a.relevance);
}

/** Render a plain-text digest (no MarkdownV2 — titles are full of punctuation). */
export function renderDigest(papers: ScoredPaper[], opts: RenderOptions): string {
  if (papers.length === 0) {
    return `${opts.title}\n\nNo hay artículos que superen el umbral esta vez.`;
  }
  const ranked = [...papers].sort((a, b) => b.relevance - a.relevance);
  const items = ranked.map((p) => {
    const meta = [firstAuthorEtAl(p), p.journal, p.pubDate].filter(Boolean).join(" · ");
    return [
      `⭐ ${p.relevance}/10 — ${p.title}`,
      meta,
      `→ ${p.reason}`,
      `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return `${opts.title}\n\n${items.join("\n\n")}`;
}

function firstAuthorEtAl(p: ScoredPaper): string {
  const a = p.authors[0];
  if (!a) return "";
  const name = [a.lastName, a.foreName].filter(Boolean).join(" ");
  return p.authors.length > 1 ? `${name} et al.` : name;
}
