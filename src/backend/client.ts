// Typed client for the Worker's internal digest API (/internal/v1). Node never reaches D1 or,
// on the D1 path, Telegram directly: every write goes through these fenced, idempotent routes.

import { z } from "zod";
import {
  CreateRun, DigestItem, PrepareRun, SystemMode, UserId,
  type DeliveryOutcome, type EvalVote, type RunProgress, type RunRecord, type UserContext,
} from "../multiuser/contracts.js";
import { chunk, sleep } from "../util.js";

export type BackendUser = UserContext & { status?: "active" | "paused" };

/** Everything the multi-user digest needs from the backend; tests substitute an in-memory fake. */
export interface DigestBackend {
  mode(): Promise<z.infer<typeof SystemMode>>;
  contexts(): Promise<BackendUser[]>;
  context(slug: string): Promise<BackendUser>;
  seen(pairs: { userId: string; pmid: string }[]): Promise<boolean[]>;
  evalContext(userId: string): Promise<EvalVote[]>;
  runs(userId: string, period: string): Promise<RunProgress[]>;
  createRun(input: z.infer<typeof CreateRun>): Promise<RunRecord>;
  putItems(userId: string, runId: string, chunkIndex: number, items: z.infer<typeof DigestItem>[]): Promise<void>;
  prepare(userId: string, runId: string, body: z.infer<typeof PrepareRun>): Promise<RunProgress>;
  deliver(userId: string, runId: string, destinationId: string): Promise<DeliveryOutcome>;
  abort(userId: string, runId: string): Promise<RunProgress>;
  opsAlert(text: string): Promise<{ sent: number; failed: number }>;
}

/** A refused request; `code` is the API's error code (e.g. mode_unavailable, conflict). */
export class BackendError extends Error {
  override readonly name = "BackendError";
  constructor(readonly status: number, readonly code: string) {
    super(`Backend request failed (${status} ${code})`);
  }
}

const SEEN_BATCH = 50;
const ATTEMPTS = 3;
const ErrorBody = z.object({ error: z.object({ code: z.string() }) });

/** Worker origin only: https, or http on localhost for local rehearsals. */
export function backendOrigin(input: string): string {
  const url = new URL(input);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !local)) {
    throw new Error("Invalid backend origin");
  }
  return url.origin;
}

export function httpBackend(
  origin: string,
  secret: string,
  options: { fetch?: typeof fetch; wait?: (ms: number) => Promise<void>; timeoutMs?: number } = {},
): DigestBackend {
  const base = backendOrigin(origin);
  if (secret.length < 32) throw new Error("Digest service credential required");
  const fetcher = options.fetch ?? fetch;
  const wait = options.wait ?? sleep;

  /**
   * Every write route is idempotent (stable run key, chunk hashes, identical prepare, an ordered
   * claim per message), so transport failures and 5xx are retried; a refusal (4xx) never is.
   */
  async function call(path: string, init: { method?: string; body?: unknown } = {}, retry = true): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      let response: Response | undefined;
      try {
        response = await fetcher(`${base}/internal/v1${path}`, {
          method: init.method ?? (init.body === undefined ? "GET" : "POST"),
          headers: { authorization: `Bearer ${secret}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        });
      } catch (error) {
        if (!retry || attempt >= ATTEMPTS) throw error;
      }
      if (response) {
        if (response.ok && response.headers.get("cache-control") === "no-store") return response.json();
        if (response.ok) throw new BackendError(response.status, "unexpected_cache_policy");
        const parsed = ErrorBody.safeParse(await response.json().catch(() => null));
        const error = new BackendError(response.status, parsed.success ? parsed.data.error.code : "unknown");
        if (response.status < 500 || !retry || attempt >= ATTEMPTS) throw error;
      }
      await wait(1000 * 2 ** (attempt - 1));
    }
  }
  const user = (id: string) => `/users/${UserId.parse(id)}`;
  const run = (userId: string, runId: string) => `${user(userId)}/digest-runs/${z.uuid().parse(runId)}`;
  const Progress = z.custom<RunProgress>(v => typeof v === "object" && v !== null && "status" in v);

  return {
    async mode() { return z.object({ mode: SystemMode }).parse(await call("/mode")).mode; },
    async contexts() { return z.object({ users: z.array(z.custom<BackendUser>()) }).parse(await call("/contexts")).users; },
    async context(slug) { return z.object({ user: z.custom<BackendUser>() }).parse(await call(`/users/by-slug/${encodeURIComponent(slug)}/context`)).user; },
    async seen(pairs) {
      const out: boolean[] = [];
      for (const batch of chunk(pairs, SEEN_BATCH)) {
        out.push(...z.object({ seen: z.array(z.boolean()).length(batch.length) }).parse(await call("/seen/check", { body: { pairs: batch } })).seen);
      }
      return out;
    },
    async evalContext(userId) { return z.object({ votes: z.array(z.custom<EvalVote>()) }).parse(await call(`${user(userId)}/eval-context`)).votes; },
    async runs(userId, period) { return z.object({ runs: z.array(Progress) }).parse(await call(`${user(userId)}/digest-runs?period=${encodeURIComponent(period)}`)).runs; },
    async createRun(input) {
      return z.object({ run: z.custom<RunRecord>() }).parse(await call(`${user(input.userId)}/digest-runs`, { body: CreateRun.parse(input) })).run;
    },
    async putItems(userId, runId, chunkIndex, items) {
      await call(`${run(userId, runId)}/items/${chunkIndex}`, { method: "PUT", body: { items } });
    },
    async prepare(userId, runId, body) { return Progress.parse(await call(`${run(userId, runId)}/prepare`, { body: PrepareRun.parse(body) })); },
    async deliver(userId, runId, destinationId) {
      return z.custom<DeliveryOutcome>(v => typeof v === "object" && v !== null && "state" in v)
        .parse(await call(`${run(userId, runId)}/destinations/${z.uuid().parse(destinationId)}/deliver`, { body: {} }));
    },
    async abort(userId, runId) { return Progress.parse(await call(`${run(userId, runId)}/abort`, { body: {} })); },
    // An alert that timed out may have been sent: never retried, so it is never duplicated.
    async opsAlert(text) {
      return z.object({ sent: z.number(), failed: z.number() }).parse(await call("/ops/alerts", { body: { text } }, false));
    },
  };
}

/** The Worker's internal API: DIGEST_API_ORIGIN, or the vote export's origin by default. */
export function backendFromEnv(env: { DIGEST_API_ORIGIN?: string; VOTES_URL?: string; DIGEST_SERVICE_SECRET?: string }): DigestBackend {
  const origin = env.DIGEST_API_ORIGIN ?? env.VOTES_URL;
  if (!origin || !env.DIGEST_SERVICE_SECRET) {
    throw new Error("The D1 backend requires DIGEST_SERVICE_SECRET and the Worker origin (DIGEST_API_ORIGIN or VOTES_URL).");
  }
  // Validated as given (credentials, query or fragment are refused); only the path is dropped.
  return httpBackend(origin, env.DIGEST_SERVICE_SECRET);
}
