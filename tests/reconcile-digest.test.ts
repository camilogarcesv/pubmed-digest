import { describe, expect, it, vi } from "vitest";
import { resolveMessage } from "../src/operations/reconcile-digest.js";

const ids = { userId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222", messageId: "33333333-3333-4333-8333-333333333333" };
const base = { origin: "https://worker.example.test", secret: "i".repeat(64), ...ids };

describe("digest:reconcile", () => {
  it("posts one audited resolution to the scoped admin route", async () => {
    const fetcher = vi.fn(async () => Response.json({ status: "succeeded", messages: { sent: 5, reconciled_sent: 1 } }, { headers: { "cache-control": "no-store" } }));
    const result = await resolveMessage({ ...base, resolution: { action: "mark_sent", actor: "operator", reason: "Visto en el chat", telegramMessageId: "812" } }, fetcher as unknown as typeof fetch);
    expect(result).toEqual({ status: "succeeded", messages: { sent: 5, reconciled_sent: 1 } });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://worker.example.test/internal/v1/admin/users/${ids.userId}/digest-runs/${ids.runId}/messages/${ids.messageId}/resolve`);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(init.body))).toEqual({ action: "mark_sent", actor: "operator", reason: "Visto en el chat", telegramMessageId: "812" });
  });

  it("validates before sending and reports refusals by code only", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: "conflict", message: "x", requestId: "r" } }, { status: 409, headers: { "cache-control": "no-store" } }));
    for (const resolution of [{ action: "retry", actor: "o", reason: "", telegramMessageId: null }, { action: "retry", actor: "o", reason: "r", telegramMessageId: "1" }, { action: "skip", actor: "o", reason: "r", telegramMessageId: null }]) {
      await expect(resolveMessage({ ...base, resolution }, fetcher as unknown as typeof fetch)).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
    await expect(resolveMessage({ ...base, resolution: { action: "retry", actor: "o", reason: "Chat reactivado", telegramMessageId: null } }, fetcher as unknown as typeof fetch))
      .rejects.toThrow("Resolution refused (409 conflict)");
    await expect(resolveMessage({ ...base, secret: "short", resolution: {} })).rejects.toThrow("credential");
  });
});
