export function chunk<T>(arr: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Remove the first standalone `--` from an argv slice. pnpm forwards the `--` separator
 * (`pnpm dev:digest -- --dry-run`) into the script's argv, and Node's parseArgs treats `--`
 * as an option terminator — which would turn `--dry-run`/`--limit` into ignored positionals.
 */
export function stripArgSeparator(raw: string[]): string[] {
  const sep = raw.indexOf("--");
  return sep === -1 ? raw : [...raw.slice(0, sep), ...raw.slice(sep + 1)];
}
