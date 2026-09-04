import { parseArgs } from "node:util";
import {
  DEFAULT_REPAIR_FROM,
  DEFAULT_REPAIR_TO,
  repairLedgerFile,
} from "./state-repair.js";
import { logger } from "./logger.js";
import { stripArgSeparator } from "./util.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: stripArgSeparator(process.argv.slice(2)),
    options: {
      input: { type: "string", default: "state.json" },
      from: { type: "string", default: DEFAULT_REPAIR_FROM },
      to: { type: "string", default: DEFAULT_REPAIR_TO },
      apply: { type: "boolean", default: false },
      "backup-dir": { type: "string", default: ".cache/state-repair" },
    },
  });

  const result = await repairLedgerFile({
    inputPath: values.input,
    from: values.from,
    to: values.to,
    apply: values.apply,
    backupDir: values["backup-dir"],
  });
  process.stdout.write(JSON.stringify(result.report, null, 2) + "\n");
  if (result.backupPath && result.reportPath) {
    process.stdout.write(`Backup: ${result.backupPath}\nReport: ${result.reportPath}\n`);
  } else {
    process.stdout.write("Dry-run: no files were modified. Re-run with --apply to change the local file.\n");
  }
}

main().catch((error) => {
  logger.error("ledger repair failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
