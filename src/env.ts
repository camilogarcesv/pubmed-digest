import { existsSync } from "node:fs";
import { z } from "zod";

// Load .env natively (Node >= 22, which engines already requires). This replaces the
// dotenv dependency: dotenv v17 prints a banner to stdout, which would pollute the
// digest output that --dry-run prints there. Like dotenv, existing env vars win.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

// GitHub Actions substitutes an unconfigured secret with an empty string, not an
// absent variable (`${{ secrets.X }}` evaluates to "" when X doesn't exist), so an
// optional secret that was never set as a repo secret still arrives here as "" rather
// than undefined. Treat "" as "not set" before validating, or z.optional() would
// reject it as an invalid value instead of treating it as absent. Locally this never
// shows up: an unset key is simply missing from .env (truly undefined), not "".
const emptyToUndefined = (val: unknown) => (val === "" ? undefined : val);
const optionalNonEmpty = () => z.preprocess(emptyToUndefined, z.string().min(1).optional());

// Secrets come ONLY from the environment (loaded from .env locally, or GitHub Actions
// repository secrets in CI). ANTHROPIC_API_KEY is required for every command because
// scoring always runs, even under --dry-run. Telegram credentials are validated lazily,
// only when a real delivery is attempted (see makeDeliverer in index.ts).
const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.preprocess(
    emptyToUndefined,
    z.string().min(1, "ANTHROPIC_API_KEY is required"),
  ),
  TELEGRAM_BOT_TOKEN: optionalNonEmpty(),
  TELEGRAM_CHAT_ID: optionalNonEmpty(),
  // Named recipients, e.g. "me:11111111,amigo:22222222". Adds to / overrides TELEGRAM_CHAT_ID.
  TELEGRAM_RECIPIENTS: optionalNonEmpty(),
  NCBI_API_KEY: optionalNonEmpty(),
  EUTILS_EMAIL: z.preprocess(
    emptyToUndefined,
    z.string().email("EUTILS_EMAIL must be a valid email").optional(),
  ),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        "Copy .env.example to .env and fill in the values.",
    );
  }
  return parsed.data;
}
