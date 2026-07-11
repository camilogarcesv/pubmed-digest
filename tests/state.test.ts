import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonFileStore, MemoryStore } from "../src/state.js";

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

  it("persists added pmids and reloads them in a fresh instance", async () => {
    const a = new JsonFileStore(path);
    await a.load();
    a.add(["100", "200", "200"]); // duplicate ignored by the Set
    expect(a.size()).toBe(2);
    await a.save();

    const b = new JsonFileStore(path);
    await b.load();
    expect(b.size()).toBe(2);
    expect(b.has("100")).toBe(true);
    expect(b.has("200")).toBe(true);
    expect(b.has("999")).toBe(false);
  });
});

describe("MemoryStore", () => {
  it("tracks pmids without persistence", async () => {
    const store = new MemoryStore();
    await store.load();
    store.add(["1", "2"]);
    expect(store.has("1")).toBe(true);
    expect(store.size()).toBe(2);
  });
});
