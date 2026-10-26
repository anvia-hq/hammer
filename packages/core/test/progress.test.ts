import { describe, expect, it } from "vitest";
import { formatReviewEvent } from "../src/index";

describe("formatReviewEvent", () => {
  it("renders the review lifecycle", () => {
    expect(formatReviewEvent({ type: "plan", files: 1, batches: 2 })).toBe(
      "[hammer] reviewing 1 file in 2 batches",
    );
    expect(
      formatReviewEvent({ type: "tool", batch: "single", name: "read_file", detail: "a.ts:1-9" }),
    ).toBe("[hammer] batch single: read_file a.ts:1-9");
    expect(formatReviewEvent({ type: "turn", tokens: 1200, costUsd: 0.0123 })).toContain("$0.0123");
    expect(formatReviewEvent({ type: "turn", tokens: 5, costUsd: null })).not.toContain("$");
    expect(
      formatReviewEvent({ type: "batch_end", batch: "b", ok: false, findings: 0, error: "x" }),
    ).toBe("[hammer] batch b: failed: x");
  });

  it("keeps untrusted text on one prefixed line so it cannot start a workflow command", () => {
    const line = formatReviewEvent({
      type: "tool",
      batch: "single",
      name: "search",
      detail: "x\n::set-output name=a::b",
    });
    expect(line.split("\n")).toHaveLength(1);
    expect(line.startsWith("[hammer] ")).toBe(true);
  });

  it("truncates long details", () => {
    const line = formatReviewEvent({
      type: "tool",
      batch: "b",
      name: "search",
      detail: "a".repeat(500),
    });
    expect(line.length).toBeLessThan(260);
  });
});

describe("text events", () => {
  it("renders model text on one prefixed, redacted, truncated line", () => {
    const line = formatReviewEvent({
      type: "text",
      batch: "single",
      kind: "text",
      text: `Looking at it\n::error::x ${"a".repeat(600)}`,
    });
    expect(line.startsWith("[hammer] batch single says: ")).toBe(true);
    expect(line.split("\n")).toHaveLength(1);
    expect(line.length).toBeLessThan(480);
    expect(formatReviewEvent({ type: "text", batch: "b", kind: "reasoning", text: "hm" })).toBe(
      "[hammer] batch b thinking: hm",
    );
  });
});
