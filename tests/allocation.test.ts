import { describe, expect, it } from "vitest";
import { allocate, isoWeek } from "../src/multiuser/allocation.js";

describe("isoWeek", () => {
  it.each([
    ["2026-09-21T12:00:00Z", "2026-W39"], // Monday digest
    ["2026-09-27T23:59:59Z", "2026-W39"], // Sunday closes the same week
    ["2026-09-28T00:00:00Z", "2026-W40"],
    ["2026-01-01T00:00:00Z", "2026-W01"], // Thursday: week 1 of its own year
    ["2027-01-01T00:00:00Z", "2026-W53"], // Friday: last week of the previous year
    ["2021-01-03T00:00:00Z", "2020-W53"],
    ["2024-12-30T00:00:00Z", "2025-W01"], // Monday of a week whose Thursday is in 2025
  ])("%s is %s", (instant, week) => {
    expect(isoWeek(new Date(instant))).toBe(week);
  });
});

describe("allocate", () => {
  it("equals a plain cap for a single user", () => {
    const pmids = Array.from({ length: 300 }, (_, i) => String(i));
    expect(allocate(new Map([["alice", pmids]]), 250).get("alice")).toEqual(pmids.slice(0, 250));
  });

  it("splits the budget round-robin, keeps each order and hands unused shares on", () => {
    const got = allocate(new Map([["alice", ["a1", "a2", "a3", "a4"]], ["bob", ["b1"]], ["carol", ["c1", "c2", "c3"]]]), 6);
    expect(Object.fromEntries(got)).toEqual({ alice: ["a1", "a2", "a3"], bob: ["b1"], carol: ["c1", "c2"] });
    const shared = allocate(new Map([["alice", ["1", "2"]], ["bob", ["1", "3"]]]), 3);
    expect(Object.fromEntries(shared)).toEqual({ alice: ["1", "2"], bob: ["1"] });
  });

  it("handles empty candidates and budgets without looping", () => {
    expect(Object.fromEntries(allocate(new Map([["alice", []], ["bob", []]]), 250))).toEqual({ alice: [], bob: [] });
    expect(Object.fromEntries(allocate(new Map([["alice", ["1"]]]), 0))).toEqual({ alice: [] });
  });
});
