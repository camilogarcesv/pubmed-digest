import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Paper, ScoredPaper } from "./types.js";
import type { Profile } from "./profile.js";
import { logger } from "./logger.js";
import { chunk } from "./util.js";

export const SCORE_TOOL_NAME = "submit_scores";

const ScoreSchema = z.object({
  pmid: z.string(),
  relevance: z.number().int().min(0).max(10),
  reason: z.string().min(1),
});
const SubmitScoresSchema = z.object({ scores: z.array(ScoreSchema) });

export type RawScore = z.infer<typeof ScoreSchema>;

// Forced-tool schema. NOTE: we intentionally do NOT set `strict: true` — strict schemas
// reject `minimum`/`maximum`, so the 0-10 range is enforced by zod above instead.
export const submitScoresTool: Anthropic.Tool = {
  name: SCORE_TOOL_NAME,
  description:
    "Submit a relevance score for every paper provided. Return exactly one entry per pmid.",
  input_schema: {
    type: "object",
    properties: {
      scores: {
        type: "array",
        items: {
          type: "object",
          properties: {
            pmid: { type: "string", description: "PubMed ID, copied exactly from the input." },
            relevance: {
              type: "integer",
              minimum: 0,
              maximum: 10,
              description: "0 = irrelevant, 10 = perfect match.",
            },
            reason: {
              type: "string",
              description: "One short sentence, in SPANISH, justifying the score.",
            },
          },
          required: ["pmid", "relevance", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["scores"],
    additionalProperties: false,
  },
};

export interface ScoreContext {
  profile: Profile;
  /** Present in `search` mode: the topic becomes the primary relevance criterion. */
  topic?: string;
}

const NEUTRAL_REASON = "No evaluado por el modelo.";

export function buildSystemPrompt(profile: Profile, topic?: string): string {
  const lines: string[] = [];
  lines.push(
    "Eres un asistente experto que evalúa la relevancia de artículos científicos de PubMed para un radiólogo.",
  );
  lines.push("");
  if (topic) {
    lines.push(`CRITERIO PRINCIPAL: el usuario busca artículos sobre el tema "${topic}".`);
    lines.push(
      "Prioriza la relevancia respecto a ESE tema por encima de todo. Usa el perfil de interés " +
        "solo como desempate entre artículos igualmente relevantes al tema.",
    );
  } else {
    lines.push(
      "Evalúa cada artículo según su relevancia para el PERFIL DE INTERÉS del radiólogo descrito abajo.",
    );
  }
  lines.push("");
  lines.push("PERFIL DE INTERÉS:");
  lines.push(profile.description.trim());
  if (profile.topics.length) lines.push(`Temas de interés: ${profile.topics.join("; ")}.`);
  if (profile.must_have.length) lines.push(`Debe cumplir: ${profile.must_have.join("; ")}.`);
  if (profile.nice_to_have.length) lines.push(`Suma puntos: ${profile.nice_to_have.join("; ")}.`);
  if (profile.exclude.length) lines.push(`Resta puntos / excluir: ${profile.exclude.join("; ")}.`);
  if (profile.exemplar_papers.length) {
    lines.push(
      `Ejemplos de artículos que le encantaron: ${profile.exemplar_papers
        .map((e) => e.title)
        .join("; ")}.`,
    );
  }
  lines.push("");
  lines.push("RÚBRICA (entero 0–10):");
  lines.push("- 9–10: coincidencia excelente, justo lo que busca.");
  lines.push("- 7–8: claramente relevante y útil.");
  lines.push("- 4–6: tangencialmente relacionado.");
  lines.push("- 1–3: poco relevante.");
  lines.push("- 0: irrelevante o excluido.");
  lines.push("");
  lines.push(
    "Puntúa CADA artículo con la herramienta submit_scores, copiando el pmid EXACTAMENTE. " +
      "La razón debe ser UNA sola frase corta en ESPAÑOL. " +
      'Si un artículo no tiene resumen (solo título), puntúalo con lo disponible e indícalo con "(sin resumen)".',
  );
  // COST: the system prompt (profile + rubric) is identical across batches — a natural prompt-caching
  // prefix, and batches are a natural Batch API workload. Neither is implemented in this MVP.
  return lines.join("\n");
}

export function buildUserMessage(papers: Paper[]): string {
  const blocks = papers.map((p, i) => {
    const authors = p.authors
      .slice(0, 6)
      .map((a) => [a.lastName, a.foreName].filter(Boolean).join(" "))
      .filter(Boolean)
      .join(", ");
    const abstract = p.hasAbstract ? p.abstract : "(sin resumen disponible)";
    return [
      `### Artículo ${i + 1}`,
      `pmid: ${p.pmid}`,
      `Título: ${p.title}`,
      `Revista: ${p.journal}`,
      `Autores: ${authors || "(no listados)"}`,
      `Resumen: ${abstract}`,
    ].join("\n");
  });
  return `Evalúa los siguientes ${papers.length} artículos:\n\n${blocks.join("\n\n")}`;
}

export type CreateMessage = (
  body: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

export interface Scorer {
  score(papers: Paper[], ctx: ScoreContext): Promise<ScoredPaper[]>;
}

export class AnthropicScorer implements Scorer {
  constructor(
    private readonly createMessage: CreateMessage,
    private readonly model: string,
    private readonly batchSize: number,
  ) {}

  async score(papers: Paper[], ctx: ScoreContext): Promise<ScoredPaper[]> {
    const scored: ScoredPaper[] = [];
    for (const batch of chunk(papers, this.batchSize)) {
      const results = await this.scoreBatchWithReconcile(batch, ctx);
      for (const paper of batch) {
        const s = results.get(paper.pmid)!; // reconcile guarantees an entry for every pmid
        scored.push({ ...paper, relevance: s.relevance, reason: s.reason });
      }
    }
    return scored;
  }

  /** Always returns a map covering every pmid in the batch (missing ones get a neutral score). */
  private async scoreBatchWithReconcile(
    batch: Paper[],
    ctx: ScoreContext,
  ): Promise<Map<string, { relevance: number; reason: string }>> {
    const wanted = new Set(batch.map((p) => p.pmid));
    const result = new Map<string, { relevance: number; reason: string }>();

    const first = await this.callBatchSafe(batch, ctx);
    if (first) {
      for (const s of first) {
        if (!wanted.has(s.pmid)) {
          logger.warn("scorer returned a pmid we did not send, dropping", { pmid: s.pmid });
          continue;
        }
        result.set(s.pmid, { relevance: s.relevance, reason: s.reason });
      }
    }

    // Reconcile: re-score any pmids the model omitted (once), but only if the first call succeeded.
    const missing = batch.filter((p) => !result.has(p.pmid));
    if (missing.length > 0 && first !== null) {
      logger.warn("re-scoring pmids missing from model output", {
        count: missing.length,
        pmids: missing.map((p) => p.pmid),
      });
      const missingSet = new Set(missing.map((p) => p.pmid));
      const retry = await this.callBatchSafe(missing, ctx);
      if (retry) {
        for (const s of retry) {
          if (missingSet.has(s.pmid)) result.set(s.pmid, { relevance: s.relevance, reason: s.reason });
        }
      }
    }

    // Anything still unscored gets a neutral, below-threshold score so it is never silently dropped.
    for (const p of batch) {
      if (!result.has(p.pmid)) {
        logger.warn("assigning neutral score to unscored paper", { pmid: p.pmid });
        result.set(p.pmid, { relevance: 0, reason: NEUTRAL_REASON });
      }
    }
    return result;
  }

  /** One scoring call with a single retry on parse/validation/API failure; null if both fail. */
  private async callBatchSafe(batch: Paper[], ctx: ScoreContext): Promise<RawScore[] | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.callBatch(batch, ctx);
      } catch (err) {
        logger.warn("scoring batch attempt failed", { attempt, error: String(err) });
      }
    }
    logger.error("scoring batch skipped after retry", { pmids: batch.map((p) => p.pmid) });
    return null;
  }

  private async callBatch(batch: Paper[], ctx: ScoreContext): Promise<RawScore[]> {
    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: 4096,
      system: buildSystemPrompt(ctx.profile, ctx.topic),
      tools: [submitScoresTool],
      tool_choice: { type: "tool", name: SCORE_TOOL_NAME },
      messages: [{ role: "user", content: buildUserMessage(batch) }],
    };

    const res = await this.createMessage(body);
    const block = res.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      throw new Error(
        `Expected a ${SCORE_TOOL_NAME} tool_use block, got stop_reason=${res.stop_reason}`,
      );
    }
    const parsed = SubmitScoresSchema.safeParse(block.input);
    if (!parsed.success) {
      throw new Error(`submit_scores output failed validation: ${parsed.error.message}`);
    }
    return parsed.data.scores;
  }
}

export function makeAnthropicScorer(
  apiKey: string,
  model: string,
  batchSize: number,
): AnthropicScorer {
  const client = new Anthropic({ apiKey });
  return new AnthropicScorer((body) => client.messages.create(body), model, batchSize);
}
