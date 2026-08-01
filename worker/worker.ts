// Cloudflare Worker: the always-on vote receiver. Telegram discards unread callback_queries
// after ~24h, so button presses need something listening at all times — this is it, and it is
// also the first piece of the future backend.
//
// Routes:
//   POST /webhook  — Telegram updates, authenticated by the X-Telegram-Bot-Api-Secret-Token
//                    header (set via setWebhook's secret_token). Handles callback_query votes:
//                    ack instantly, persist to KV (re-vote overwrites), mark the pressed button.
//   GET  /votes    — every stored vote as JSON, behind `Authorization: Bearer VOTES_READ_SECRET`.
//                    This is what `pnpm eval` and the weekly digest (dynamic exemplars) read.
//
// Deploy: `npx wrangler deploy` from worker/ (see README). Secrets via `wrangler secret put`.

import { confirmedKeyboard, parseCallback, voteAck, voteKey, type Vote } from "../src/feedback.js";

export interface Env {
  VOTES: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  VOTES_READ_SECRET: string;
}

interface CallbackQuery {
  id: string;
  data?: string;
  from?: { id: number };
  message?: { message_id: number; chat: { id: number } };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }
    if (request.method === "GET" && url.pathname === "/votes") {
      return handleVotes(request, env);
    }
    return new Response("not found", { status: 404 });
  },
};

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  // Telegram echoes back the secret_token registered with setWebhook; anything else is not Telegram.
  if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  let update: { callback_query?: CallbackQuery };
  try {
    update = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const cq = update.callback_query;
  // Not a vote (a plain message, a join event...): acknowledge and ignore. Always return 200 —
  // erroring here would make Telegram retry the same update forever.
  if (!cq?.data) return new Response("ok");

  const parsed = parseCallback(cq.data);
  if (!parsed || !cq.message) {
    // Unknown payload: dismiss the loading spinner and move on.
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    return new Response("ok");
  }

  const chatId = String(cq.message.chat.id);
  const vote: Vote = {
    pmid: parsed.pmid,
    value: parsed.value,
    chatId,
    votedAt: new Date().toISOString(),
  };

  // Ack first: the toast must feel instant even if KV or the edit is slow.
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: voteAck(parsed.value) });
  await env.VOTES.put(voteKey(chatId, parsed.pmid), JSON.stringify(vote));
  // Mark the pressed side; both buttons stay pressable so a re-vote overwrites.
  await tg(env, "editMessageReplyMarkup", {
    chat_id: cq.message.chat.id,
    message_id: cq.message.message_id,
    reply_markup: { inline_keyboard: confirmedKeyboard(parsed.pmid, parsed.value) },
  });

  return new Response("ok");
}

async function handleVotes(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${env.VOTES_READ_SECRET}`) {
    return new Response("forbidden", { status: 403 });
  }

  const votes: Vote[] = [];
  let cursor: string | undefined;
  // KV lists at most 1000 keys per page; paginate so the dump stays complete as votes grow.
  do {
    const page = await env.VOTES.list({ prefix: "vote:", cursor });
    for (const key of page.keys) {
      const raw = await env.VOTES.get(key.name);
      if (raw) votes.push(JSON.parse(raw) as Vote);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return new Response(JSON.stringify({ votes }), {
    headers: { "content-type": "application/json" },
  });
}

/** Fire a Telegram Bot API method. Failures are logged, never thrown — the webhook must 200. */
async function tg(env: Env, method: string, body: unknown): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.log(`telegram ${method} failed: HTTP ${res.status}`);
  } catch (err) {
    console.log(`telegram ${method} threw: ${String(err)}`);
  }
}
