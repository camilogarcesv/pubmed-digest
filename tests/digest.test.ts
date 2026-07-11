import { describe, expect, it } from "vitest";
import { filterByThreshold, renderDigest } from "../src/digest.js";
import { splitForTelegram } from "../src/deliver.js";
import type { ScoredPaper } from "../src/types.js";

function scored(pmid: string, relevance: number, overrides: Partial<ScoredPaper> = {}): ScoredPaper {
  return {
    pmid,
    title: `Título ${pmid}`,
    abstract: "",
    hasAbstract: false,
    authors: [{ lastName: "Doe", foreName: "Jane" }],
    journal: "Revista",
    pubDate: "2026",
    source: "",
    relevance,
    reason: `Razón ${pmid}`,
    ...overrides,
  };
}

describe("filterByThreshold", () => {
  it("keeps only papers at/above the threshold, ranked descending", () => {
    const kept = filterByThreshold([scored("a", 6), scored("b", 9), scored("c", 7)], 7);
    expect(kept.map((p) => p.pmid)).toEqual(["b", "c"]);
  });

  it("returns nothing when all papers are below the threshold", () => {
    expect(filterByThreshold([scored("a", 3), scored("b", 5)], 7)).toHaveLength(0);
  });
});

describe("renderDigest", () => {
  it("renders a ranked plain-text digest with pubmed links", () => {
    const text = renderDigest([scored("111", 8), scored("222", 10)], { title: "Test" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Test");
    // 222 (10) should rank above 111 (8)
    expect(text.indexOf("222")).toBeLessThan(text.indexOf("111"));
    expect(text).toContain("https://pubmed.ncbi.nlm.nih.gov/222/");
    expect(text).toContain("⭐ 10/10");
    expect(text).toContain("Doe Jane"); // single author, no "et al."
  });

  it("handles the empty case", () => {
    const text = renderDigest([], { title: "Test" });
    expect(text).toContain("No hay artículos");
  });
});

describe("splitForTelegram", () => {
  it("keeps short text as a single message", () => {
    expect(splitForTelegram("hello", 4096)).toEqual(["hello"]);
  });

  it("splits on newlines and respects the limit", () => {
    const line = "x".repeat(100);
    const text = Array.from({ length: 60 }, () => line).join("\n"); // ~6060 chars
    const parts = splitForTelegram(text, 4096);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    // no content lost
    expect(parts.join("\n").replace(/\n/g, "")).toBe(text.replace(/\n/g, ""));
  });

  it("hard-splits a single over-long line", () => {
    const parts = splitForTelegram("y".repeat(10000), 4096);
    expect(parts).toHaveLength(3);
    expect(parts[0]!.length).toBe(4096);
  });
});
