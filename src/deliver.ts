// Delivery behind a thin interface so Telegram can be swapped later.

import { logger } from "./logger.js";
import { sleep } from "./util.js";
import type { InlineButton } from "./feedback.js";

/**
 * One outgoing message. A digest is a sequence of these — header, one per paper (each with its
 * own 👍/👎 keyboard, since Telegram anchors an inline keyboard to a single message), footer.
 */
export interface OutMessage {
  text: string;
  keyboard?: InlineButton[][];
}

export interface Deliverer {
  send(messages: OutMessage[]): Promise<void>;
}

const TELEGRAM_LIMIT = 4096;
/** Pause between consecutive messages to one chat. Telegram sustains ~1 msg/s per chat. */
const INTER_MESSAGE_MS = 350;

/** Prints to stdout. Used for --dry-run and when no delivery target is configured. */
export class ConsoleDeliverer implements Deliverer {
  async send(messages: OutMessage[]): Promise<void> {
    const text = messages.map((m) => m.text).join("\n\n");
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  }
}

export class TelegramDeliverer implements Deliverer {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly interMessageMs: number = INTER_MESSAGE_MS,
  ) {}

  async send(messages: OutMessage[]): Promise<void> {
    let first = true;
    for (const message of messages) {
      const chunks = splitForTelegram(message.text);
      for (let i = 0; i < chunks.length; i++) {
        if (!first) await sleep(this.interMessageMs);
        first = false;
        // The keyboard goes on the LAST chunk so the buttons sit under the content they vote on.
        const keyboard = i === chunks.length - 1 ? message.keyboard : undefined;
        await this.sendChunk(chunks[i]!, keyboard);
      }
    }
  }

  private async sendChunk(text: string, keyboard?: InlineButton[][]): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body: Record<string, unknown> = {
      chat_id: this.chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (keyboard) body.reply_markup = { inline_keyboard: keyboard };

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const resBody = await res.text().catch(() => "");
      throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${resBody}`.trim());
    }
  }
}

/**
 * Fans a message out to several named deliverers. Attempts every recipient even if one
 * fails (so a bad friend chat id never blocks delivery to you), logs each result, and
 * throws an aggregated error at the end if any failed.
 */
export class MultiDeliverer implements Deliverer {
  constructor(private readonly targets: { name: string; deliverer: Deliverer }[]) {}

  async send(messages: OutMessage[]): Promise<void> {
    const failures: string[] = [];
    for (const { name, deliverer } of this.targets) {
      try {
        await deliverer.send(messages);
        logger.info("delivered", { recipient: name, messages: messages.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("delivery failed", { recipient: name, error: message });
        failures.push(`${name}: ${message}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Delivery failed for ${failures.length} recipient(s):\n  ${failures.join("\n  ")}`,
      );
    }
  }
}

/**
 * Split text into <= limit-char chunks, breaking on newlines so a digest entry is never cut
 * mid-line. Since renderers emit every HTML tag opened and closed within a single line,
 * breaking only at newlines also guarantees no chunk ends inside a tag — which Telegram would
 * reject with "can't parse entities". The hard-split below is an unreachable last resort kept
 * for safety: titles and reasons are truncated so no single line approaches the limit.
 */
export function splitForTelegram(text: string, limit = TELEGRAM_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    if (current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
