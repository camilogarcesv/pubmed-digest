import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectFromResults } from "../src/pipeline.js";
import { RunMetrics } from "../src/metrics.js";
import { logger, redactFields } from "../src/logger.js";
import { measureLag } from "../src/operations/d1-lag.js";
import type { DigestBackend } from "../src/backend/client.js";

describe("d1:lag", () => {
  it("distinguishes conflicts and D1-only votes from updates, and refuses duplicate owner votes", async () => {
    const backend = {
      context: async () => ({ userId: "u" }),
      evalContext: async () => [
        { pmid: "1", value: 1, votedAt: "2026-09-20T00:00:00.000Z" },
        { pmid: "2", value: 1, votedAt: "2026-09-20T00:00:00.000Z" },
        { pmid: "3", value: 1, votedAt: "2026-09-20T00:00:00.000Z" },
      ],
    } as unknown as DigestBackend;
    const owner = { slug: "owner", chatId: "100" };
    const votes = [
      { pmid: "1", value: 0 as const, chatId: "100", votedAt: "2026-09-20T00:00:00.000Z" },
      { pmid: "2", value: 1 as const, chatId: "100", votedAt: "2026-09-19T00:00:00.000Z" },
    ];
    expect(await measureLag(backend, owner, [], votes)).toMatchObject({
      kvVotesChangedInD1: 0, kvVotesConflictingWithD1: 2, d1VotesMissingInKV: 1,
    });
    await expect(measureLag(backend, owner, [], [...votes, votes[0]!])).rejects.toThrow("Duplicate owner vote");
  });

  it("fails privately on an invalid ledger or a mapping for another user, before accessing the network", () => {
    const dir = mkdtempSync(join(tmpdir(), "lag-cli-"));
    try {
      const state = join(dir, "state.json");
      writeFileSync(state, JSON.stringify({ version: 2, papers: { "98765432": { title: "private title" } } }));
      for (const slug of ["owner", "other"]) {
        const result = spawnSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), resolve("src/operations/d1-lag.ts"), "--user", slug, "--state", state], {
          cwd: dir, encoding: "utf8", timeout: 10_000,
          env: { ...process.env, LEGACY_VOTE_OWNER: JSON.stringify({ slug: "owner", chatId: "100" }) },
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr.trim()).toBe('{"error":"d1_lag_failed"}');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("counts ledger articles and votes the D1 copy lacks or holds in an older form", async () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const known = new Set(["1", "2"]);
    const backend = {
      context: async () => ({ userId }),
      seen: async (pairs: { userId: string; pmid: string }[]) => pairs.map(p => p.userId === userId && known.has(p.pmid)),
      evalContext: async () => [
        { pmid: "1", title: "", value: 1, score: 9, votedAt: "2026-09-20T00:00:00.000Z" },
        { pmid: "2", title: "", value: 0, score: 5, votedAt: "2026-09-20T00:00:00.000Z" },
      ],
    } as unknown as DigestBackend;
    const vote = (pmid: string, value: 0 | 1, votedAt: string, chatId = "100") => ({ pmid, value, votedAt, chatId });
    expect(await measureLag(backend, { slug: "owner", chatId: "100" }, ["1", "2", "3", "4"], [
      vote("1", 1, "2026-09-20T00:00:00.000Z"), // unchanged
      vote("2", 1, "2026-09-21T00:00:00.000Z"), // re-voted after the copy
      vote("3", 1, "2026-09-21T00:00:00.000Z"), // owner vote not in D1
      vote("1", 0, "2026-09-22T00:00:00.000Z", "200"), // foreign update must not replace the owner vote
    ])).toEqual({
      ledgerArticles: 4, ledgerMissingInD1: 2, kvChats: 2, kvVotesOtherChats: 1, kvVotedArticles: 3, d1VotedArticles: 2, kvVotesMissingInD1: 1, kvVotesChangedInD1: 1, kvVotesConflictingWithD1: 0, d1VotesMissingInKV: 0,
    });
    expect(await measureLag(backend, { slug: "owner", chatId: "100" }, [], [])).toMatchObject({ ledgerArticles: 0, ledgerMissingInD1: 0, kvChats: 0 });
  });
});

describe("private logs", () => {
  it.each([true, false])("does not expose backend error text in the real D1 CLI (Actions=%s)", (actions) => {
    const dir = mkdtempSync(join(tmpdir(), "d1-cli-"));
    try {
      const preload = join(dir, "fetch.mjs");
      writeFileSync(preload, `const {logger} = await import(${JSON.stringify(pathToFileURL(resolve("src/logger.ts")).href)});
globalThis.fetch = async () => {
  logger.info("dropped before scoring", {pmid:"98765432", reason:"duplicate DOI: 10.123/private"});
  return Response.json({error:{code:"private PMID 98765432"}}, {status:400});
};`);
      const result = spawnSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), "--import", preload, resolve("src/index.ts"), "digest", "--backend", "d1", "--dry-run", "--user", "owner", ...(actions ? [] : ["--counts-only"])], {
        cwd: dir, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, ANTHROPIC_API_KEY: "test", DIGEST_SERVICE_SECRET: "s".repeat(64), DIGEST_API_ORIGIN: "https://example.test", GITHUB_ACTIONS: String(actions), GITHUB_STEP_SUMMARY: "" },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('"msg":"fatal"');
      expect(result.stderr).not.toMatch(/98765432|private PMID|10.123\/private/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("names sources by position and hides upstream text, including nested quotes", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const results = new Map<string, Error | { ids: string[]; count: number }>([
      ["t1", new Error('PubMed esearch error for term "journal AND \"private query\"": private query is invalid')], ["t2", { ids: ["9"], count: 1 }],
    ]);
    collectFromResults(new RunMetrics(), [{ label: "private query", term: "t1" }, { label: "Private Journal", term: "t2" }], results, () => false, { privateSources: true });
    const out = write.mock.calls.map(c => String(c[0])).join("");
    write.mockRestore();
    expect(out).toContain('"source":"source 1"');
    expect(out).toContain('"source":"source 2"');
    expect(out).not.toMatch(/private query|Private Journal/);
  });

  it("drops redacted fields from every later record", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    redactFields("secretField");
    logger.warn("x", { secretField: "1234", kept: 1 });
    const out = String(write.mock.calls[0]![0]);
    write.mockRestore();
    expect(JSON.parse(out)).toMatchObject({ msg: "x", kept: 1 });
    expect(out).not.toContain("secretField");
  });
});
