import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchVotes, loadVotesFile } from "../src/votes.js";
import { buildSystemPrompt } from "../src/scoring.js";
import { makeProfile } from "./helpers.js";

const VOTES = {
  votes: [
    { pmid: "1", value: 1, chatId: "111", votedAt: "2026-08-01T00:00:00Z" },
    { pmid: "2", value: 0, chatId: "111", votedAt: "2026-08-01T00:00:00Z" },
  ],
};

function stubFetch(status: number, body: unknown) {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("fetchVotes", () => {
  it("sends the bearer secret and parses the votes", async () => {
    let auth: string | null = null;
    const impl = (async (_url: unknown, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify(VOTES), { status: 200 });
    }) as unknown as typeof fetch;

    const votes = await fetchVotes("https://w.example/votes", "s3cret", impl);

    expect(auth).toBe("Bearer s3cret");
    expect(votes).toHaveLength(2);
    expect(votes[0]).toMatchObject({ pmid: "1", value: 1 });
  });

  it("throws on a non-2xx response", async () => {
    await expect(fetchVotes("https://w.example/votes", "x", stubFetch(403, {}))).rejects.toThrow(
      /HTTP 403/,
    );
  });

  it("throws on an unexpected shape", async () => {
    await expect(
      fetchVotes("https://w.example/votes", "x", stubFetch(200, { nope: [] })),
    ).rejects.toThrow(/unexpected shape/);
  });
});

describe("loadVotesFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pubmed-votes-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads and validates a local dump", async () => {
    const path = join(dir, "votes.json");
    writeFileSync(path, JSON.stringify(VOTES));
    expect(await loadVotesFile(path)).toHaveLength(2);
  });

  it("rejects an invalid dump", async () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ votes: [{ pmid: 1 }] }));
    await expect(loadVotesFile(path)).rejects.toThrow(/validation/);
  });
});

describe("dynamic exemplars in the prompt", () => {
  it("injects liked and disliked titles as distinct signals", () => {
    const prompt = buildSystemPrompt({
      profile: makeProfile(),
      exemplars: { liked: ["Trombectomía tardía"], disliked: ["Física de RF sin clínica"] },
    });
    expect(prompt).toContain("VOTADOS 👍 recientemente (más de esto): Trombectomía tardía.");
    expect(prompt).toContain("VOTADOS 👎");
    expect(prompt).toContain("Física de RF sin clínica");
  });

  it("emits neither line without exemplars", () => {
    const prompt = buildSystemPrompt({ profile: makeProfile() });
    expect(prompt).not.toContain("VOTADOS");
  });
});
