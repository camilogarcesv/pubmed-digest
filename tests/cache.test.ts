import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCache, saveCache, type CacheSnapshot } from "../src/cache.js";

const snap: CacheSnapshot = {
  version: 1,
  command: "digest",
  createdAt: "2026-07-12T00:00:00Z",
  model: "claude-haiku-4-5",
  papers: [
    {
      pmid: "1",
      title: "t",
      abstract: "",
      hasAbstract: false,
      authors: [{ lastName: "Doe", foreName: "Jane" }],
      journal: "J",
      pubDate: "2026",
      source: "",
    },
  ],
  scored: [
    {
      pmid: "1",
      title: "t",
      abstract: "",
      hasAbstract: false,
      authors: [{ lastName: "Doe", foreName: "Jane" }],
      journal: "J",
      pubDate: "2026",
      source: "",
      relevance: 8,
      reason: "r",
    },
  ],
};

describe("cache", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pubmed-cache-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a snapshot, creating parent dirs", async () => {
    const path = join(dir, "nested", "digest.json"); // parent doesn't exist yet
    await saveCache(path, snap);
    const loaded = await loadCache(path);
    expect(loaded.scored[0]!.relevance).toBe(8);
    expect(loaded.papers[0]!.pmid).toBe("1");
    expect(loaded.command).toBe("digest");
  });

  it("throws a helpful error when the cache is missing", async () => {
    await expect(loadCache(join(dir, "nope.json"))).rejects.toThrow(/No cache/);
  });

  it("rejects invalid JSON", async () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    await expect(loadCache(bad)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects a schema-invalid snapshot", async () => {
    const bad = join(dir, "bad2.json");
    writeFileSync(bad, JSON.stringify({ version: 2 }));
    await expect(loadCache(bad)).rejects.toThrow(/validation/);
  });
});
