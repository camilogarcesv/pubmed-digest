// `pnpm digest:reconcile` — resolve one delivery message the Worker left failed or unknown.
//
//   pnpm digest:reconcile --origin <worker> --user-id <uuid> --run <uuid> --message <uuid> \
//     --action mark_sent|retry --reason "<why>" [--telegram-message-id <n>] [--actor <name>]
//
// mark_sent: the reader did receive it (check the chat first). retry: it was not received and may
// be sent again by the next digest run. Requires IMPORT_SERVICE_SECRET; every resolution is audited.

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { ResolveMessage, UserId } from "../multiuser/contracts.js";
import { backendOrigin } from "../backend/client.js";
import { stripArgSeparator } from "../util.js";

export async function resolveMessage(input: {
  origin: string; secret: string; userId: string; runId: string; messageId: string; resolution: unknown;
}, fetcher: typeof fetch = fetch): Promise<{ status: string; messages: Record<string, number> }> {
  if (input.secret.length < 32) throw new Error("Import credential required");
  const path = `/internal/v1/admin/users/${UserId.parse(input.userId)}/digest-runs/${z.uuid().parse(input.runId)}/messages/${z.uuid().parse(input.messageId)}/resolve`;
  const response = await fetcher(`${backendOrigin(input.origin)}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${input.secret}`, "content-type": "application/json" },
    body: JSON.stringify(ResolveMessage.parse(input.resolution)), redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  // Not retried: a lost response is checked by running the digest again, which reports the state.
  if (!response.ok || response.headers.get("cache-control") !== "no-store") {
    const code = z.object({ error: z.object({ code: z.string() }) }).safeParse(await response.json().catch(() => null));
    throw new Error(`Resolution refused (${response.status} ${code.success ? code.data.error.code : "unknown"})`);
  }
  return z.object({ status: z.string(), messages: z.record(z.string(), z.number()) }).parse(await response.json());
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: stripArgSeparator(process.argv.slice(2)), options: {
    origin: { type: "string" }, "user-id": { type: "string" }, run: { type: "string" }, message: { type: "string" },
    action: { type: "string" }, reason: { type: "string" }, actor: { type: "string", default: "operator" },
    "telegram-message-id": { type: "string" },
  } });
  const result = await resolveMessage({
    origin: z.string().parse(values.origin), secret: process.env.IMPORT_SERVICE_SECRET ?? "",
    userId: z.string().parse(values["user-id"]), runId: z.string().parse(values.run), messageId: z.string().parse(values.message),
    resolution: { action: values.action, actor: values.actor, reason: values.reason, telegramMessageId: values["telegram-message-id"] ?? null },
  });
  // Counts only: identifiers and chat content stay out of the terminal log.
  process.stdout.write(JSON.stringify({ resolved: true, run: result.status, messages: result.messages }, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: "digest_reconcile_failed", detail: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
