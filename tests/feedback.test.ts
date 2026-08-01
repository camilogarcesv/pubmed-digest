import { describe, expect, it } from "vitest";
import {
  confirmedKeyboard,
  parseCallback,
  voteAck,
  voteCallbackData,
  voteKey,
  voteKeyboard,
} from "../src/feedback.js";

describe("parseCallback", () => {
  it("round-trips what voteCallbackData produces", () => {
    expect(parseCallback(voteCallbackData("42527307", 1))).toEqual({ pmid: "42527307", value: 1 });
    expect(parseCallback(voteCallbackData("42527307", 0))).toEqual({ pmid: "42527307", value: 0 });
  });

  it("ignores anything that is not a well-formed vote", () => {
    for (const bad of ["", "v:", "v:abc:1", "v:123:2", "v:123", "x:123:1", "v:123:1:extra"]) {
      expect(parseCallback(bad)).toBeNull();
    }
  });

  it("stays far under Telegram's 64-byte callback_data cap", () => {
    expect(voteCallbackData("999999999999", 1).length).toBeLessThan(64);
  });
});

describe("keyboards", () => {
  it("builds one row with a thumbs-up and a thumbs-down", () => {
    const [row] = voteKeyboard("123");
    expect(row).toHaveLength(2);
    expect(row![0]).toEqual({ text: "👍", callback_data: "v:123:1" });
    expect(row![1]).toEqual({ text: "👎", callback_data: "v:123:0" });
  });

  it("marks only the chosen side after a vote, keeping both pressable", () => {
    const [up] = confirmedKeyboard("123", 1);
    expect(up![0]!.text).toBe("👍 ✓");
    expect(up![1]!.text).toBe("👎");
    const [down] = confirmedKeyboard("123", 0);
    expect(down![0]!.text).toBe("👍");
    expect(down![1]!.text).toBe("👎 ✓");
    // callback_data unchanged: re-voting stays possible.
    expect(up![1]!.callback_data).toBe("v:123:0");
  });
});

describe("keys and acks", () => {
  it("keys one vote per (chat, paper) so re-votes overwrite", () => {
    expect(voteKey("111", "42527307")).toBe("vote:111:42527307");
  });

  it("acknowledges in Spanish", () => {
    expect(voteAck(1)).toBe("👍 anotado");
    expect(voteAck(0)).toBe("👎 anotado");
  });
});
