import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type WorkerEnv } from "../worker/worker.js";

function fakeKv(initial: Record<string, string> = {}, pageSize = Number.POSITIVE_INFINITY) {
  const data = new Map(Object.entries(initial));
  const kv = {
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
    async list(options?: { prefix?: string; cursor?: string }) {
      const prefix = options?.prefix ?? "";
      const names = [...data.keys()].filter((key) => key.startsWith(prefix));
      const start = Number(options?.cursor ?? 0);
      const end = Math.min(start + pageSize, names.length);
      const listComplete = end >= names.length;
      return {
        keys: names.slice(start, end).map((name) => ({ name })),
        list_complete: listComplete,
        cursor: listComplete ? "" : String(end),
        cacheStatus: null,
      };
    },
  } as unknown as KVNamespace;
  return { kv, data };
}

function env(kv: KVNamespace, overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    VOTES: kv,
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    VOTES_READ_SECRET: "read-secret",
    ...overrides,
  };
}

async function invoke(request: Request, workerEnv: WorkerEnv): Promise<Response> {
  if (!worker.fetch) throw new Error("Worker fetch handler is missing");
  const incoming = request as Parameters<NonNullable<typeof worker.fetch>>[0];
  return worker.fetch(incoming, workerEnv, {} as ExecutionContext);
}

afterEach(() => vi.unstubAllGlobals());

describe("vote Worker", () => {
  it("fails closed when the webhook secret is missing or wrong", async () => {
    const { kv } = fakeKv();
    const missing = await invoke(
      new Request("https://worker.test/webhook", { method: "POST" }),
      env(kv, { TELEGRAM_WEBHOOK_SECRET: "" }),
    );
    const wrong = await invoke(
      new Request("https://worker.test/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "wrong" },
      }),
      env(kv),
    );

    expect(missing.status).toBe(503);
    expect(wrong.status).toBe(403);
  });

  it("acknowledges, stores and marks a valid Telegram vote", async () => {
    const { kv, data } = fakeKv();
    const telegram = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", telegram);
    const response = await invoke(
      new Request("https://worker.test/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "webhook-secret",
        },
        body: JSON.stringify({
          callback_query: {
            id: "callback-1",
            data: "v:12345:1",
            message: { message_id: 7, chat: { id: 99 } },
          },
        }),
      }),
      env(kv),
    );

    expect(response.status).toBe(200);
    expect(telegram).toHaveBeenCalledTimes(2);
    expect(data.has("vote:99:12345")).toBe(true);
    expect(JSON.parse(data.get("vote:99:12345")!)).toMatchObject({
      pmid: "12345",
      value: 1,
      chatId: "99",
    });
  });

  it("protects the vote export and skips malformed stored values", async () => {
    const valid = JSON.stringify({
      pmid: "12345",
      value: 0,
      chatId: "99",
      votedAt: "2026-09-03T00:00:00Z",
    });
    const { kv } = fakeKv({ "vote:99:12345": valid, "vote:99:broken": "not json" });

    const forbidden = await invoke(new Request("https://worker.test/votes"), env(kv));
    const allowed = await invoke(
      new Request("https://worker.test/votes", {
        headers: { authorization: "Bearer read-secret" },
      }),
      env(kv),
    );

    expect(forbidden.status).toBe(403);
    expect(await allowed.json()).toEqual({ votes: [JSON.parse(valid)] });
  });

  it("paginates through every KV vote page", async () => {
    const entries = Object.fromEntries(
      ["1", "2", "3"].map((pmid) => [
        `vote:99:${pmid}`,
        JSON.stringify({ pmid, value: 1, chatId: "99", votedAt: "2026-09-03T00:00:00Z" }),
      ]),
    );
    const { kv } = fakeKv(entries, 2);

    const response = await invoke(
      new Request("https://worker.test/votes", {
        headers: { authorization: "Bearer read-secret" },
      }),
      env(kv),
    );
    const body = await response.json() as { votes: unknown[] };

    expect(body.votes).toHaveLength(3);
  });

  it("acknowledges unknown callback payloads without writing a vote", async () => {
    const { kv, data } = fakeKv();
    const telegram = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", telegram);

    const response = await invoke(
      new Request("https://worker.test/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "webhook-secret",
        },
        body: JSON.stringify({ callback_query: { id: "x", data: "not-a-vote" } }),
      }),
      env(kv),
    );

    expect(response.status).toBe(200);
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(data.size).toBe(0);
  });
});
