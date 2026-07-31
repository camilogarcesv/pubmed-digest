import { describe, expect, it } from "vitest";
import { escapeHtml, renderDigest, selectForDigest } from "../src/digest.js";
import { splitForTelegram } from "../src/deliver.js";
import { makeScored as scored } from "./helpers.js";

describe("selectForDigest", () => {
  const opts = { threshold: 7, max: 3, min: 2 };

  it("keeps papers above the threshold, capped at max", () => {
    const papers = [scored("a", 10), scored("b", 9), scored("c", 8), scored("d", 7)];
    const { kept, nearMisses } = selectForDigest(papers, opts);
    expect(kept.map((p) => p.pmid)).toEqual(["a", "b", "c"]);
    expect(nearMisses).toHaveLength(0);
  });

  it("tops up with near misses when too few clear the threshold", () => {
    const papers = [scored("a", 8), scored("b", 6), scored("c", 5)];
    const { kept, nearMisses } = selectForDigest(papers, opts);
    expect(kept.map((p) => p.pmid)).toEqual(["a"]);
    expect(nearMisses.map((p) => p.pmid)).toEqual(["b"]); // only 1 needed to reach min=2
  });

  it("never pulls in papers far below the threshold", () => {
    const papers = [scored("a", 2), scored("b", 0)];
    const { kept, nearMisses } = selectForDigest(papers, opts);
    expect(kept).toHaveLength(0);
    expect(nearMisses).toHaveLength(0); // threshold 7 - margin 2 = floor of 5
  });
});

describe("renderDigest", () => {
  it("renders a ranked HTML digest with PubMed and DOI links", () => {
    const text = renderDigest([scored("111", 8), scored("222", 10, { doi: "10.1/xyz" })], {
      title: "Test",
    });
    expect(text.startsWith("<b>Test</b>")).toBe(true);
    // 222 (10) should rank above 111 (8)
    expect(text.indexOf("222")).toBeLessThan(text.indexOf("111"));
    expect(text).toContain('<a href="https://pubmed.ncbi.nlm.nih.gov/222/">PubMed</a>');
    expect(text).toContain('<a href="https://doi.org/10.1/xyz">DOI</a>');
    expect(text).toContain("🔥 10/10"); // 9+ gets the hot badge
    expect(text).toContain("⭐ 8/10");
    expect(text).toContain("Doe Jane"); // single author, no "et al."
  });

  it("escapes HTML in titles and reasons so Telegram can parse the message", () => {
    const text = renderDigest(
      [scored("1", 9, { title: "R&D of <flow diverters>", reason: "a > b & c" })],
      { title: "T" },
    );
    expect(text).toContain("R&amp;D of &lt;flow diverters&gt;");
    expect(text).toContain("a &gt; b &amp; c");
    expect(text).not.toContain("<flow");
  });

  it("labels the study type when the publication types say something useful", () => {
    const text = renderDigest(
      [scored("1", 9, { publicationTypes: ["Journal Article", "Randomized Controlled Trial"] })],
      { title: "T" },
    );
    expect(text).toContain("Ensayo aleatorizado");
  });

  it("shows near misses in their own labeled section", () => {
    const text = renderDigest([scored("1", 8)], { title: "T" }, [scored("2", 6)]);
    expect(text).toContain("Cerca del umbral");
    expect(text.indexOf("Cerca del umbral")).toBeGreaterThan(text.indexOf("Título 1"));
  });

  it("appends the run footer when given one", () => {
    const text = renderDigest([scored("1", 8)], { title: "T", footer: "— 5 nuevos · ~$0.01" });
    expect(text).toContain("<i>— 5 nuevos · ~$0.01</i>");
  });

  it("handles the empty case", () => {
    expect(renderDigest([], { title: "Test" })).toContain("No hay artículos");
  });
});

describe("escapeHtml", () => {
  it("escapes exactly the three characters Telegram HTML needs", () => {
    expect(escapeHtml(`a & b < c > d "e" 'f'`)).toBe(`a &amp; b &lt; c &gt; d "e" 'f'`);
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

  it("never splits a rendered digest inside an HTML tag", () => {
    // 40 entries is well past the 4096 limit, so this really does split.
    const papers = Array.from({ length: 40 }, (_, i) =>
      scored(String(i), 8, { doi: `10.1000/paper-${i}` }),
    );
    const parts = splitForTelegram(renderDigest(papers, { title: "Largo" }), 4096);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      // Every '<' must be matched by a '>' after it: no chunk ends mid-tag.
      expect((part.match(/</g) ?? []).length).toBe((part.match(/>/g) ?? []).length);
      expect(part.endsWith("<")).toBe(false);
    }
  });
});
