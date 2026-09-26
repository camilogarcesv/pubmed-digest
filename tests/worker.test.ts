import { afterEach, describe, expect, it, vi } from "vitest";
import { VOTE_NOT_SAVED } from "../src/feedback.js";
import worker, { type WorkerEnv } from "../worker/worker.js";

function fakeKv(
  initial: Record<string, string> = {},
  pageSize = Number.POSITIVE_INFINITY,
  options: { failGet?: boolean; failPut?: boolean; log?: string[] } = {},
) {
  const data = new Map(Object.entries(initial));
  const kv = {
    async get(key: string) {
      options.log?.push("kv.get");
      if (options.failGet) throw new Error("KV GET failed: 500 private-key");
      return data.get(key) ?? null;
    },
    async put(key: string, value: string) {
      options.log?.push("kv.put");
      if (options.failPut) throw new Error("KV PUT failed: 429 Too Many Requests");
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
    // Real mode fencing and claims are covered with workerd; these tests isolate KV behavior.
    DB: { prepare: () => ({ first: async () => 'legacy', bind() { return this; }, run: async () => ({ success: true }) }) } as unknown as D1Database,
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    VOTES_READ_SECRET: "read-secret",
    CF_VERSION_METADATA: { id: "test-version", tag: "", timestamp: "" },
    ...overrides,
  };
}

async function invoke(request: Request, workerEnv: WorkerEnv): Promise<Response> {
  if (!worker.fetch) throw new Error("Worker fetch handler is missing");
  const incoming = request as Parameters<NonNullable<typeof worker.fetch>>[0];
  return worker.fetch(incoming, workerEnv, {} as ExecutionContext);
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("vote Worker", () => {
  it("does not log Telegram URLs, tokens or private KV keys on failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("https://api.telegram.org/botbot-token/answerCallbackQuery"); }));
    const { kv } = fakeKv({ "vote:private-chat:12345": "invalid" });
    await invoke(new Request("https://worker.test/webhook", {
      method: "POST", headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
      body: JSON.stringify({ update_id: 1, callback_query: { id: "private-callback", data: "v:12345:1", message: { message_id: 7, chat: { id: 99 } } } }),
    }), env(kv));
    const { kv: failing } = fakeKv({}, Number.POSITIVE_INFINITY, { failPut: true });
    await invoke(new Request("https://worker.test/webhook", {
      method: "POST", headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
      body: JSON.stringify({ update_id: 2, callback_query: { id: "private-callback", data: "v:12345:1", message: { message_id: 7, chat: { id: 99 } } } }),
    }), env(failing));
    await invoke(new Request("https://worker.test/votes", { headers: { authorization: "Bearer read-secret" } }), env(kv));
    const logs = JSON.stringify([...error.mock.calls, ...warn.mock.calls, ...info.mock.calls]);
    for (const sensitive of ["bot-token", "api.telegram.org", "private-chat", "private-callback", "12345"]) expect(logs).not.toContain(sensitive);
  });
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
          update_id: 500,
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
      updateId: 500,
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

describe("vote persistence before acknowledgement", () => {
  function vote(updateId: number | undefined, data = "v:12345:1", extra: Record<string, unknown> = {}): Request {
    return new Request("https://worker.test/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "webhook-secret" },
      body: JSON.stringify({
        ...(updateId === undefined ? {} : { update_id: updateId }),
        callback_query: { id: `callback-${updateId}`, data, message: { message_id: 7, chat: { id: 99 } } },
        ...extra,
      }),
    });
  }
  function telegramLog(log: string[] = []) {
    const telegram = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      log.push(String(url).split("/").at(-1)!);
      return new Response("ok");
    });
    vi.stubGlobal("fetch", telegram);
    const calls = () => telegram.mock.calls.map(([url, init]) => ({
      method: String(url).split("/").at(-1),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    }));
    return { telegram, calls };
  }
  const stored = (data: Map<string, string>) => JSON.parse(data.get("vote:99:12345")!) as Record<string, unknown>;

  it("stores the vote before telling the reader it was recorded", async () => {
    const log: string[] = [];
    const { kv, data } = fakeKv({}, Number.POSITIVE_INFINITY, { log });
    const { calls } = telegramLog(log);

    expect((await invoke(vote(10), env(kv))).status).toBe(200);

    expect(log).toEqual(["kv.get", "kv.put", "answerCallbackQuery", "editMessageReplyMarkup"]);
    expect(calls()[0]!.body).toMatchObject({ text: "👍 anotado" });
    expect(stored(data)).toMatchObject({ value: 1, updateId: 10 });
  });

  it.each([["write", { failPut: true }], ["read", { failGet: true }]] as const)(
    "tells the reader when the %s fails and leaves the keyboard untouched",
    async (_step, failure) => {
      const log: string[] = [];
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { kv, data } = fakeKv({}, Number.POSITIVE_INFINITY, { ...failure, log });
      const { calls } = telegramLog();

      // 2xx: a Telegram redelivery would store a vote the reader was told had failed.
      expect((await invoke(vote(10), env(kv))).status).toBe(200);

      expect(calls()).toEqual([{ method: "answerCallbackQuery", body: { callback_query_id: "callback-10", text: VOTE_NOT_SAVED } }]);
      expect(data.size).toBe(0);
      // A failed read never falls through to a blind write.
      if ("failGet" in failure) expect(log).not.toContain("kv.put");
    },
  );

  it("ignores a redelivered update and an older press that arrives after a newer one", async () => {
    const log: string[] = [];
    const { kv, data } = fakeKv({}, Number.POSITIVE_INFINITY, { log });
    const { calls } = telegramLog();

    await invoke(vote(10, "v:12345:1"), env(kv));
    await invoke(vote(10, "v:12345:1"), env(kv)); // redelivery
    await invoke(vote(12, "v:12345:0"), env(kv)); // reader changes their mind
    await invoke(vote(11, "v:12345:1"), env(kv)); // late, older press

    expect(log.filter((op) => op === "kv.put")).toHaveLength(2);
    expect(stored(data)).toMatchObject({ value: 0, updateId: 12 });
    // Ignored presses only close the spinner: no toast and no keyboard edit.
    const ignored = calls().filter((c) => ["callback-10", "callback-11"].includes(String(c.body.callback_query_id)));
    expect(ignored.filter((c) => c.method === "answerCallbackQuery" && !("text" in c.body))).toHaveLength(2);
    expect(calls().filter((c) => c.method === "editMessageReplyMarkup")).toHaveLength(2);
  });

  it("compares update ids only within the window where Telegram keeps them sequential", async () => {
    // After a week without updates Telegram picks the next id at random, possibly lower.
    const storedAgo = (ms: number) => JSON.stringify({ pmid: "12345", value: 0, chatId: "99", votedAt: new Date(Date.now() - ms).toISOString(), updateId: 900 });
    const old = fakeKv({ "vote:99:12345": storedAgo(2 * 24 * 60 * 60 * 1000) });
    const recent = fakeKv({ "vote:99:12345": storedAgo(60 * 60 * 1000) });
    telegramLog();

    await invoke(vote(5, "v:12345:1"), env(old.kv));
    await invoke(vote(5, "v:12345:1"), env(recent.kv));

    expect(stored(old.data)).toMatchObject({ value: 1, updateId: 5 });
    expect(stored(recent.data)).toMatchObject({ value: 0, updateId: 900 });
  });

  it("replaces a vote stored before updates were tracked", async () => {
    const legacy = JSON.stringify({ pmid: "12345", value: 0, chatId: "99", votedAt: "2026-09-03T00:00:00.000Z" });
    const { kv, data } = fakeKv({ "vote:99:12345": legacy });
    telegramLog();

    await invoke(vote(1, "v:12345:1"), env(kv));

    expect(stored(data)).toMatchObject({ value: 1, updateId: 1 });
  });

  it("refuses to store a vote whose update cannot be ordered", async () => {
    const log: string[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { kv, data } = fakeKv({}, Number.POSITIVE_INFINITY, { log });
    const { calls } = telegramLog();

    for (const updateId of [undefined, -1, 1.5]) {
      expect((await invoke(vote(updateId as number | undefined), env(kv))).status).toBe(200);
    }

    expect(log).toEqual([]);
    expect(data.size).toBe(0);
    expect(calls().every((c) => c.method === "answerCallbackQuery" && c.body.text === VOTE_NOT_SAVED)).toBe(true);
  });

  it("acknowledges oversized updates without reading them, touching KV or calling Telegram", async () => {
    const log: string[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { kv } = fakeKv({}, Number.POSITIVE_INFINITY, { log });
    const { telegram } = telegramLog();

    const response = await invoke(vote(10, "v:12345:1", { padding: "x".repeat(70 * 1024) }), env(kv));

    expect(response.status).toBe(200);
    expect(log).toEqual([]);
    expect(telegram).not.toHaveBeenCalled();
  });

  it("keeps the exported vote shape unchanged", async () => {
    const { kv } = fakeKv();
    telegramLog();
    await invoke(vote(10), env(kv));

    for (const path of ["/votes", "/votes?strict=1"]) {
      const response = await invoke(new Request(`https://worker.test${path}`, { headers: { authorization: "Bearer read-secret" } }), env(kv));
      const body = await response.json() as { votes: Record<string, unknown>[] };
      expect(Object.keys(body.votes[0]!).sort()).toEqual(["chatId", "pmid", "value", "votedAt"]);
    }
  });
});

describe('strict capture export', () => {
  it.each(['invalid-json', 'wrong-key', 'disappeared'])('fails closed without silently dropping %s records', async kind => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const vote = { pmid: '123', value: 1, chatId: '100', votedAt: '2026-09-15T12:00:00.000Z' };
    const { kv, data } = fakeKv({ 'vote:100:123': kind === 'invalid-json' ? 'private-invalid' : JSON.stringify({ ...vote, chatId: kind === 'wrong-key' ? '200' : '100' }) });
    if (kind === 'disappeared') { const list = kv.list.bind(kv); vi.spyOn(kv, 'list').mockImplementation(async options => { const page = await list(options); data.clear(); return page; }); }
    const response = await invoke(new Request('https://worker.test/votes?strict=1', { headers: { authorization: 'Bearer read-secret' } }), env(kv));
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'invalid_vote_records', scanned: 1, invalid: 1 });
  });
  it('includes capture version and exact scan counts across pages', async () => {
    const vote = { pmid: '123', value: 1, chatId: '100', votedAt: '2026-09-15T12:00:00.000Z' };
    const { kv } = fakeKv({ 'vote:100:123': JSON.stringify(vote), 'vote:100:456': JSON.stringify({ ...vote, pmid: '456' }) }, 1);
    const response = await invoke(new Request('https://worker.test/votes?strict=1', { headers: { authorization: 'Bearer read-secret' } }), env(kv));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ format: 1, scanned: 2, invalid: 0 });
  });
});
