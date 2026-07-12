import { describe, expect, it } from "vitest";
import { MultiDeliverer, TelegramDeliverer } from "../src/deliver.js";

/** A stub fetch that records chat_ids and 400s for the given ones. */
function fakeFetch(failChatIds: string[] = []) {
  const calls: string[] = [];
  const impl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body.chat_id);
    const ok = !failChatIds.includes(body.chat_id);
    return {
      ok,
      status: ok ? 200 : 400,
      text: async () => (ok ? "" : "bad chat"),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("MultiDeliverer", () => {
  it("delivers to every recipient", async () => {
    const { impl, calls } = fakeFetch();
    await new MultiDeliverer([
      { name: "me", deliverer: new TelegramDeliverer("t", "111", impl) },
      { name: "amigo", deliverer: new TelegramDeliverer("t", "222", impl) },
    ]).send("hola");
    expect(calls.sort()).toEqual(["111", "222"]);
  });

  it("still delivers to the rest when one recipient fails, then throws aggregated", async () => {
    const { impl, calls } = fakeFetch(["222"]);
    const md = new MultiDeliverer([
      { name: "me", deliverer: new TelegramDeliverer("t", "111", impl) },
      { name: "amigo", deliverer: new TelegramDeliverer("t", "222", impl) },
    ]);
    await expect(md.send("hola")).rejects.toThrow(/amigo/);
    // both were attempted despite amigo failing
    expect(calls.sort()).toEqual(["111", "222"]);
  });
});
