// Delivery behind a thin interface so Telegram can be swapped later.

export interface Deliverer {
  send(text: string): Promise<void>;
}

const TELEGRAM_LIMIT = 4096;

/** Prints to stdout. Used for --dry-run and when no delivery target is configured. */
export class ConsoleDeliverer implements Deliverer {
  async send(text: string): Promise<void> {
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  }
}

export class TelegramDeliverer implements Deliverer {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(text: string): Promise<void> {
    for (const part of splitForTelegram(text)) {
      await this.sendChunk(part);
    }
  }

  private async sendChunk(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${body}`.trim());
    }
  }
}

/**
 * Split text into <= limit-char chunks, preferring to break on newlines so a
 * digest entry is never cut mid-line. A single over-long line is hard-split.
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
