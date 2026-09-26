import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string>; if?: string };
const workflow = parse(readFileSync(".github/workflows/canary.yml", "utf8")) as {
  permissions: unknown; jobs: Record<string, { environment?: string; permissions?: unknown; needs?: string; if?: string; env?: Record<string, string>; steps: Step[] }>;
};

describe("Saturday canary workflow", () => {
  it("uses the private failure notifier for the scheduled digest too", () => {
    const digest = parse(readFileSync(".github/workflows/digest.yml", "utf8"));
    const notice = digest.jobs.digest.steps.at(-1);
    expect(notice).toMatchObject({ name: "Notify failure via Telegram", if: "failure()" });
    expect(notice.run).toContain(".github/scripts/notify-failure.sh /tmp/digest.log");
    expect(notice.run).toContain("if [[ -f .github/scripts/notify-failure.sh ]]");
  });
  it("keeps the legacy canary as it was: a dry run without environment or delivery secrets", () => {
    const legacy = workflow.jobs.canary!;
    expect(legacy.environment).toBeUndefined();
    const smoke = legacy.steps.find(s => s.name === "Smoke-run the digest")!;
    expect(smoke.run).toContain("pnpm dev:digest -- --dry-run --limit 3");
    expect(Object.keys(smoke.env ?? {})).not.toContain("TELEGRAM_BOT_TOKEN");
  });

  it("runs the D1 canary read-only, counts only, from the digest environment, after the legacy one", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    const d1 = workflow.jobs["canary-d1"]!;
    expect(d1).toMatchObject({ environment: "digest", needs: ["backend", "canary"], if: "${{ !cancelled() && needs.backend.result == 'success' }}" });
    expect(d1.permissions).toBeUndefined();
    expect(d1.steps.find(s => s.uses?.startsWith("actions/checkout@"))?.with).toEqual({ "persist-credentials": false });
    const smoke = d1.steps.find(s => s.name === "Smoke-run the D1 digest (read-only)")!;
    for (const flag of ["--backend d1", "--dry-run", "--counts-only", "--limit 3", '--user "$DIGEST_CANARY_USER"']) expect(smoke.run).toContain(flag);
    // DIGEST_SERVICE_SECRET could create and deliver runs once D1 operates: every digest call must be a dry run.
    const digestCalls = d1.steps.flatMap(s => (s.run ?? "").split("\n")).filter(line => line.includes("dev:digest"));
    expect(digestCalls.length).toBeGreaterThan(0);
    for (const line of digestCalls) expect(line).toContain("--dry-run");
    // Telegram and import credentials never reach the D1 steps; only the failure notice uses Telegram.
    for (const env of [d1.env ?? {}, ...d1.steps.filter(s => s.name !== "Notify failure via Telegram").map(s => s.env ?? {})]) {
      expect(Object.keys(env).filter(k => k.startsWith("TELEGRAM_") || k === "IMPORT_SERVICE_SECRET")).toEqual([]);
    }
    const lag = d1.steps.find(s => s.name === "Report D1 lag behind the ledger and votes")!;
    expect(lag).toMatchObject({ if: "${{ !cancelled() && needs.backend.outputs.mode == 'legacy' }}" });
    expect(lag.run).toContain("pnpm d1:lag");
    expect(d1.steps.find(s => s.name === 'Notify failure via Telegram')?.if).toContain("mode == 'legacy'");
    expect(d1.steps.at(-1)).toMatchObject({ name: 'Notify D1 operator through Worker', run: 'pnpm d1:health -- --notify canary' });
  });
});

describe("failure notifier", () => {
  function notify(log: string, fail = false, fallback?: string) {
    const dir = mkdtempSync(join(tmpdir(), "notify-"));
    // Like curl: the response body goes to the -o target (stdout when absent).
    writeFileSync(join(dir, "curl"), [
      "#!/usr/bin/env bash", `printf '%s\\0' "$@" > "${dir}/args"`, "out=/dev/stdout",
      'for ((i = 1; i <= $#; i++)); do [[ "${!i}" == "-o" ]] && { j=$((i + 1)); out="${!j}"; }; done',
      `echo '{"ok":true,"result":{"chat":{"id":1,"first_name":"Private"}}}' > "$out"`,
      ...(fail ? ['echo "Private transport error" >&2', 'exit 22'] : []), "",
    ].join("\n"));
    chmodSync(join(dir, "curl"), 0o755);
    writeFileSync(join(dir, "run.log"), log);
    const result = spawnSync("bash", fallback ? ["-c", fallback] : [".github/scripts/notify-failure.sh", join(dir, "run.log"), "Título", "sin log"], {
      ...(fallback ? { cwd: dir } : {}),
      encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1", RUN_URL: "https://run" },
    });
    return { result, args: readFileSync(join(dir, "args"), "utf8").split("\0") };
  }

  it("sends valid UTF-8 even when the tail cuts a character, and prints nothing Telegram answers", () => {
    const { result, args } = notify("—".repeat(250) + "\nError: Every source failed — refusing");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(args.slice(0, 4)).toEqual(["-sS", "-f", "-o", "/dev/null"]);
    expect(args[args.indexOf("--connect-timeout") + 1]).toBe("10");
    expect(args[args.indexOf("--max-time") + 1]).toBe("30");
    const text = args[args.indexOf("--data-urlencode", args.indexOf("--data-urlencode") + 1) + 1]!;
    expect(text.startsWith("text=Título\n\n")).toBe(true);
    expect(text).toContain("refusing");
    expect(text.endsWith("https://run")).toBe(true);
    expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
    expect(text).not.toContain("\uFFFD");
  });

  it("reports a transport failure without printing the response or transport detail", () => {
    const { result } = notify("", true);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Could not send the failure notification.\n");
    expect(result.stderr).toBe("");
  });

  it("still notifies privately when checkout failed and the shared script is unavailable", () => {
    const digest = parse(readFileSync(".github/workflows/digest.yml", "utf8"));
    const steps = [...Object.values(workflow.jobs).flatMap(j => j.steps.filter(s => s.name === 'Notify failure via Telegram')), digest.jobs.digest.steps.at(-1)];
    for (const step of steps) {
      const { result, args } = notify("", false, step.run);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(args[args.indexOf("-o") + 1]).toBe("/dev/null");
      expect(args[args.indexOf("--max-time") + 1]).toBe("30");
      expect(args.some(a => a.startsWith("text=") && a.includes("https://run"))).toBe(true);
    }
  });
});
