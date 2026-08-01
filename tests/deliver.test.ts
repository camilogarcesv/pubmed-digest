import { describe, expect, it } from "vitest";
import { MultiDeliverer, TelegramDeliverer, type OutMessage } from "../src/deliver.js";
import { voteKeyboard } from "../src/feedback.js";

/** A stub fetch that records request bodies and 400s for the given chat_ids. */
function fakeFetch(failChatIds: string[] = []) {
  const bodies: Record<string, unknown>[] = [];
  const impl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const ok = !failChatIds.includes(String(body.chat_id));
    return {
      ok,
      status: ok ? 200 : 400,
      text: async () => (ok ? "" : "bad chat"),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

/** interMessageMs 0 so tests don't wait out the real per-chat pacing. */
function tg(chatId: string, impl: typeof fetch): TelegramDeliverer {
  return new TelegramDeliverer("t", chatId, impl, 0);
}

const HOLA: OutMessage[] = [{ text: "hola" }];

describe("TelegramDeliverer", () => {
  it("sends one request per message, in order, attaching each keyboard", async () => {
    const { impl, bodies } = fakeFetch();
    const messages: OutMessage[] = [
      { text: "cabecera" },
      { text: "paper 1", keyboard: voteKeyboard("111") },
      { text: "paper 2", keyboard: voteKeyboard("222") },
      { text: "pie" },
    ];

    await tg("1", impl).send(messages);

    expect(bodies.map((b) => b.text)).toEqual(["cabecera", "paper 1", "paper 2", "pie"]);
    expect(bodies[0]!.reply_markup).toBeUndefined();
    expect(bodies[1]!.reply_markup).toEqual({ inline_keyboard: voteKeyboard("111") });
    expect(bodies[2]!.reply_markup).toEqual({ inline_keyboard: voteKeyboard("222") });
    expect(bodies[3]!.reply_markup).toBeUndefined();
    for (const b of bodies) expect(b.parse_mode).toBe("HTML");
  });

  it("puts the keyboard on the LAST chunk when a message needs splitting", async () => {
    const { impl, bodies } = fakeFetch();
    const line = "x".repeat(100);
    const long = Array.from({ length: 60 }, () => line).join("\n"); // ~6060 chars -> 2 chunks

    await tg("1", impl).send([{ text: long, keyboard: voteKeyboard("111") }]);

    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.at(-1)!.reply_markup).toEqual({ inline_keyboard: voteKeyboard("111") });
    for (const b of bodies.slice(0, -1)) expect(b.reply_markup).toBeUndefined();
  });
});

describe("MultiDeliverer", () => {
  it("delivers every message to every recipient", async () => {
    const { impl, bodies } = fakeFetch();
    await new MultiDeliverer([
      { name: "me", deliverer: tg("111", impl) },
      { name: "amigo", deliverer: tg("222", impl) },
    ]).send(HOLA);
    expect(bodies.map((b) => b.chat_id).sort()).toEqual(["111", "222"]);
  });

  it("still delivers to the rest when one recipient fails, then throws aggregated", async () => {
    const { impl, bodies } = fakeFetch(["222"]);
    const md = new MultiDeliverer([
      { name: "me", deliverer: tg("111", impl) },
      { name: "amigo", deliverer: tg("222", impl) },
    ]);
    await expect(md.send(HOLA)).rejects.toThrow(/amigo/);
    // both were attempted despite amigo failing
    expect(bodies.map((b) => b.chat_id).sort()).toEqual(["111", "222"]);
  });
});
