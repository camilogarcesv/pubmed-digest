export interface Author {
  lastName?: string;
  foreName?: string;
}

/** A PubMed record after parsing efetch XML. */
export interface Paper {
  pmid: string;
  title: string;
  /** Joined abstract text (labeled sections kept), or "" when the record has none. */
  abstract: string;
  hasAbstract: boolean;
  authors: Author[];
  journal: string;
  /** Best-effort human-readable publication date, e.g. "2026 Jul 03". */
  pubDate: string;
  /** Which configured journal/topic surfaced this paper (for logging only). */
  source: string;
}

export interface ScoredPaper extends Paper {
  /** Integer 0..10. */
  relevance: number;
  /** One short sentence, in Spanish. */
  reason: string;
}
