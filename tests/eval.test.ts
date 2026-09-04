// Pure eval metrics — the arithmetic that turns votes into a tuning signal.

import { describe, expect, it } from "vitest";
import { computeEvalMetrics, joinVotes, type Vote } from "../src/votes.js";

function vote(pmid: string, value: 0 | 1, votedAt = "2026-08-01T00:00:00Z"): Vote {
  return { pmid, value, chatId: "111", votedAt };
}

describe("joinVotes", () => {
  const scoreOf = (pmid: string) =>
    ({ "1": { title: "Uno", score: 9 }, "2": { title: "Dos", score: 4 } })[pmid];

  it("attaches title and score, separating votes it cannot join", () => {
    const { joined, unjoined } = joinVotes([vote("1", 1), vote("2", 0), vote("999", 1)], scoreOf);
    expect(joined).toEqual([
      { pmid: "1", title: "Uno", value: 1, score: 9 },
      { pmid: "2", title: "Dos", value: 0, score: 4 },
    ]);
    expect(unjoined).toHaveLength(1);
    expect(unjoined[0]!.pmid).toBe("999");
  });

  it("keeps only the newest vote per pmid", () => {
    const { joined } = joinVotes(
      [vote("1", 0, "2026-08-01T00:00:00Z"), vote("1", 1, "2026-08-02T00:00:00Z")],
      scoreOf,
    );
    expect(joined).toHaveLength(1);
    expect(joined[0]!.value).toBe(1); // the re-vote won
  });
});

describe("computeEvalMetrics", () => {
  it("computes averages, separation inputs and precision@k", () => {
    const joined = [
      { pmid: "1", title: "a", value: 1 as const, score: 9 },
      { pmid: "2", title: "b", value: 1 as const, score: 8 },
      { pmid: "3", title: "c", value: 0 as const, score: 3 },
      { pmid: "4", title: "d", value: 0 as const, score: 8 }, // false positive
    ];
    const m = computeEvalMetrics(joined, 7, 3, 4);

    expect(m.status).toBe("ready");
    expect(m.liked).toBe(2);
    expect(m.disliked).toBe(2);
    expect(m.likedAvg).toBe(8.5);
    expect(m.dislikedAvg).toBe(5.5);
    // top-3 by score: 9(👍), 8(👍), 8(👎) -> 2/3
    expect(m.precisionAtK).toBeCloseTo(2 / 3);
    expect(m.k).toBe(3);
  });

  it("flags disagreements on both sides, worst first", () => {
    const joined = [
      { pmid: "gem", title: "joya ignorada", value: 1 as const, score: 2 }, // liked, scored 2
      { pmid: "meh", title: "sobrevalorado", value: 0 as const, score: 9 }, // disliked, scored 9
      { pmid: "ok", title: "acuerdo", value: 1 as const, score: 9 },
    ];
    const m = computeEvalMetrics(joined, 7);

    expect(m.disagreements.map((d) => d.pmid)).toEqual(["gem", "meh"]); // |2-7|=5 > |9-7|=2
  });

  it("handles an all-liked vote set without NaN", () => {
    const m = computeEvalMetrics([{ pmid: "1", title: "a", value: 1, score: 9 }], 7);
    expect(m.status).toBe("insufficient_data");
    expect(m.hasBothClasses).toBe(false);
    expect(m.dislikedAvg).toBeUndefined();
    expect(m.precisionAtK).toBeUndefined();
  });

  it("reports insufficient_data below 15 unique votes even with both classes", () => {
    const joined = Array.from({ length: 14 }, (_, i) => ({
      pmid: String(i),
      title: String(i),
      value: (i % 2) as 0 | 1,
      score: i % 11,
    }));

    const m = computeEvalMetrics(joined, 7);

    expect(m.status).toBe("insufficient_data");
    expect(m.minimumVotes).toBe(15);
    expect(m.hasBothClasses).toBe(true);
    expect(m.precisionAtK).toBeUndefined();
  });

  it("reports insufficient_data with 15 votes when only one class exists", () => {
    const joined = Array.from({ length: 15 }, (_, i) => ({
      pmid: String(i), title: String(i), value: 1 as const, score: 9,
    }));
    expect(computeEvalMetrics(joined, 7).status).toBe("insufficient_data");
  });

  it("handles the empty case", () => {
    const m = computeEvalMetrics([], 7);
    expect(m.status).toBe("insufficient_data");
    expect(m.precisionAtK).toBeUndefined();
    expect(m.disagreements).toEqual([]);
  });
});
