// Tiny structured logger. Everything goes to stderr so stdout stays clean for the
// digest text (important for --dry-run, where the digest is the program's output).

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentThreshold(): number {
  const env = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return ORDER[env] ?? ORDER.info;
}

const redacted = new Set<string>();

/** Leave these fields out of every later record (e.g. article ids when logs are public). */
export function redactFields(...keys: string[]): void {
  for (const key of keys) redacted.add(key);
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < currentThreshold()) return;
  const kept = Object.entries(fields ?? {}).filter(([key]) => !redacted.has(key));
  const record = { ts: new Date().toISOString(), level, msg, ...Object.fromEntries(kept) };
  process.stderr.write(JSON.stringify(record) + "\n");
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
