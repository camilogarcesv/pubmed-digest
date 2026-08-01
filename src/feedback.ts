// Pure vote logic shared by BOTH sides of the feedback loop: the digest builds the keyboards
// (src/digest.ts) and the Cloudflare Worker parses the presses (worker/worker.ts). Living in
// one file is what keeps the callback format from drifting between them. Keep it free of
// Workers-runtime types — it must type-check under plain Node and under the worker tsconfig.

export interface Vote {
  pmid: string;
  /** 1 = 👍, 0 = 👎 */
  value: 0 | 1;
  chatId: string;
  votedAt: string;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

/** callback_data for a vote button. Telegram caps callback_data at 64 bytes; "v:<pmid>:<v>" is ~14. */
export function voteCallbackData(pmid: string, value: 0 | 1): string {
  return `v:${pmid}:${value}`;
}

/**
 * Parse a callback_data payload. Returns null for anything that is not a well-formed vote —
 * the webhook receives whatever Telegram relays, so unknown payloads are ignored, not errors.
 */
export function parseCallback(data: string): { pmid: string; value: 0 | 1 } | null {
  const m = /^v:(\d+):([01])$/.exec(data);
  if (!m) return null;
  return { pmid: m[1]!, value: m[2] === "1" ? 1 : 0 };
}

/** The 👍/👎 row attached to each digest paper. */
export function voteKeyboard(pmid: string): InlineButton[][] {
  return [
    [
      { text: "👍", callback_data: voteCallbackData(pmid, 1) },
      { text: "👎", callback_data: voteCallbackData(pmid, 0) },
    ],
  ];
}

/**
 * The keyboard after a vote: the chosen side is marked, both stay pressable so a re-vote
 * (which overwrites in KV) is always possible.
 */
export function confirmedKeyboard(pmid: string, value: 0 | 1): InlineButton[][] {
  return [
    [
      { text: value === 1 ? "👍 ✓" : "👍", callback_data: voteCallbackData(pmid, 1) },
      { text: value === 0 ? "👎 ✓" : "👎", callback_data: voteCallbackData(pmid, 0) },
    ],
  ];
}

/** KV key for a vote. One key per (chat, paper): re-voting overwrites. */
export function voteKey(chatId: string, pmid: string): string {
  return `vote:${chatId}:${pmid}`;
}

/** Short toast shown by answerCallbackQuery. */
export function voteAck(value: 0 | 1): string {
  return value === 1 ? "👍 anotado" : "👎 anotado";
}
