import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicScorer, ScoringError, type CreateMessage } from "../src/scoring.js";
import { makePaper as paper, makeProfile } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

const profile = makeProfile();

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

  it("fails instead of assigning artificial zeros after invalid responses", async () => {
    const papers = [paper("1"), paper("2")];
    const { fn, bodies } = queued([
      toolUseMessage([{ pmid: "1", relevance: 15, reason: "fuera de rango" }]), // invalid
      toolUseMessage([{ pmid: "1", relevance: 15, reason: "fuera de rango" }]), // retry invalid
    ]);
    const scorer = new AnthropicScorer(fn, "m", 10);

    const result = scorer.score(papers, { profile });

    await expect(result).rejects.toMatchObject({
      name: "ScoringError",
      kind: "invalid_response",
      pmids: ["1", "2"],
    });
    expect(bodies).toHaveLength(2);
  });

  it("fails when a PMID remains omitted after reconciliation", async () => {
    const { fn, bodies } = queued([
      toolUseMessage([{ pmid: "1", relevance: 8, reason: "a" }]),
      toolUseMessage([]),
    ]);
    const scorer = new AnthropicScorer(fn, "m", 10);

    await expect(scorer.score([paper("1"), paper("2")], { profile })).rejects.toMatchObject({
      kind: "invalid_response",
      pmids: ["2"],
    });
    expect(bodies).toHaveLength(2);
  });

  it("preserves an explicit valid zero returned by the model", async () => {
    const { fn } = queued([
      toolUseMessage([{ pmid: "1", relevance: 0, reason: "No coincide con el perfil." }]),
    ]);
    const scorer = new AnthropicScorer(fn, "m", 10);

    const [scored] = await scorer.score([paper("1")], { profile });

    expect(scored).toMatchObject({ relevance: 0, reason: "No coincide con el perfil." });
  });

  it("does not retry a workspace spend-limit failure", async () => {
    let calls = 0;
    const fn: CreateMessage = async () => {
      calls++;
      throw Object.assign(new Error("Your credit balance is too low"), {
        status: 400,
      });
    };
    const scorer = new AnthropicScorer(fn, "m", 10);

    const result = scorer.score([paper("1")], { profile });

    await expect(result).rejects.toBeInstanceOf(ScoringError);
    await expect(result).rejects.toMatchObject({ kind: "budget_exceeded", pmids: ["1"] });
    expect(calls).toBe(1);
  });

  it("retries a transient API failure once and then fails the whole score operation", async () => {
    let calls = 0;
    const delays: number[] = [];
    const fn: CreateMessage = async () => {
      calls++;
      throw Object.assign(new Error("service unavailable"), {
        status: 503,
        headers: { get: () => "Wed, 21 Oct 2099 07:28:00 GMT" },
      });
    };
    const scorer = new AnthropicScorer(fn, "m", 10, async (ms) => { delays.push(ms); });

    await expect(scorer.score([paper("1")], { profile })).rejects.toMatchObject({
      kind: "transient_api",
    });
    expect(calls).toBe(2);
    expect(delays).toEqual([30_000]);
  });

  it("rejects the whole operation when a later batch fails after an earlier success", async () => {
    let calls = 0;
    const fn: CreateMessage = async () => {
      calls++;
      if (calls === 1) {
        return toolUseMessage([{ pmid: "1", relevance: 8, reason: "válido" }]);
      }
      throw Object.assign(new Error("service unavailable"), { status: 503 });
    };
    const scorer = new AnthropicScorer(fn, "m", 1, async () => undefined);

    await expect(scorer.score([paper("1"), paper("2")], { profile })).rejects.toMatchObject({
      kind: "transient_api",
      pmids: ["2"],
    });
    expect(calls).toBe(3);
    expect(scorer.usage.calls).toBe(1);
  });

  it("accumulates token usage across calls for the run report", async () => {
    const { fn } = queued([
      toolUseMessage([
        { pmid: "1", relevance: 9, reason: "a" },
        { pmid: "2", relevance: 8, reason: "b" },
      ]),
    ]);
    const scorer = new AnthropicScorer(fn, "m", 1); // batchSize 1 => two calls

    await scorer.score([paper("1"), paper("2")], { profile });

    expect(scorer.usage.calls).toBe(2);
    expect(scorer.usage.inputTokens).toBe(2); // 1 per stubbed response
    expect(scorer.usage.outputTokens).toBe(2);
  });

  it("re-ranks the finalists in a single call that tells the model to compare them", async () => {
    const { fn, bodies } = queued([
      toolUseMessage([
        { pmid: "1", relevance: 10, reason: "el mejor" },
        { pmid: "2", relevance: 4, reason: "flojo" },
      ]),
    ]);
    const scorer = new AnthropicScorer(fn, "m", 10);
    const finalists = [
      { ...paper("1"), relevance: 8, reason: "a" },
      { ...paper("2"), relevance: 8, reason: "b" },
    ];

    const refined = await scorer.rerank(finalists, { profile });

    expect(bodies).toHaveLength(1);
    expect(String(bodies[0]!.system)).toContain("SEGUNDA PASADA");
    expect(refined.find((p) => p.pmid === "1")!.relevance).toBe(10);
    expect(refined.find((p) => p.pmid === "2")!.relevance).toBe(4);
  });

  it("skips the rerank call when there is nothing to compare", async () => {
    const { fn, bodies } = queued([toolUseMessage([])]);
    const scorer = new AnthropicScorer(fn, "m", 10);

    const only = [{ ...paper("1"), relevance: 9, reason: "a" }];
    expect(await scorer.rerank(only, { profile })).toEqual(only);
    expect(bodies).toHaveLength(0);
  });

  it("passes publication types and MeSH terms to the model", async () => {
    const { fn, bodies } = queued([toolUseMessage([{ pmid: "1", relevance: 9, reason: "a" }])]);
    const scorer = new AnthropicScorer(fn, "m", 10);

    await scorer.score(
      [
        paper("1", {
          publicationTypes: ["Randomized Controlled Trial"],
          meshTerms: ["Stroke", "Thrombectomy"],
          keywords: ["LVO"],
        }),
      ],
      { profile },
    );

    const userMessage = String(bodies[0]!.messages[0]!.content);
    expect(userMessage).toContain("Tipo de publicación: Randomized Controlled Trial");
    expect(userMessage).toContain("MeSH: Stroke, Thrombectomy");
    expect(userMessage).toContain("Palabras clave: LVO");
  });

  it("omits the metadata lines for records PubMed has not indexed yet", async () => {
    const { fn, bodies } = queued([toolUseMessage([{ pmid: "1", relevance: 9, reason: "a" }])]);
    const scorer = new AnthropicScorer(fn, "m", 10);

    await scorer.score([paper("1")], { profile });

    const userMessage = String(bodies[0]!.messages[0]!.content);
    expect(userMessage).not.toContain("MeSH:");
    expect(userMessage).not.toContain("Tipo de publicación:");
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
