// Tiny structured logger. Everything goes to stderr so stdout stays clean for the
// digest text (important for --dry-run, where the digest is the program's output).

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentThreshold(): number {
  const env = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return ORDER[env] ?? ORDER.info;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < currentThreshold()) return;
  const record = { ts: new Date().toISOString(), level, msg, ...(fields ?? {}) };
  process.stderr.write(JSON.stringify(record) + "\n");
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
