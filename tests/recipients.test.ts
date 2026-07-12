import { describe, expect, it } from "vitest";
import { parseRecipients, selectRecipients } from "../src/recipients.js";
import type { Env } from "../src/env.js";

function env(over: Partial<Env>): Env {
  return { ANTHROPIC_API_KEY: "x", ...over } as Env;
}

describe("parseRecipients", () => {
  it("maps TELEGRAM_CHAT_ID to 'me'", () => {
    const m = parseRecipients(env({ TELEGRAM_CHAT_ID: "111" }));
    expect(m.get("me")).toBe("111");
  });

  it("parses TELEGRAM_RECIPIENTS and allows negative ids", () => {
    const m = parseRecipients(env({ TELEGRAM_RECIPIENTS: "me:111,amigo:-222" }));
    expect(m.get("me")).toBe("111");
    expect(m.get("amigo")).toBe("-222");
  });

  it("lets TELEGRAM_RECIPIENTS override TELEGRAM_CHAT_ID on a name conflict", () => {
    const m = parseRecipients(env({ TELEGRAM_CHAT_ID: "111", TELEGRAM_RECIPIENTS: "me:999" }));
    expect(m.get("me")).toBe("999");
  });

  it("rejects malformed entries", () => {
    expect(() => parseRecipients(env({ TELEGRAM_RECIPIENTS: "bad-no-colon" }))).toThrow();
    expect(() => parseRecipients(env({ TELEGRAM_RECIPIENTS: "x:notanumber" }))).toThrow();
    expect(() => parseRecipients(env({ TELEGRAM_RECIPIENTS: "sp aces:111" }))).toThrow();
  });
});

describe("selectRecipients", () => {
  const all = () =>
    new Map([
      ["me", "111"],
      ["amigo", "222"],
    ]);

  it("defaults to [me] when --to is absent (friend not spammed)", () => {
    expect(selectRecipients(all(), undefined).map((r) => r.name)).toEqual(["me"]);
  });

  it("resolves a comma-separated list", () => {
    expect(selectRecipients(all(), "me,amigo").map((r) => r.name)).toEqual(["me", "amigo"]);
  });

  it("'all' selects every configured recipient", () => {
    expect(selectRecipients(all(), "all").map((r) => r.name).sort()).toEqual(["amigo", "me"]);
  });

  it("dedupes repeated names", () => {
    expect(selectRecipients(all(), "me,me").map((r) => r.name)).toEqual(["me"]);
  });

  it("throws on an unknown name, listing valid ones", () => {
    expect(() => selectRecipients(all(), "nobody")).toThrow(/Unknown recipient "nobody"/);
  });

  it("throws when no recipients are configured", () => {
    expect(() => selectRecipients(new Map(), undefined)).toThrow(/No Telegram recipients/);
  });
});
