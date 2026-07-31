// Pre-scoring filters. Everything here runs BEFORE the Anthropic call, so each paper these
// drop is both noise removed from the digest and money not spent.

import type { Paper } from "./types.js";

export interface FilterResult {
  kept: Paper[];
  /** Papers removed, with a short human-readable reason (for logs and run metrics). */
  dropped: { paper: Paper; reason: string }[];
}

/**
 * Drop records whose publication type is editorial noise (errata, comments, retractions...).
 * Matching is case-insensitive and exact against the NLM type names in `excluded`.
 */
export function excludeByPublicationType(papers: Paper[], excluded: readonly string[]): FilterResult {
  const blocked = new Set(excluded.map((t) => t.toLowerCase()));
  const kept: Paper[] = [];
  const dropped: FilterResult["dropped"] = [];

  for (const paper of papers) {
    const hit = paper.publicationTypes.find((t) => blocked.has(t.toLowerCase()));
    if (hit) dropped.push({ paper, reason: hit });
    else kept.push(paper);
  }
  return { kept, dropped };
}

/**
 * Collapse records that share a DOI. PubMed indexes many papers twice — once ahead of print
 * and again with the final citation — and each version gets its own PMID, so the seen-ledger
 * cannot catch the duplicate. Prefers the copy that has an abstract (better scoring signal),
 * otherwise keeps the first. Papers without a DOI are always kept.
 */
export function dedupeByDoi(papers: Paper[]): FilterResult {
  const kept: Paper[] = [];
  const dropped: FilterResult["dropped"] = [];
  /** doi -> index in `kept`, so a better version can replace the one already accepted. */
  const seenAt = new Map<string, number>();

  for (const paper of papers) {
    if (!paper.doi) {
      kept.push(paper);
      continue;
    }
    const at = seenAt.get(paper.doi);
    if (at === undefined) {
      seenAt.set(paper.doi, kept.length);
      kept.push(paper);
      continue;
    }
    // Same DOI: keep whichever version carries an abstract, in place.
    const existing = kept[at]!;
    if (!existing.hasAbstract && paper.hasAbstract) {
      kept[at] = paper;
      dropped.push({ paper: existing, reason: `duplicate DOI ${paper.doi}` });
    } else {
      dropped.push({ paper, reason: `duplicate DOI ${paper.doi}` });
    }
  }
  return { kept, dropped };
}
