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
  /** Digital Object Identifier, when the record carries one. Used for links and de-duplication. */
  doi?: string;
  /** NLM publication types, e.g. ["Randomized Controlled Trial", "Journal Article"]. */
  publicationTypes: string[];
  /** MeSH descriptor names. Empty for records PubMed has not indexed yet (most fresh ones). */
  meshTerms: string[];
  /** Author-supplied keywords. */
  keywords: string[];
  /** e.g. "aheadofprint", "ppublish", "epublish". */
  publicationStatus?: string;
}

export interface ScoredPaper extends Paper {
  /** Integer 0..10. */
  relevance: number;
  /** One short sentence, in Spanish. */
  reason: string;
}
