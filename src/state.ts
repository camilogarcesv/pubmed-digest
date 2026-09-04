import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { logger } from "./logger.js";

/**
 * What the ledger remembers about a paper. v1 stored bare PMIDs; that was a dead end the
 * moment votes existed — the eval harness and the dynamic exemplars both need to join a vote
 * (which only carries a pmid) back to a title and a score without re-fetching PubMed.
 */
export interface SeenEntry {
  pmid: string;
  title: string;
  /** ISO date of the run that first considered this paper. Basis for pruning. */
  firstSeen: string;
  /** Score from the run that considered it. Absent for migrated-v1 and prefiltered papers. */
  relevance?: number;
  /** Whether it made the digest. */
  delivered: boolean;
}

/** Seen-paper store. Kept behind an interface so it can be swapped for a DB later. */
export interface SeenStore {
  load(): Promise<void>;
  has(pmid: string): boolean;
  /** Upsert entries for this run's papers. Replaces the v1 `add(pmids)`. */
  record(entries: SeenEntry[]): void;
  get(pmid: string): SeenEntry | undefined;
  entries(): SeenEntry[];
  size(): number;
  save(): Promise<void>;
}

const EntrySchema = z.object({
  title: z.string().default(""),
  firstSeen: z.string(),
  relevance: z.number().int().min(0).max(10).optional(),
  delivered: z.boolean().default(false),
}).passthrough();

export const StateV2Schema = z.object({
  version: z.literal(2),
  papers: z.record(z.string(), EntrySchema),
  updatedAt: z.string().optional(),
}).passthrough();

export type StateV2 = z.infer<typeof StateV2Schema>;

/** The original format: a bare PMID list. Still accepted on read, migrated on the fly. */
const StateV1Schema = z.object({
  seen: z.array(z.string()).default([]),
  updatedAt: z.string().optional(),
});

/** JSON-file-backed store (state.json). */
export class JsonFileStore implements SeenStore {
  private papers = new Map<string, SeenEntry>();

  constructor(
    private readonly path: string,
    /** Entries older than this many days are dropped on save. 0 disables pruning. */
    private readonly pruneDays: number = 0,
  ) {}

  async load(): Promise<void> {
    this.papers = new Map();
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      logger.warn("state file is not valid JSON, starting empty", { path: this.path });
      return;
    }

    const v2 = StateV2Schema.safeParse(data);
    if (v2.success) {
      for (const [pmid, e] of Object.entries(v2.data.papers)) {
        this.papers.set(pmid, { ...e, pmid });
      }
      return;
    }

    // v1 migration: bare PMIDs become entries dated by the file's own updatedAt, so pruning
    // treats them by their real age rather than resetting the clock.
    const v1 = StateV1Schema.safeParse(data);
    if (v1.success && v1.data.seen.length > 0) {
      const firstSeen = v1.data.updatedAt ?? new Date().toISOString();
      for (const pmid of v1.data.seen) {
        this.papers.set(pmid, { pmid, title: "", firstSeen, delivered: false });
      }
      logger.info("migrated v1 state to v2", { entries: this.papers.size });
      return;
    }

    logger.warn("state file failed validation, starting empty", { path: this.path });
  }

  has(pmid: string): boolean {
    return this.papers.has(pmid);
  }

  record(entries: SeenEntry[]): void {
    for (const e of entries) this.papers.set(e.pmid, e);
  }

  get(pmid: string): SeenEntry | undefined {
    return this.papers.get(pmid);
  }

  entries(): SeenEntry[] {
    return [...this.papers.values()];
  }

  size(): number {
    return this.papers.size;
  }

  async save(): Promise<void> {
    if (this.pruneDays > 0) {
      const cutoff = Date.now() - this.pruneDays * 24 * 60 * 60 * 1000;
      let pruned = 0;
      for (const [pmid, e] of this.papers) {
        const t = Date.parse(e.firstSeen);
        if (Number.isFinite(t) && t < cutoff) {
          this.papers.delete(pmid);
          pruned++;
        }
      }
      if (pruned > 0) logger.info("pruned old ledger entries", { pruned, days: this.pruneDays });
    }

    const papers: Record<string, Omit<SeenEntry, "pmid">> = {};
    for (const pmid of [...this.papers.keys()].sort()) {
      const { pmid: _, ...rest } = this.papers.get(pmid)!;
      papers[pmid] = rest;
    }
    const data = { version: 2 as const, papers, updatedAt: new Date().toISOString() };
    await writeFile(this.path, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
}

/** In-memory store — used by tests. */
export class MemoryStore implements SeenStore {
  private papers = new Map<string, SeenEntry>();
  async load(): Promise<void> {}
  has(pmid: string): boolean {
    return this.papers.has(pmid);
  }
  record(entries: SeenEntry[]): void {
    for (const e of entries) this.papers.set(e.pmid, e);
  }
  get(pmid: string): SeenEntry | undefined {
    return this.papers.get(pmid);
  }
  entries(): SeenEntry[] {
    return [...this.papers.values()];
  }
  size(): number {
    return this.papers.size;
  }
  async save(): Promise<void> {}
}
