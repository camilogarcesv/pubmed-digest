import { describe, expect, it } from "vitest";
import { escapeHtml, renderDigestMessages, selectForDigest } from "../src/digest.js";
import { splitForTelegram } from "../src/deliver.js";
import { voteKeyboard } from "../src/feedback.js";
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

describe("renderDigestMessages", () => {
  it("emits header, one message per paper ranked descending, and a footer", () => {
    const messages = renderDigestMessages(
      [scored("111", 8), scored("222", 10, { doi: "10.1/xyz" })],
      { title: "Test", footer: "— 5 nuevos · ~$0.01" },
    );

    expect(messages).toHaveLength(4); // header + 2 papers + footer
    expect(messages[0]!.text).toBe("<b>Test</b>");
    // 222 (10) ranks above 111 (8)
    expect(messages[1]!.text).toContain("🔥 10/10");
    expect(messages[1]!.text).toContain('<a href="https://doi.org/10.1/xyz">DOI</a>');
    expect(messages[2]!.text).toContain("⭐ 8/10");
    expect(messages[2]!.text).toContain('<a href="https://pubmed.ncbi.nlm.nih.gov/111/">PubMed</a>');
    expect(messages[3]!.text).toBe("<i>— 5 nuevos · ~$0.01</i>");
    expect(messages[1]!.text).toContain("Doe Jane"); // single author, no "et al."
  });

  it("attaches a vote keyboard per paper only when withKeyboards is set", () => {
    const withK = renderDigestMessages([scored("111", 8)], { title: "T", withKeyboards: true });
    expect(withK[1]!.keyboard).toEqual(voteKeyboard("111"));
    expect(withK[0]!.keyboard).toBeUndefined(); // never on the header

    const without = renderDigestMessages([scored("111", 8)], { title: "T" }); // search mode
    expect(without[1]!.keyboard).toBeUndefined();
  });

  it("escapes HTML in titles and reasons so Telegram can parse the message", () => {
    const [, paper] = renderDigestMessages(
      [scored("1", 9, { title: "R&D of <flow diverters>", reason: "a > b & c" })],
      { title: "T" },
    );
    expect(paper!.text).toContain("R&amp;D of &lt;flow diverters&gt;");
    expect(paper!.text).toContain("a &gt; b &amp; c");
    expect(paper!.text).not.toContain("<flow");
  });

  it("labels the study type when the publication types say something useful", () => {
    const [, paper] = renderDigestMessages(
      [scored("1", 9, { publicationTypes: ["Journal Article", "Randomized Controlled Trial"] })],
      { title: "T" },
    );
    expect(paper!.text).toContain("Ensayo aleatorizado");
  });

  it("shows near misses after their own label, with keyboards too", () => {
    const messages = renderDigestMessages([scored("1", 8)], { title: "T", withKeyboards: true }, [
      scored("2", 6),
    ]);
    const texts = messages.map((m) => m.text);
    const labelAt = texts.findIndex((t) => t.includes("Cerca del umbral"));
    const keptAt = texts.findIndex((t) => t.includes("Título 1"));
    const nearAt = texts.findIndex((t) => t.includes("Título 2"));
    expect(keptAt).toBeLessThan(labelAt);
    expect(labelAt).toBeLessThan(nearAt);
    // near-miss votes are signal about where the bar sits: keyboard included
    expect(messages[nearAt]!.keyboard).toEqual(voteKeyboard("2"));
  });

  it("collapses the empty case into a single message", () => {
    const messages = renderDigestMessages([], { title: "Test", footer: "— 0" });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain("No hay artículos");
    expect(messages[0]!.text).toContain("— 0");
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

  it("never splits rendered digest content inside an HTML tag", () => {
    // 40 entries joined is well past the 4096 limit, so this really does split. Individual
    // messages stay short in production; this guards the fallback path.
    const papers = Array.from({ length: 40 }, (_, i) =>
      scored(String(i), 8, { doi: `10.1000/paper-${i}` }),
    );
    const joined = renderDigestMessages(papers, { title: "Largo" })
      .map((m) => m.text)
      .join("\n\n");
    const parts = splitForTelegram(joined, 4096);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      // Every '<' must be matched by a '>' after it: no chunk ends mid-tag.
      expect((part.match(/</g) ?? []).length).toBe((part.match(/>/g) ?? []).length);
      expect(part.endsWith("<")).toBe(false);
    }
  });
});
