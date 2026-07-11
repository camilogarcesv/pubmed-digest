import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicScorer, type CreateMessage } from "../src/scoring.js";
import type { Paper } from "../src/types.js";
import type { Profile } from "../src/profile.js";

const here = dirname(fileURLToPath(import.meta.url));

const profile: Profile = {
  description: "Perfil de prueba.",
  topics: [],
  must_have: [],
  nice_to_have: [],
  exclude: [],
  exemplar_papers: [],
};

function paper(pmid: string, overrides: Partial<Paper> = {}): Paper {
  return {
    pmid,
    title: `Título ${pmid}`,
    abstract: "resumen",
    hasAbstract: true,
    authors: [],
    journal: "Revista",
    pubDate: "2026",
    source: "",
    ...overrides,
  };
}

function toolUseMessage(scores: unknown): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: "tool_use", id: "toolu_1", name: "submit_scores", input: { scores } }],
  } as unknown as Anthropic.Message;
}

/** A createMessage stub that returns queued responses in order, recording the request bodies. */
function queued(responses: Anthropic.Message[]) {
  const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const fn: CreateMessage = async (body) => {
    const idx = Math.min(bodies.length, responses.length - 1);
    bodies.push(body);
    return responses[idx]!;
  };
  return { fn, bodies };
}

describe("AnthropicScorer", () => {
  it("scores every paper when the model returns them all", async () => {
    const papers = [paper("1"), paper("2"), paper("3")];
    const { fn, bodies } = queued([
      toolUseMessage([
        { pmid: "1", relevance: 9, reason: "muy relevante" },
        { pmid: "2", relevance: 3, reason: "poco relevante" },
        { pmid: "3", relevance: 7, reason: "relevante" },
      ]),
    ]);
    const scorer = new AnthropicScorer(fn, "claude-haiku-4-5", 10);

    const scored = await scorer.score(papers, { profile });

    expect(scored.map((s) => s.pmid)).toEqual(["1", "2", "3"]);
    expect(scored.find((s) => s.pmid === "1")!.relevance).toBe(9);
    expect(bodies).toHaveLength(1);
  });

  it("re-scores omitted pmids and drops hallucinated ones (reconciliation)", async () => {
    const papers = [paper("1"), paper("2"), paper("3")];
    const { fn, bodies } = queued([
      // First call omits pmid 3 and invents an unknown pmid 999.
      toolUseMessage([
        { pmid: "1", relevance: 8, reason: "a" },
        { pmid: "2", relevance: 2, reason: "b" },
        { pmid: "999", relevance: 10, reason: "alucinado" },
      ]),
      // Reconcile call returns the missing pmid 3.
      toolUseMessage([{ pmid: "3", relevance: 6, reason: "c" }]),
    ]);
    const scorer = new AnthropicScorer(fn, "m", 10);

    const scored = await scorer.score(papers, { profile });

    expect(scored.map((s) => s.pmid)).toEqual(["1", "2", "3"]);
    expect(scored.find((s) => s.pmid === "3")!.relevance).toBe(6);
    expect(scored.some((s) => s.pmid === "999")).toBe(false);
    expect(bodies).toHaveLength(2); // initial + one reconcile call
  });

  it("assigns a neutral score after a batch fails validation twice", async () => {
    const papers = [paper("1"), paper("2")];
    const { fn, bodies } = queued([
      toolUseMessage([{ pmid: "1", relevance: 15, reason: "fuera de rango" }]), // invalid
      toolUseMessage([{ pmid: "1", relevance: 15, reason: "fuera de rango" }]), // retry invalid
    ]);
    const scorer = new AnthropicScorer(fn, "m", 10);

    const scored = await scorer.score(papers, { profile });

    expect(scored).toHaveLength(2);
    for (const s of scored) {
      expect(s.relevance).toBe(0);
      expect(s.reason).toBe("No evaluado por el modelo.");
    }
    expect(bodies).toHaveLength(2); // two attempts, no reconcile (first call yielded nothing)
  });

  it("validates the documented sample tool output", async () => {
    const fixture = JSON.parse(
      readFileSync(resolve(here, "fixtures/submit-scores.json"), "utf8"),
    ) as { scores: unknown };
    const papers = [paper("40123456"), paper("40123457")];
    const { fn } = queued([toolUseMessage(fixture.scores)]);
    const scorer = new AnthropicScorer(fn, "m", 10);

    const scored = await scorer.score(papers, { profile });

    expect(scored.find((s) => s.pmid === "40123456")!.relevance).toBe(9);
    expect(scored.find((s) => s.pmid === "40123457")!.relevance).toBe(2);
  });
});
