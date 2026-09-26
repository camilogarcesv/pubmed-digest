/// <reference path="./worker-configuration.d.ts" />

// Cloudflare Worker: always-on Telegram vote receiver, bearer-protected vote export and the internal D1 API.
// Bindings are generated from wrangler.jsonc; secrets intentionally remain runtime-only.

import { confirmedKeyboard, parseCallback, VOTE_NOT_SAVED, voteAck, voteKey, type Vote } from "../src/feedback.js";
import { createBackend } from "./multiuser/worker.js";
import { recordCallbackVote } from "./multiuser/telegram-votes.js";

/** Telegram callback updates are a few KiB; the cap only bounds what an update can cost to read. */
const MAX_UPDATE_BYTES = 64 * 1024;
/**
 * update_id is sequential only while the bot keeps receiving updates: after a week without any,
 * Telegram picks the next one at random. Two updates less than a week apart are therefore
 * comparable; a day covers Telegram's redelivery horizon with a wide margin, and a vote stored
 * earlier than that always yields to a new press.
 */
const ORDERING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** KV value: the exported vote plus the Telegram update that produced it (ordering/dedupe only). */
type StoredVote = Vote & { updateId: number };

interface WorkerSecrets {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  VOTES_READ_SECRET: string;
  DIGEST_SERVICE_SECRET?: string;
  IMPORT_SERVICE_SECRET?: string;
}

export type WorkerEnv = Env & WorkerSecrets;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface CallbackQuery {
  id: string;
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}

export function createWorker(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): ExportedHandler<WorkerEnv> {
  // The digest backend reaches Telegram only through the same injectable fetch as the webhook.
  const backend = createBackend(fetchImpl);
  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/webhook") {
        return handleWebhook(request, env, fetchImpl);
      }
      if (request.method === "GET" && url.pathname === "/votes") {
        return handleVotes(request, env);
      }
      if (url.pathname.startsWith("/internal/v1/")) {
        return backend.fetch(request, env);
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

  // Only authenticated requests reach this point, so an oversized body is a genuine Telegram
  // update we do not handle. Answer 2xx: a non-2xx makes Telegram redeliver it and hold back
  // the updates queued behind it. No vote update comes anywhere near this size.
  const body = await readBounded(request, MAX_UPDATE_BYTES);
  if (!body) {
    console.warn({ event: "webhook_update_ignored", reason: "too_large" });
    return new Response("ok");
  }
  let update: unknown;
  try {
    update = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
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

  // update_id orders presses of the same button and identifies redeliveries.
  const updateId = updateIdFrom(update);
  if (updateId === undefined) {
    console.warn({ event: "vote_update_invalid" });
    await tg(fetchImpl, env, "answerCallbackQuery", { callback_query_id: cq.id, text: VOTE_NOT_SAVED });
    return new Response("ok");
  }

  const chatId = String(cq.message.chat.id);
  const key = voteKey(chatId, parsed.pmid);
  const vote: StoredVote = {
    pmid: parsed.pmid,
    value: parsed.value,
    chatId,
    votedAt: new Date().toISOString(),
    updateId,
  };

  // Persist first; the reader is told "anotado" only for a vote that is actually stored. The
  // operating mode picks the store; maintenance, or a mode that cannot be read, stores nothing.
  let outcome: "recorded" | "superseded" | "failed";
  let claim: string | undefined;
  try {
    const mode = await env.DB.prepare("SELECT mode FROM system_controls WHERE singleton=1").first<string>("mode");
    if (mode === "d1") {
      outcome = await recordCallbackVote(env.DB, { chatId, messageId: String(cq.message.message_id), pmid: vote.pmid,
        value: vote.value, votedAt: vote.votedAt, updateId });
    } else if (mode === "legacy") {
      // The claim, refused by D1 once maintenance begins, lets the final capture wait for this write.
      claim = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO legacy_vote_inflight VALUES(?,?)").bind(claim, vote.votedAt).run();
      // KV has no compare-and-set: the read-then-write below drops redelivered or out-of-order
      // presses on a best-effort basis (writes are visible first where they were made).
      const stored = comparableUpdateId(await env.VOTES.get(key), Date.parse(vote.votedAt));
      if (stored !== undefined && stored >= updateId) {
        outcome = "superseded";
      } else {
        await env.VOTES.put(key, JSON.stringify(vote));
        outcome = "recorded";
      }
    } else {
      outcome = "failed";
    }
  } catch {
    // Includes KV's 429 for a second write to the same key within one second.
    outcome = "failed";
  } finally {
    if (claim) {
      try {
        await env.DB.prepare("DELETE FROM legacy_vote_inflight WHERE id=?").bind(claim).run();
      } catch {
        // An orphaned claim blocks sealing and D1 deploys until released with evidence.
        console.error({ event: "legacy_vote_claim_unreleased" });
      }
    }
  }

  if (outcome === "failed") {
    // 2xx on purpose: a redelivery would store a vote the reader was just told had failed.
    // The keyboard stays as it was, so pressing again is the retry.
    console.error({ event: "vote_persist_failed" });
    await tg(fetchImpl, env, "answerCallbackQuery", { callback_query_id: cq.id, text: VOTE_NOT_SAVED });
    return new Response("ok");
  }
  if (outcome === "superseded") {
    // A redelivery, or an older press arriving after a newer one: the newer vote stands.
    console.log({ event: "vote_superseded_ignored" });
    await tg(fetchImpl, env, "answerCallbackQuery", { callback_query_id: cq.id });
    return new Response("ok");
  }

  await tg(fetchImpl, env, "answerCallbackQuery", {
    callback_query_id: cq.id,
    text: voteAck(parsed.value),
  });
  await tg(fetchImpl, env, "editMessageReplyMarkup", {
    chat_id: cq.message.chat.id,
    message_id: cq.message.message_id,
    reply_markup: { inline_keyboard: confirmedKeyboard(parsed.pmid, parsed.value) },
  });

  console.log({ event: "vote_recorded" });
  return new Response("ok");
}

/** Read at most `limit` bytes; undefined when the body is larger. */
async function readBounded(request: Request, limit: number): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return undefined;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function updateIdFrom(update: unknown): number | undefined {
  if (!isRecord(update)) return undefined;
  const id = update.update_id;
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

/**
 * The update that wrote a stored vote, when it can still be compared with a new one (see
 * ORDERING_WINDOW_MS). Undefined for old votes and for votes written before update tracking.
 */
function comparableUpdateId(raw: string | null, now: number): number | undefined {
  if (raw === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.votedAt !== "string") return undefined;
  const id = value.updateId;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return undefined;
  const storedAt = Date.parse(value.votedAt);
  return Number.isFinite(storedAt) && now - storedAt < ORDERING_WINDOW_MS ? id : undefined;
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

  const strict = new URL(request.url).searchParams.get("strict") === "1";
  let scanned = 0, invalid = 0;
  const votes: Vote[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.VOTES.list({ prefix: "vote:", cursor });
    for (const key of page.keys) {
      scanned++;
      const raw = await env.VOTES.get(key.name);
      const vote = raw ? parseStoredVote(raw) : undefined;
      if (vote && (!strict || key.name === voteKey(vote.chatId, vote.pmid))) {
        votes.push(vote);
      } else {
        invalid++;
        console.warn({ event: "invalid_vote_skipped" });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  if (strict && invalid) return Response.json({ error: "invalid_vote_records", scanned, invalid }, { status: 409, headers: { "cache-control": "no-store" } });
  return Response.json(strict ? { votes, scanned, invalid, format: 1 } : { votes }, { headers: { "cache-control": "no-store" } });
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
  } catch {
    console.error({
      event: "telegram_api_error",
      method,
    });
  }
}
