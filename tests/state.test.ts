import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonFileStore, MemoryStore, type SeenEntry } from "../src/state.js";

function entry(pmid: string, overrides: Partial<SeenEntry> = {}): SeenEntry {
  return {
    pmid,
    title: `Título ${pmid}`,
    firstSeen: new Date().toISOString(),
    delivered: false,
    ...overrides,
  };
}

describe("JsonFileStore", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pubmed-state-"));
    path = join(dir, "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty when the file does not exist", async () => {
    const store = new JsonFileStore(path);
    await store.load();
    expect(store.size()).toBe(0);
    expect(store.has("1")).toBe(false);
  });

  it("persists recorded entries with their metadata and reloads them", async () => {
    const a = new JsonFileStore(path);
    await a.load();
    a.record([
      entry("100", { relevance: 9, delivered: true }),
      entry("200"),
      entry("200"), // upsert: same pmid replaces
    ]);
    expect(a.size()).toBe(2);
    await a.save();

    const b = new JsonFileStore(path);
    await b.load();
    expect(b.size()).toBe(2);
    expect(b.get("100")).toMatchObject({ title: "Título 100", relevance: 9, delivered: true });
    expect(b.get("200")!.relevance).toBeUndefined();
    expect(b.has("999")).toBe(false);
  });

  // The production ledger predates v2; the first run after the upgrade must keep deduping.
  it("migrates a v1 file (bare pmid list) preserving its age", async () => {
    writeFileSync(
      path,
      JSON.stringify({ seen: ["1", "2", "3"], updatedAt: "2026-07-18T03:25:13.004Z" }),
    );
    const store = new JsonFileStore(path);
    await store.load();

    expect(store.size()).toBe(3);
    expect(store.has("2")).toBe(true);
    // firstSeen inherits the file's updatedAt so pruning sees the real age.
    expect(store.get("1")!.firstSeen).toBe("2026-07-18T03:25:13.004Z");
    expect(store.get("1")!.title).toBe("");

    await store.save();
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(2);
    expect(Object.keys(onDisk.papers)).toEqual(["1", "2", "3"]);
  });

  it("prunes entries older than pruneDays on save, keeping recent ones", async () => {
    const store = new JsonFileStore(path, 30);
    await store.load();
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    store.record([entry("old", { firstSeen: old }), entry("fresh")]);
    await store.save();

    const reloaded = new JsonFileStore(path);
    await reloaded.load();
    expect(reloaded.has("old")).toBe(false);
    expect(reloaded.has("fresh")).toBe(true);
  });

  it("starts empty on corrupt JSON instead of crashing the run", async () => {
    writeFileSync(path, "{ not json");
    const store = new JsonFileStore(path);
    await store.load();
    expect(store.size()).toBe(0);
  });
});

describe("MemoryStore", () => {
  it("tracks entries without persistence", async () => {
    const store = new MemoryStore();
    await store.load();
    store.record([entry("1"), entry("2", { relevance: 7 })]);
    expect(store.has("1")).toBe(true);
    expect(store.get("2")!.relevance).toBe(7);
    expect(store.entries()).toHaveLength(2);
  });
});
