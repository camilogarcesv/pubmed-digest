import { describe, expect, it } from "vitest";
import { chunk, stripArgSeparator } from "../src/util.js";

describe("chunk", () => {
  it("splits into fixed-size groups", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("returns [] for an empty array", () => {
    expect(chunk([], 3)).toEqual([]);
  });
  it("throws on a non-positive size", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe("stripArgSeparator", () => {
  it("removes the pnpm-forwarded -- so flags are parsed, not dropped", () => {
    expect(stripArgSeparator(["digest", "--", "--dry-run"])).toEqual(["digest", "--dry-run"]);
    expect(stripArgSeparator(["search", "glioma MRI", "--", "--dry-run", "--limit", "5"])).toEqual(
      ["search", "glioma MRI", "--dry-run", "--limit", "5"],
    );
  });
  it("is a no-op when there is no separator", () => {
    expect(stripArgSeparator(["digest", "--dry-run"])).toEqual(["digest", "--dry-run"]);
  });
  it("only strips the first separator", () => {
    expect(stripArgSeparator(["a", "--", "b", "--", "c"])).toEqual(["a", "b", "--", "c"]);
  });
});
