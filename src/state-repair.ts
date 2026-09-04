import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { StateV2Schema, type StateV2 } from "./state.js";

export const DEFAULT_REPAIR_FROM = "2026-08-31";
export const DEFAULT_REPAIR_TO = "2026-09-01";

export interface RepairWindow {
  /** Inclusive UTC calendar date, YYYY-MM-DD. */
  from: string;
  /** Exclusive UTC calendar date, YYYY-MM-DD. */
  to: string;
}

export interface LedgerRepairReport {
  mode: "dry-run" | "apply";
  criteria: {
    fromInclusive: string;
    toExclusive: string;
    relevance: 0;
    delivered: false;
  };
  scanned: number;
  matched: number;
  retained: number;
  pmids: string[];
  invalidFirstSeenPmids: string[];
}

export interface LedgerRepairPlan {
  report: LedgerRepairReport;
  repaired: StateV2;
}

export interface RepairFileOptions extends RepairWindow {
  inputPath: string;
  apply?: boolean;
  backupDir?: string;
  now?: Date;
}

export interface RepairFileResult extends LedgerRepairPlan {
  backupPath?: string;
  reportPath?: string;
}

function utcBoundary(date: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${label} must use YYYY-MM-DD (received ${JSON.stringify(date)}).`);
  }
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    throw new Error(`${label} is not a valid calendar date: ${date}.`);
  }
  return timestamp;
}

/** Pure selection step: only zero-scored, undelivered entries inside the requested window. */
export function planLedgerRepair(
  input: unknown,
  window: RepairWindow,
  mode: "dry-run" | "apply" = "dry-run",
): LedgerRepairPlan {
  const parsed = StateV2Schema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `Ledger repair requires a valid version 2 state file: ${parsed.error.message}`,
    );
  }
  const from = utcBoundary(window.from, "--from");
  const to = utcBoundary(window.to, "--to");
  if (from >= to) throw new Error("--from must be earlier than --to.");

  const invalidFirstSeenPmids = Object.entries(parsed.data.papers)
    .filter(([, entry]) => !Number.isFinite(Date.parse(entry.firstSeen)))
    .map(([pmid]) => pmid)
    .sort();
  const pmids = Object.entries(parsed.data.papers)
    .filter(([, entry]) => {
      const firstSeen = Date.parse(entry.firstSeen);
      return (
        Number.isFinite(firstSeen) &&
        firstSeen >= from &&
        firstSeen < to &&
        entry.relevance === 0 &&
        entry.delivered === false
      );
    })
    .map(([pmid]) => pmid)
    .sort();

  const repaired = structuredClone(parsed.data);
  for (const pmid of pmids) delete repaired.papers[pmid];

  return {
    report: {
      mode,
      criteria: {
        fromInclusive: window.from,
        toExclusive: window.to,
        relevance: 0,
        delivered: false,
      },
      scanned: Object.keys(parsed.data.papers).length,
      matched: pmids.length,
      retained: Object.keys(repaired.papers).length,
      pmids,
      invalidFirstSeenPmids,
    },
    repaired,
  };
}

/**
 * Dry-run is read-only. Apply writes an exact backup and JSON report before atomically replacing
 * the local input file. This function deliberately performs no git checkout, commit or push.
 */
export async function repairLedgerFile(options: RepairFileOptions): Promise<RepairFileResult> {
  const inputPath = resolve(options.inputPath);
  const raw = await readFile(inputPath, "utf8");
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Ledger is not valid JSON: ${inputPath}`, { cause });
  }

  const mode = options.apply ? "apply" : "dry-run";
  const plan = planLedgerRepair(input, options, mode);
  if (!options.apply) return plan;

  const backupDir = resolve(options.backupDir ?? ".cache/state-repair");
  await mkdir(backupDir, { recursive: true });
  const now = options.now ?? new Date();
  const stamp = now.toISOString().replaceAll(":", "-");
  const runId = `${stamp}-${randomUUID()}`;
  const backupPath = join(backupDir, `${basename(inputPath)}.${runId}.bak`);
  const reportPath = join(backupDir, `${basename(inputPath)}.${runId}.report.json`);

  // Both recovery artifacts must exist before the ledger itself is touched.
  await writeFile(backupPath, raw, { encoding: "utf8", flag: "wx" });
  await writeFile(reportPath, JSON.stringify(plan.report, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
  });

  const repaired = { ...plan.repaired, updatedAt: now.toISOString() };
  const tempPath = join(dirname(inputPath), `.${basename(inputPath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, JSON.stringify(repaired, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(tempPath, inputPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }

  return { ...plan, repaired, backupPath, reportPath };
}
