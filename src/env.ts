import { existsSync } from "node:fs";
import { z } from "zod";

// Load .env natively (Node >= 22, which engines already requires). This replaces the
// dotenv dependency: dotenv v17 prints a banner to stdout, which would pollute the
// digest output that --dry-run prints there. Like dotenv, existing env vars win.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

// Secrets come ONLY from the environment (loaded from .env locally via dotenv).
// ANTHROPIC_API_KEY is required for every command because scoring always runs,
// even under --dry-run. Telegram credentials are validated lazily, only when a
// real delivery is attempted (see makeTelegram in index.ts).
const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),
  // Named recipients, e.g. "me:11111111,amigo:22222222". Adds to / overrides TELEGRAM_CHAT_ID.
  TELEGRAM_RECIPIENTS: z.string().min(1).optional(),
  NCBI_API_KEY: z.string().min(1).optional(),
  EUTILS_EMAIL: z.string().email("EUTILS_EMAIL must be a valid email").optional(),
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
