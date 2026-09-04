/// <reference path="./worker-configuration.d.ts" />

// Cloudflare Worker: always-on Telegram vote receiver and bearer-protected vote export.
// Bindings are generated from wrangler.jsonc; secrets intentionally remain runtime-only.

import { confirmedKeyboard, parseCallback, voteAck, voteKey, type Vote } from "../src/feedback.js";

interface WorkerSecrets {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  VOTES_READ_SECRET: string;
}

export type WorkerEnv = Env & WorkerSecrets;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface CallbackQuery {
  id: string;
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}

function createWorker(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): ExportedHandler<WorkerEnv> {
  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/webhook") {
        return handleWebhook(request, env, fetchImpl);
      }
      if (request.method === "GET" && url.pathname === "/votes") {
        return handleVotes(request, env);
      }
      return new Response("not found", { status: 404 });
    },
  };
}

export default createWorker();

async function handleWebhook(
  request: Request,
  env: WorkerEnv,
  fetchImpl: FetchLike,
): Promise<Response> {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return new Response("not configured", { status: 503 });
  if (
    !(await secretsEqual(
      request.headers.get("x-telegram-bot-api-secret-token") ?? "",
      env.TELEGRAM_WEBHOOK_SECRET,
    ))
  ) {
    return new Response("forbidden", { status: 403 });
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const cq = callbackQueryFrom(update);
  // Telegram sends other update types to the same endpoint. Acknowledge and ignore them.
  if (!cq?.data) return new Response("ok");

  const parsed = parseCallback(cq.data);
  if (!parsed || !cq.message) {
    await tg(fetchImpl, env, "answerCallbackQuery", { callback_query_id: cq.id });
    return new Response("ok");
  }

  const chatId = String(cq.message.chat.id);
  const vote: Vote = {
    pmid: parsed.pmid,
    value: parsed.value,
    chatId,
    votedAt: new Date().toISOString(),
  };

  // Acknowledge first so the Telegram interaction remains responsive.
  await tg(fetchImpl, env, "answerCallbackQuery", {
    callback_query_id: cq.id,
    text: voteAck(parsed.value),
  });
  await env.VOTES.put(voteKey(chatId, parsed.pmid), JSON.stringify(vote));
  await tg(fetchImpl, env, "editMessageReplyMarkup", {
    chat_id: cq.message.chat.id,
    message_id: cq.message.message_id,
    reply_markup: { inline_keyboard: confirmedKeyboard(parsed.pmid, parsed.value) },
  });

  console.log({ event: "vote_recorded", pmid: parsed.pmid });
  return new Response("ok");
}

async function handleVotes(request: Request, env: WorkerEnv): Promise<Response> {
  if (!env.VOTES_READ_SECRET) return new Response("not configured", { status: 503 });
  if (
    !(await secretsEqual(
      request.headers.get("authorization") ?? "",
      `Bearer ${env.VOTES_READ_SECRET}`,
    ))
  ) {
    return new Response("forbidden", { status: 403 });
  }

  const votes: Vote[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.VOTES.list({ prefix: "vote:", cursor });
    for (const key of page.keys) {
      const raw = await env.VOTES.get(key.name);
      const vote = raw ? parseStoredVote(raw) : undefined;
      if (vote) {
        votes.push(vote);
      } else {
        console.warn({ event: "invalid_vote_skipped", key: key.name });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return Response.json({ votes });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function callbackQueryFrom(update: unknown): CallbackQuery | undefined {
  if (!isRecord(update) || !isRecord(update.callback_query)) return undefined;
  const raw = update.callback_query;
  if (typeof raw.id !== "string") return undefined;

  const result: CallbackQuery = { id: raw.id };
  if (typeof raw.data === "string") result.data = raw.data;
  if (
    isRecord(raw.message) &&
    typeof raw.message.message_id === "number" &&
    isRecord(raw.message.chat) &&
    typeof raw.message.chat.id === "number"
  ) {
    result.message = {
      message_id: raw.message.message_id,
      chat: { id: raw.message.chat.id },
    };
  }
  return result;
}

function parseStoredVote(raw: string): Vote | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (
    typeof value.pmid !== "string" ||
    (value.value !== 0 && value.value !== 1) ||
    typeof value.chatId !== "string" ||
    typeof value.votedAt !== "string"
  ) {
    return undefined;
  }
  return {
    pmid: value.pmid,
    value: value.value,
    chatId: value.chatId,
    votedAt: value.votedAt,
  };
}

/** Compare fixed-length digests to avoid leaking secret length or mismatch position. */
async function secretsEqual(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(actualDigest, expectedDigest);
  }

  // Node's WebCrypto used by offline unit tests does not expose Workers' timingSafeEqual.
  const left = new Uint8Array(actualDigest);
  const right = new Uint8Array(expectedDigest);
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left[i]! ^ right[i]!;
  return mismatch === 0;
}

/** Fire a Telegram Bot API method. Telegram failures are structured logs, never secrets. */
async function tg(
  fetchImpl: FetchLike,
  env: WorkerEnv,
  method: string,
  body: unknown,
): Promise<void> {
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error({ event: "telegram_api_failed", method, status: res.status });
  } catch (error) {
    console.error({
      event: "telegram_api_error",
      method,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
