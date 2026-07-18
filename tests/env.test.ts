import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_RECIPIENTS",
  "NCBI_API_KEY",
  "EUTILS_EMAIL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadEnv", () => {
  it("requires ANTHROPIC_API_KEY", () => {
    expect(() => loadEnv()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("accepts a minimal valid environment", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const env = loadEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(env.NCBI_API_KEY).toBeUndefined();
  });

  // Regression: GitHub Actions substitutes an unconfigured secret with an empty
  // string rather than omitting the env var (`${{ secrets.X }}` evaluates to ""
  // when X doesn't exist as a repo secret). This broke the digest workflow — an
  // unset optional secret arrived as "" and failed z.string().min(1).optional().
  it("treats an empty-string optional secret as absent", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.NCBI_API_KEY = "";
    process.env.TELEGRAM_BOT_TOKEN = "";
    process.env.TELEGRAM_CHAT_ID = "";
    process.env.TELEGRAM_RECIPIENTS = "";
    process.env.EUTILS_EMAIL = "";

    const env = loadEnv();

    expect(env.NCBI_API_KEY).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_CHAT_ID).toBeUndefined();
    expect(env.TELEGRAM_RECIPIENTS).toBeUndefined();
    expect(env.EUTILS_EMAIL).toBeUndefined();
  });

  it("still treats an empty-string ANTHROPIC_API_KEY as missing (it stays required)", () => {
    process.env.ANTHROPIC_API_KEY = "";
    expect(() => loadEnv()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("still rejects a malformed EUTILS_EMAIL", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.EUTILS_EMAIL = "not-an-email";
    expect(() => loadEnv()).toThrow(/valid email/);
  });
});
