import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { journalTerm, topicTerm, parseArticles } from "../src/pubmed.js";

const here = dirname(fileURLToPath(import.meta.url));
const sampleXml = readFileSync(resolve(here, "fixtures/efetch-sample.xml"), "utf8");

describe("term builders", () => {
  it("wraps a journal name with the [Journal] tag", () => {
    expect(journalTerm("Eur Radiol")).toBe('"Eur Radiol"[Journal]');
  });

  it("turns a multi-word topic into an AND of [tiab] terms", () => {
    expect(topicTerm("glioma MRI")).toBe('("glioma"[tiab] AND "MRI"[tiab])');
  });

  it("wraps a single-word topic in one [tiab] term", () => {
    expect(topicTerm("glioma")).toBe('"glioma"[tiab]');
  });

  it("passes through a query that already uses field tags or booleans", () => {
    const q = '("stroke"[tiab] AND "thrombectomy"[tiab])';
    expect(topicTerm(q)).toBe(q);
    expect(topicTerm("brain NOT tumor")).toBe("brain NOT tumor");
  });
});

describe("parseArticles", () => {
  const papers = parseArticles(sampleXml);

  it("parses every article in the set", () => {
    expect(papers).toHaveLength(2);
    expect(papers.map((p) => p.pmid)).toEqual(["40123456", "40123457"]);
  });

  it("joins labeled abstract sections keeping their labels", () => {
    const p = papers[0]!;
    expect(p.hasAbstract).toBe(true);
    expect(p.abstract).toContain("BACKGROUND:");
    expect(p.abstract).toContain("METHODS:");
    expect(p.abstract).toContain("RESULTS:");
    expect(p.abstract).toContain("MRI perfusion");
  });

  it("prefers the full journal title and formats the pub date", () => {
    const p = papers[0]!;
    expect(p.journal).toBe("AJNR. American Journal of Neuroradiology");
    expect(p.pubDate).toBe("2026 Jul 03");
    expect(p.title).toContain("Mechanical Thrombectomy");
  });

  it("extracts authors (forced to an array even when there is one)", () => {
    expect(papers[0]!.authors).toHaveLength(2);
    expect(papers[0]!.authors[0]).toEqual({ lastName: "Garcia", foreName: "Maria" });
    expect(papers[1]!.authors).toHaveLength(1);
    expect(papers[1]!.authors[0]).toEqual({ lastName: "Rossi", foreName: "Luca" });
  });

  it("marks epub-ahead-of-print records with no abstract", () => {
    const p = papers[1]!;
    expect(p.hasAbstract).toBe(false);
    expect(p.abstract).toBe("");
  });
});

describe("parseArticles entity decoding", () => {
  it("decodes numeric character references in titles, abstracts and authors", () => {
    const xml =
      '<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation>' +
      "<PMID Version=\"1\">1</PMID><Article><Journal><Title>Test J</Title></Journal>" +
      "<ArticleTitle>Glioma at 3&#x3b1; field</ArticleTitle>" +
      "<Abstract><AbstractText>Author Garc&#xed;a-Hidalgo studied it.</AbstractText></Abstract>" +
      "<AuthorList><Author><LastName>Garc&#xed;a</LastName><ForeName>Jos&#xe9;</ForeName></Author></AuthorList>" +
      "</Article></MedlineCitation></PubmedArticle></PubmedArticleSet>";
    const p = parseArticles(xml)[0]!;
    expect(p.title).toBe("Glioma at 3α field");
    expect(p.abstract).toContain("García-Hidalgo");
    expect(p.authors[0]).toEqual({ lastName: "García", foreName: "José" });
  });
});
