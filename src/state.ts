import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { logger } from "./logger.js";

/** Seen-PMID store. Kept behind an interface so it can be swapped for a DB later. */
export interface SeenStore {
  load(): Promise<void>;
  has(pmid: string): boolean;
  add(pmids: string[]): void;
  size(): number;
  save(): Promise<void>;
}

const StateSchema = z.object({
  seen: z.array(z.string()).default([]),
  updatedAt: z.string().optional(),
});

/** JSON-file-backed store (state.json). */
export class JsonFileStore implements SeenStore {
  private seen = new Set<string>();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.seen = new Set();
        return;
      }
      throw err;
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      logger.warn("state file is not valid JSON, starting empty", { path: this.path });
      this.seen = new Set();
      return;
    }

    const parsed = StateSchema.safeParse(data);
    if (!parsed.success) {
      logger.warn("state file failed validation, starting empty", { path: this.path });
      this.seen = new Set();
      return;
    }
    this.seen = new Set(parsed.data.seen);
  }

  has(pmid: string): boolean {
    return this.seen.has(pmid);
  }

  add(pmids: string[]): void {
    for (const p of pmids) this.seen.add(p);
  }

  size(): number {
    return this.seen.size;
  }

  async save(): Promise<void> {
    const data = { seen: [...this.seen].sort(), updatedAt: new Date().toISOString() };
    await writeFile(this.path, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
}

/** In-memory store — used by `search` (which never dedupes/persists) and by tests. */
export class MemoryStore implements SeenStore {
  private seen = new Set<string>();
  async load(): Promise<void> {}
  has(pmid: string): boolean {
    return this.seen.has(pmid);
  }
  add(pmids: string[]): void {
    for (const p of pmids) this.seen.add(p);
  }
  size(): number {
    return this.seen.size;
  }
  async save(): Promise<void> {}
}
