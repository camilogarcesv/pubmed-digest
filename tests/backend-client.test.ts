import { describe, expect, it, vi } from "vitest";
import { BackendError, backendFromEnv, backendOrigin, httpBackend } from "../src/backend/client.js";

const secret = "s".repeat(64);
const ok = (body: unknown) => Response.json(body, { headers: { "cache-control": "no-store" } });
const refused = (status: number, code: string) => Response.json({ error: { code, message: "x", requestId: "r" } }, { status, headers: { "cache-control": "no-store" } });
const userId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";

function client(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next || next instanceof Error) throw next ?? new Error("no response scripted");
    return next;
  }) as unknown as typeof fetch;
  const waits: number[] = [];
  return { calls, waits, backend: httpBackend("https://worker.example.test", secret, { fetch: fetcher, wait: async (ms) => { waits.push(ms); } }) };
}

describe("digest backend client", () => {
  it("sends the service credential, requires no-store and never follows redirects", async () => {
    const c = client([ok({ mode: "legacy" }), Response.json({ mode: "d1" })]);
    expect(await c.backend.mode()).toBe("legacy");
    expect(c.calls[0]).toMatchObject({ url: "https://worker.example.test/internal/v1/mode", init: { method: "GET", redirect: "error" } });
    expect(new Headers(c.calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${secret}`);
    await expect(c.backend.mode()).rejects.toMatchObject({ code: "unexpected_cache_policy" });
  });

  it("retries transport failures and 5xx on idempotent calls, never refusals", async () => {
    const c = client([new Error("reset"), refused(503, "internal_error"), ok({ state: "sent" })]);
    expect(await c.backend.deliver(userId, runId, runId)).toEqual({ state: "sent" });
    expect(c.waits).toEqual([1000, 2000]);
    const d = client([refused(409, "mode_unavailable")]);
    await expect(d.backend.createRun({ id: runId, userId, profileVersion: 1, runKey: "weekly:2026-W39:1", payloadHash: "a".repeat(64),
      kind: "weekly", expectedItems: 0, createdAt: "2026-09-21T12:00:00.000Z", period: "2026-W39" })).rejects.toMatchObject({ status: 409, code: "mode_unavailable" });
    expect(d.calls).toHaveLength(1);
    const e = client([refused(500, "internal_error"), refused(500, "internal_error"), refused(500, "internal_error")]);
    await expect(e.backend.abort(userId, runId)).rejects.toBeInstanceOf(BackendError);
    expect(e.calls).toHaveLength(3);
  });

  it("never retries an alert, which could have been sent", async () => {
    const c = client([refused(502, "internal_error")]);
    await expect(c.backend.opsAlert("x")).rejects.toMatchObject({ status: 502 });
    expect(c.calls).toHaveLength(1);
    const d = client([new Error("timeout")]);
    await expect(d.backend.opsAlert("x")).rejects.toThrow("timeout");
    expect(d.calls).toHaveLength(1);
  });

  it("checks seen pairs in batches of fifty and keeps their order", async () => {
    const pairs = Array.from({ length: 120 }, (_, i) => ({ userId, pmid: String(i + 1) }));
    const c = client([ok({ seen: Array(50).fill(false) }), ok({ seen: Array(50).fill(true) }), ok({ seen: Array(20).fill(false) })]);
    const seen = await c.backend.seen(pairs);
    expect(seen.filter(Boolean)).toHaveLength(50);
    expect(seen.slice(50, 100).every(Boolean)).toBe(true);
    expect(c.calls.map(x => JSON.parse(String(x.init.body)).pairs.length)).toEqual([50, 50, 20]);
    const short = client([ok({ seen: [true] })]);
    await expect(short.backend.seen(pairs.slice(0, 2))).rejects.toThrow();
  });

  it("uses PUT for item chunks and scoped paths for every run call", async () => {
    const c = client([ok({ stored: true }), ok({ status: "prepared" }), ok({ runs: [] })]);
    await c.backend.putItems(userId, runId, 2, []);
    await c.backend.prepare(userId, runId, { metrics: {}, destinations: [{ destinationId: runId, messages: [{ kind: "empty", text: "x", pmid: null, votable: false }] }] });
    await c.backend.runs(userId, "2026-W39");
    expect(c.calls.map(x => `${x.init.method} ${new URL(x.url).pathname}${new URL(x.url).search}`)).toEqual([
      `PUT /internal/v1/users/${userId}/digest-runs/${runId}/items/2`,
      `POST /internal/v1/users/${userId}/digest-runs/${runId}/prepare`,
      `GET /internal/v1/users/${userId}/digest-runs?period=2026-W39`,
    ]);
  });

  it("accepts only a bare https origin, or http on localhost", () => {
    expect(backendOrigin("https://worker.example.test/votes")).toBe("https://worker.example.test");
    expect(backendOrigin("http://127.0.0.1:8799")).toBe("http://127.0.0.1:8799");
    for (const bad of ["http://worker.example.test", "https://user:pass@worker.example.test", "https://worker.example.test/?k=v"]) {
      expect(() => backendOrigin(bad)).toThrow();
    }
    expect(() => httpBackend("https://worker.example.test", "short")).toThrow("credential");
    expect(() => backendFromEnv({ VOTES_URL: "https://worker.example.test/votes" })).toThrow("DIGEST_SERVICE_SECRET");
    expect(() => backendFromEnv({ DIGEST_API_ORIGIN: "https://user:pass@worker.example.test", DIGEST_SERVICE_SECRET: secret })).toThrow("origin");
    expect(() => backendFromEnv({ VOTES_URL: "https://worker.example.test/votes", DIGEST_SERVICE_SECRET: secret })).not.toThrow();
  });
});
