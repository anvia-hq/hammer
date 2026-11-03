import { describe, expect, it } from "vitest";
import { formatReviewEvent } from "../src/index";

describe("formatReviewEvent", () => {
  it("renders the review lifecycle", () => {
    expect(formatReviewEvent({ type: "plan", files: 1 })).toBe("[hammer] reviewing 1 file");
    expect(formatReviewEvent({ type: "tool", name: "read_file", detail: "a.ts:1-9" })).toBe(
      "[hammer] read_file a.ts:1-9",
    );
    expect(formatReviewEvent({ type: "turn", tokens: 1200, costUsd: 0.0123 })).toContain("$0.0123");
    expect(formatReviewEvent({ type: "turn", tokens: 5, costUsd: null })).not.toContain("$");
    expect(formatReviewEvent({ type: "review_end", ok: false, findings: 0, error: "x" })).toBe(
      "[hammer] review failed: x",
    );
  });

  it("says when verification did not finish", () => {
    expect(formatReviewEvent({ type: "verify_end", kept: 1, dropped: 0 })).toBe(
      "[hammer] verification kept 1, dropped 0",
    );
    expect(
      formatReviewEvent({ type: "verify_end", kept: 1, dropped: 0, unverified: "budget" }),
    ).toBe("[hammer] verification did not finish (budget); keeping 1 finding unverified");
  });

  it("keeps untrusted text on one prefixed line so it cannot start a workflow command", () => {
    const line = formatReviewEvent({
      type: "tool",
      name: "search",
      detail: "x\n::set-output name=a::b",
    });
    expect(line.split("\n")).toHaveLength(1);
    expect(line.startsWith("[hammer] ")).toBe(true);
  });

  it("truncates long details", () => {
    const line = formatReviewEvent({
      type: "tool",
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
      kind: "text",
      text: `Looking at it\n::error::x ${"a".repeat(600)}`,
    });
    expect(line.startsWith("[hammer] says: ")).toBe(true);
    expect(line.split("\n")).toHaveLength(1);
    expect(line.length).toBeLessThan(480);
    expect(formatReviewEvent({ type: "text", kind: "reasoning", text: "hm" })).toBe(
      "[hammer] thinking: hm",
    );
  });
});

describe("review_end diagnostics", () => {
  it("appends partial and finish details without leaking raw output", () => {
    expect(
      formatReviewEvent({
        type: "review_end",
        ok: true,
        findings: 2,
        partial: true,
        finishReason: "length",
        outputChars: 143,
      }),
    ).toBe("[hammer] review done, 2 findings (partial, finish length, 143 chars)");
    expect(formatReviewEvent({ type: "review_end", ok: true, findings: 1 })).toBe(
      "[hammer] review done, 1 finding",
    );
    expect(
      formatReviewEvent({
        type: "review_end",
        ok: false,
        findings: 0,
        error: "bad",
        finishReason: "length",
        outputChars: 10,
      }),
    ).toBe("[hammer] review failed: bad (finish length, 10 chars)");
  });
});
