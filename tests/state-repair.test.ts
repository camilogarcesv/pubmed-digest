import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planLedgerRepair, repairLedgerFile } from "../src/state-repair.js";

function state() {
  return {
    version: 2 as const,
    updatedAt: "2026-09-01T00:00:00.000Z",
    papers: {
      repair: { title: "r", firstSeen: "2026-08-31T12:00:00Z", relevance: 0, delivered: false },
      delivered: { title: "d", firstSeen: "2026-08-31T12:00:00Z", relevance: 0, delivered: true },
      outside: { title: "o", firstSeen: "2026-08-30T23:59:59Z", relevance: 0, delivered: false },
      boundary: { title: "b", firstSeen: "2026-09-01T00:00:00Z", relevance: 0, delivered: false },
      scored: { title: "s", firstSeen: "2026-08-31T12:00:00Z", relevance: 4, delivered: false },
      unscored: { title: "u", firstSeen: "2026-08-31T12:00:00Z", delivered: false },
      future: {
        title: "f",
        firstSeen: "2026-08-31T12:00:00Z",
        relevance: 5,
        delivered: false,
        futureField: "preserve-me",
      },
    },
  };
}

const window = { from: "2026-08-31", to: "2026-09-01" };

describe("ledger repair", () => {
  it("selects only undelivered explicit zeros inside the half-open date window", () => {
    const plan = planLedgerRepair(state(), window);

    expect(plan.report.pmids).toEqual(["repair"]);
    expect(plan.report).toMatchObject({ mode: "dry-run", scanned: 7, matched: 1, retained: 6 });
    expect(plan.report.invalidFirstSeenPmids).toEqual([]);
    expect(plan.repaired.papers).not.toHaveProperty("repair");
    expect(plan.repaired.papers).toHaveProperty("delivered");
    expect(plan.repaired.papers).toHaveProperty("outside");
    expect(plan.repaired.papers).toHaveProperty("boundary");
    expect(plan.repaired.papers).toHaveProperty("unscored");
    expect(plan.repaired.papers.future).toHaveProperty("futureField", "preserve-me");
  });

  it("is dry-run by default and modifies no files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pubmed-repair-dry-"));
    const inputPath = join(dir, "state.json");
    const original = JSON.stringify(state(), null, 2) + "\n";
    await writeFile(inputPath, original);

    const result = await repairLedgerFile({ inputPath, ...window, backupDir: join(dir, "backups") });

    expect(result.report.mode).toBe("dry-run");
    expect(await readFile(inputPath, "utf8")).toBe(original);
    expect(await readdir(dir)).toEqual(["state.json"]);
  });

  it("backs up and reports before applying only the selected repair", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pubmed-repair-apply-"));
    const inputPath = join(dir, "state.json");
    const backupDir = join(dir, "backups");
    const original = JSON.stringify(state(), null, 2) + "\n";
    await writeFile(inputPath, original);

    const result = await repairLedgerFile({
      inputPath,
      backupDir,
      ...window,
      apply: true,
      now: new Date("2026-09-03T12:00:00.000Z"),
    });

    expect(await readFile(result.backupPath!, "utf8")).toBe(original);
    const writtenReport = JSON.parse(await readFile(result.reportPath!, "utf8"));
    expect(writtenReport).toEqual(result.report);
    const repaired = JSON.parse(await readFile(inputPath, "utf8"));
    expect(repaired.papers).not.toHaveProperty("repair");
    expect(Object.keys(repaired.papers)).toHaveLength(6);
    expect(repaired.papers.delivered.delivered).toBe(true);
    expect(repaired.updatedAt).toBe("2026-09-03T12:00:00.000Z");
  });

  it("rejects invalid windows and non-v2 ledgers", () => {
    expect(() => planLedgerRepair(state(), { from: "2026-02-30", to: "2026-03-01" })).toThrow(
      /valid calendar date/,
    );
    expect(() => planLedgerRepair({ seen: ["1"] }, window)).toThrow(/version 2/);
  });

  it("reports entries whose firstSeen cannot be date-filtered", () => {
    const input = state();
    input.papers.repair.firstSeen = "not-a-date";

    const plan = planLedgerRepair(input, window);

    expect(plan.report.pmids).toEqual([]);
    expect(plan.report.invalidFirstSeenPmids).toEqual(["repair"]);
  });
});
