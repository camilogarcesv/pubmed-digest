// Shared builders so adding a field to Paper/Profile doesn't mean editing every test.

import type { Paper, ScoredPaper } from "../src/types.js";
import type { Profile } from "../src/profile.js";

export function makePaper(pmid: string, overrides: Partial<Paper> = {}): Paper {
  return {
    pmid,
    title: `Título ${pmid}`,
    abstract: "resumen",
    hasAbstract: true,
    authors: [{ lastName: "Doe", foreName: "Jane" }],
    journal: "Revista",
    pubDate: "2026",
    source: "",
    publicationTypes: [],
    meshTerms: [],
    keywords: [],
    ...overrides,
  };
}

export function makeScored(
  pmid: string,
  relevance: number,
  overrides: Partial<ScoredPaper> = {},
): ScoredPaper {
  return {
    ...makePaper(pmid),
    relevance,
    reason: `Razón ${pmid}`,
    ...overrides,
  };
}

export function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    description: "Perfil de prueba.",
    topics: [],
    must_have: [],
    nice_to_have: [],
    exclude: [],
    exemplar_papers: [],
    sources: { journals: [], queries: [] },
    ...overrides,
  };
}
