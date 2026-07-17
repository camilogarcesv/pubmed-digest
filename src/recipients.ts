import { z } from "zod";
import type { Env } from "./env.js";

export interface Recipient {
  name: string;
  chatId: string;
}

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const CHAT_ID_RE = /^-?\d+$/; // negative ids are valid for groups/channels

const RecipientEntrySchema = z.object({
  name: z.string().regex(NAME_RE, "recipient name must match [A-Za-z0-9_-]"),
  chatId: z.string().regex(CHAT_ID_RE, "chat id must be an integer (negatives allowed)"),
});

/**
 * Build the recipient registry from the environment:
 *  - `TELEGRAM_CHAT_ID` (if set) becomes recipient `me`.
 *  - `TELEGRAM_RECIPIENTS` ("me:111,amigo:222") adds/overrides named recipients.
 * Later entries win on name conflicts, so `TELEGRAM_RECIPIENTS` can override `me`.
 */
export function parseRecipients(env: Env): Map<string, string> {
  const map = new Map<string, string>();

  if (env.TELEGRAM_CHAT_ID) {
    const e = RecipientEntrySchema.parse({ name: "me", chatId: env.TELEGRAM_CHAT_ID });
    map.set(e.name, e.chatId);
  }

  if (env.TELEGRAM_RECIPIENTS) {
    for (const pair of env.TELEGRAM_RECIPIENTS.split(",")) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(":");
      if (idx === -1) {
        throw new Error(`TELEGRAM_RECIPIENTS entry "${trimmed}" must be name:chat_id`);
      }
      const e = RecipientEntrySchema.parse({
        name: trimmed.slice(0, idx).trim(),
        chatId: trimmed.slice(idx + 1).trim(),
      });
      map.set(e.name, e.chatId);
    }
  }

  return map;
}

/**
 * Resolve the `--to` selection.
 *  - undefined ⇒ `["me"]` (safe default: the friend is reached only when named).
 *  - "all" ⇒ every configured recipient.
 *  - "me,amigo" ⇒ those names; an unknown name throws with the valid names listed.
 */
export function selectRecipients(all: Map<string, string>, toArg?: string): Recipient[] {
  if (all.size === 0) {
    throw new Error(
      "No Telegram recipients configured. Set TELEGRAM_CHAT_ID (recipient 'me') or TELEGRAM_RECIPIENTS.",
    );
  }

  const known = [...all.keys()].sort();

  let names: string[];
  if (toArg === undefined) {
    names = all.has("me") ? ["me"] : [known[0]!];
  } else if (toArg.trim() === "all") {
    names = known;
  } else {
    names = toArg
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
  }

  if (names.length === 0) {
    throw new Error(`--to selected no recipients. Valid names: ${known.join(", ")}`);
  }

  const out: Recipient[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    const chatId = all.get(name);
    if (chatId === undefined) {
      throw new Error(`Unknown recipient "${name}". Valid names: ${known.join(", ")}`);
    }
    seen.add(name);
    out.push({ name, chatId });
  }
  return out;
}
