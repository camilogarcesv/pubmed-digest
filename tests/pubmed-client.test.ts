// HTTP behaviour of PubMedClient: query building, throttle, retry/backoff and error handling.
// Fully offline — fetch is injected, and so is the backoff so retries don't cost real seconds.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PubMedClient } from "../src/pubmed.js";

const here = dirname(fileURLToPath(import.meta.url));
const sampleXml = readFileSync(resolve(here, "fixtures/efetch-sample.xml"), "utf8");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response("upstream error", { status, headers });
}

/**
 * Returns queued responses in order (repeating the last), recording every URL requested.
 * Takes factories, not Response objects: a Response body can only be read once, so a repeated
 * entry has to produce a fresh instance per call.
 */
function queuedFetch(responses: (() => Response)[]) {
  const urls: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const idx = Math.min(urls.length, responses.length - 1);
    urls.push(String(input));
    return responses[idx]!();
  }) as typeof fetch;
  return { fetchImpl, urls };
}

function client(fetchImpl: typeof fetch, overrides = {}) {
  return new PubMedClient({
    fetchImpl,
    minIntervalMs: 0,
    backoffMsImpl: () => 0,
    email: "test@example.com",
    ...overrides,
  });
}

const OK_SEARCH = { esearchresult: { idlist: ["1", "2"], count: "2" } };

describe("esearch", () => {
  it("builds the request with the edat date window and NCBI etiquette params", async () => {
    const { fetchImpl, urls } = queuedFetch([() => jsonResponse(OK_SEARCH)]);
    await client(fetchImpl, { apiKey: "KEY123" }).esearch('"Eur Radiol"[Journal]', {
      reldate: 8,
      retmax: 200,
    });

    const url = new URL(urls[0]!);
    expect(url.pathname).toContain("esearch.fcgi");
    expect(url.searchParams.get("db")).toBe("pubmed");
    expect(url.searchParams.get("term")).toBe('"Eur Radiol"[Journal]');
    expect(url.searchParams.get("datetype")).toBe("edat");
    expect(url.searchParams.get("reldate")).toBe("8");
    expect(url.searchParams.get("retmax")).toBe("200");
    expect(url.searchParams.get("tool")).toBe("pubmed-digest");
    expect(url.searchParams.get("email")).toBe("test@example.com");
    expect(url.searchParams.get("api_key")).toBe("KEY123");
  });

  it("returns the ids and the total count", async () => {
    const { fetchImpl } = queuedFetch([() => jsonResponse({ esearchresult: { idlist: ["1", "2"], count: "57" } })]);
    const result = await client(fetchImpl).esearch("term", { reldate: 8 });

    expect(result.ids).toEqual(["1", "2"]);
    expect(result.count).toBe(57); // > ids.length, i.e. the caller should warn about truncation
  });

  it("throws when PubMed reports an error for the term", async () => {
    const { fetchImpl } = queuedFetch([() => jsonResponse({ esearchresult: { idlist: [], ERROR: "Invalid field" } })]);
    await expect(client(fetchImpl).esearch("bad[[", { reldate: 8 })).rejects.toThrow(
      /Invalid field/,
    );
  });

  it("throws on an unexpected response shape", async () => {
    const { fetchImpl } = queuedFetch([() => jsonResponse({ nope: true })]);
    await expect(client(fetchImpl).esearch("term", { reldate: 8 })).rejects.toThrow(
      /Unexpected esearch response/,
    );
  });
});

describe("retry and backoff", () => {
  it("retries a 429 and succeeds", async () => {
    const { fetchImpl, urls } = queuedFetch([() => errorResponse(429, { "retry-after": "0" }), () => jsonResponse(OK_SEARCH)]);
    const result = await client(fetchImpl).esearch("term", { reldate: 8 });

    expect(result.ids).toEqual(["1", "2"]);
    expect(urls).toHaveLength(2);
  });

  it("retries a 5xx and succeeds", async () => {
    const { fetchImpl, urls } = queuedFetch([() => errorResponse(503), () => jsonResponse(OK_SEARCH)]);
    await client(fetchImpl).esearch("term", { reldate: 8 });
    expect(urls).toHaveLength(2);
  });

  it("gives up after maxRetries and reports the status", async () => {
    const { fetchImpl, urls } = queuedFetch([() => errorResponse(500)]);
    await expect(
      client(fetchImpl, { maxRetries: 2 }).esearch("term", { reldate: 8 }),
    ).rejects.toThrow(/HTTP 500/);
    expect(urls).toHaveLength(3); // initial attempt + 2 retries
  });

  it("retries a network exception", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return jsonResponse(OK_SEARCH);
    }) as typeof fetch;

    const result = await client(fetchImpl).esearch("term", { reldate: 8 });
    expect(result.ids).toEqual(["1", "2"]);
    expect(calls).toBe(2);
  });

  it("does not retry a 4xx that is not 429", async () => {
    const { fetchImpl, urls } = queuedFetch([() => errorResponse(400)]);
    await expect(client(fetchImpl).esearch("term", { reldate: 8 })).rejects.toThrow(/HTTP 400/);
    expect(urls).toHaveLength(1); // failed fast, no retries
  });
});

describe("throttle", () => {
  it("spaces consecutive requests by at least minIntervalMs", async () => {
    const { fetchImpl } = queuedFetch([() => jsonResponse(OK_SEARCH)]);
    const c = new PubMedClient({ fetchImpl, minIntervalMs: 60, backoffMsImpl: () => 0 });

    const started = Date.now();
    await c.esearch("a", { reldate: 8 });
    await c.esearch("b", { reldate: 8 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(55); // one full interval between the two calls
  });
});

describe("efetch", () => {
  it("requests the PMIDs and parses the returned records", async () => {
    const { fetchImpl, urls } = queuedFetch([() => new Response(sampleXml, { status: 200 })]);
    const papers = await client(fetchImpl).efetch(["40123456", "40123457"]);

    const url = new URL(urls[0]!);
    expect(url.pathname).toContain("efetch.fcgi");
    expect(url.searchParams.get("id")).toBe("40123456,40123457");
    expect(url.searchParams.get("retmode")).toBe("xml");
    expect(papers.map((p) => p.pmid)).toEqual(["40123456", "40123457", "40123458"]);
  });

  it("short-circuits an empty id list without any request", async () => {
    const { fetchImpl, urls } = queuedFetch([() => jsonResponse({})]);
    expect(await client(fetchImpl).efetch([])).toEqual([]);
    expect(urls).toHaveLength(0);
  });
});
