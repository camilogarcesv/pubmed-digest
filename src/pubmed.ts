import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { Author, Paper } from "./types.js";
import { logger } from "./logger.js";
import { sleep } from "./util.js";

const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

// -------------------- Query term builders (pure, unit-tested) --------------------

export function journalTerm(journal: string): string {
  return `"${journal}"[Journal]`;
}

/**
 * Build a PubMed `term` for an ad-hoc topic. A plain phrase like "glioma MRI" becomes
 * ("glioma"[tiab] AND "MRI"[tiab]). A string that already looks like a PubMed query
 * (contains a [field] tag or a boolean operator) is passed through untouched.
 */
export function topicTerm(topic: string): string {
  const trimmed = topic.trim();
  if (/\[[a-z]+\]/i.test(trimmed) || /\b(AND|OR|NOT)\b/.test(trimmed)) return trimmed;
  const words = trimmed.split(/\s+/).filter(Boolean).map((w) => `"${w}"[tiab]`);
  if (words.length === 0) return trimmed;
  if (words.length === 1) return words[0]!;
  return `(${words.join(" AND ")})`;
}

// -------------------- XML parsing (pure, unit-tested) --------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  // Keep every value a string: preserves leading zeros in dates (Day "03") and PMIDs,
  // and avoids surprising numeric coercion in a text-scoring pipeline.
  parseTagValue: false,
  parseAttributeValue: false,
  // Decode named HTML entities (e.g. &alpha;); numeric refs (&#xed;) are handled in decodeEntities.
  htmlEntities: true,
  // Force these paths to always be arrays so we never branch on single-vs-array.
  isArray: (name) => name === "PubmedArticle" || name === "Author" || name === "AbstractText",
});

/**
 * Decode numeric XML/HTML character references (&#233; / &#xed;) and the five predefined
 * XML entities. PubMed abstracts and author names are full of numeric refs (accents, Greek
 * letters) that the parser leaves as literal text; without this they reach the model and the
 * digest looking broken.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => codePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function codePoint(n: number): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/** Recursively collect all text from a fast-xml-parser node (skips @_ attributes). */
function collectText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return decodeEntities(node);
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  if (typeof node === "object") {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.startsWith("@_")) continue;
      parts.push(collectText(value));
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

function extractAbstract(abstractNode: unknown): string {
  if (!abstractNode || typeof abstractNode !== "object") return "";
  const texts = (abstractNode as Record<string, unknown>).AbstractText;
  if (!Array.isArray(texts)) return collectText(abstractNode).trim();

  const parts: string[] = [];
  for (const t of texts) {
    let label: unknown;
    if (t && typeof t === "object") {
      const o = t as Record<string, unknown>;
      label = o["@_Label"] ?? o["@_NlmCategory"];
    }
    const text = collectText(t).trim();
    if (!text) continue;
    parts.push(label ? `${String(label).toUpperCase()}: ${text}` : text);
  }
  return parts.join("\n").trim();
}

function extractAuthors(authorList: unknown): Author[] {
  if (!authorList || typeof authorList !== "object") return [];
  const authors = (authorList as Record<string, unknown>).Author;
  if (!Array.isArray(authors)) return [];

  const out: Author[] = [];
  for (const au of authors) {
    if (!au || typeof au !== "object") continue;
    const o = au as Record<string, unknown>;
    const lastName = collectText(o.LastName).trim() || undefined;
    const foreName = collectText(o.ForeName).trim() || collectText(o.Initials).trim() || undefined;
    if (lastName || foreName) out.push({ lastName, foreName });
  }
  return out;
}

function extractPubDate(article: Record<string, unknown>): string {
  const journal = article.Journal as Record<string, unknown> | undefined;
  const issue = journal?.JournalIssue as Record<string, unknown> | undefined;
  const pd = issue?.PubDate as Record<string, unknown> | undefined;
  if (pd) {
    const medline = collectText(pd.MedlineDate).trim();
    if (medline) return medline;
    const parts = [collectText(pd.Year), collectText(pd.Month), collectText(pd.Day)]
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) return parts.join(" ");
  }
  const ad = article.ArticleDate as Record<string, unknown> | undefined;
  if (ad) {
    const parts = [collectText(ad.Year), collectText(ad.Month), collectText(ad.Day)]
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) return parts.join("-");
  }
  return "";
}

function mapArticle(node: unknown): Paper | null {
  if (!node || typeof node !== "object") return null;
  const citation = (node as Record<string, unknown>).MedlineCitation as
    | Record<string, unknown>
    | undefined;
  const article = citation?.Article as Record<string, unknown> | undefined;
  if (!citation || !article) return null;

  const pmid = collectText(citation.PMID).trim();
  if (!pmid) return null;

  const title = collectText(article.ArticleTitle).trim() || "(sin título)";
  const abstract = extractAbstract(article.Abstract);
  const hasAbstract = abstract.length > 0;
  const authors = extractAuthors(article.AuthorList);
  const journalNode = article.Journal as Record<string, unknown> | undefined;
  const journal =
    collectText(journalNode?.Title).trim() ||
    collectText(journalNode?.ISOAbbreviation).trim() ||
    "(revista desconocida)";
  const pubDate = extractPubDate(article);

  return { pmid, title, abstract, hasAbstract, authors, journal, pubDate, source: "" };
}

/** Parse an efetch XML document into Paper records. */
export function parseArticles(xml: string): Paper[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const set = doc.PubmedArticleSet as Record<string, unknown> | undefined;
  if (!set) return [];
  const articles = set.PubmedArticle;
  if (!Array.isArray(articles)) return [];

  const papers: Paper[] = [];
  for (const a of articles) {
    const paper = mapArticle(a);
    if (paper) papers.push(paper);
  }
  return papers;
}

// -------------------- HTTP client (throttle + backoff) --------------------

const ESearchResponseSchema = z.object({
  esearchresult: z.object({
    idlist: z.array(z.string()).default([]),
    count: z.string().optional(),
    ERROR: z.string().optional(),
  }),
});

export interface PubMedClientOptions {
  email?: string;
  apiKey?: string;
  toolName?: string;
  /** Minimum ms between requests. Defaults to 350 (<3/s) without a key, 120 (<10/s) with one. */
  minIntervalMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export interface ESearchOptions {
  reldate: number;
  retmax?: number;
  datetype?: string;
}

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 16000);
  return base + Math.floor(Math.random() * 250);
}

export class PubMedClient {
  private readonly email?: string;
  private readonly apiKey?: string;
  private readonly toolName: string;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private lastRequestAt = 0;

  constructor(opts: PubMedClientOptions = {}) {
    this.email = opts.email;
    this.apiKey = opts.apiKey;
    this.toolName = opts.toolName ?? "pubmed-digest";
    this.minIntervalMs = opts.minIntervalMs ?? (opts.apiKey ? 120 : 350);
    this.maxRetries = opts.maxRetries ?? 4;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private commonParams(): Record<string, string> {
    const params: Record<string, string> = { tool: this.toolName };
    if (this.email) params.email = this.email;
    if (this.apiKey) params.api_key = this.apiKey;
    return params;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private async request(url: string): Promise<Response> {
    let attempt = 0;
    for (;;) {
      await this.throttle();
      let res: Response;
      try {
        res = await this.fetchImpl(url);
      } catch (err) {
        if (attempt >= this.maxRetries) throw err;
        const delay = backoffMs(attempt);
        logger.warn("eutils network error, retrying", { attempt, delay, error: String(err) });
        await sleep(delay);
        attempt++;
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.maxRetries) {
          throw new Error(`E-utilities request failed after ${attempt} retries: HTTP ${res.status}`);
        }
        const retryAfter = Number(res.headers.get("retry-after"));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
        logger.warn("eutils throttled/5xx, backing off", { status: res.status, attempt, delay });
        await sleep(delay);
        attempt++;
        continue;
      }

      if (!res.ok) throw new Error(`E-utilities request failed: HTTP ${res.status}`);
      return res;
    }
  }

  /** Run esearch and return the list of PMIDs. */
  async esearch(term: string, opts: ESearchOptions): Promise<string[]> {
    const params = new URLSearchParams({
      db: "pubmed",
      term,
      retmode: "json",
      retmax: String(opts.retmax ?? 100),
      datetype: opts.datetype ?? "edat",
      reldate: String(opts.reldate),
      ...this.commonParams(),
    });
    const url = `${EUTILS_BASE}/esearch.fcgi?${params.toString()}`;
    const res = await this.request(url);
    const json: unknown = await res.json();
    const parsed = ESearchResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Unexpected esearch response shape: ${parsed.error.message}`);
    }
    if (parsed.data.esearchresult.ERROR) {
      throw new Error(
        `PubMed esearch error for term "${term}": ${parsed.data.esearchresult.ERROR}`,
      );
    }
    return parsed.data.esearchresult.idlist;
  }

  /** Run efetch for a set of PMIDs and return parsed Paper records. */
  async efetch(pmids: string[]): Promise<Paper[]> {
    if (pmids.length === 0) return [];
    const params = new URLSearchParams({
      db: "pubmed",
      id: pmids.join(","),
      retmode: "xml",
      rettype: "abstract",
      ...this.commonParams(),
    });
    const url = `${EUTILS_BASE}/efetch.fcgi?${params.toString()}`;
    const res = await this.request(url);
    const xml = await res.text();
    return parseArticles(xml);
  }
}
