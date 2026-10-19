import { describe, expect, it } from "vitest";

import { buildActionOutputs, renderJobSummaryMarkdown, writeResultJson } from "../src/index";

describe("buildActionOutputs", () => {
  it("returns F16 outputs as strings with counts", () => {
    const outputs = buildActionOutputs({
      findings: [{ severity: "high" }, { severity: "medium" }, { severity: "low" }],
      tokens: 1234,
      costUsd: 0.09,
      resultPath: "/tmp/runner/result.json",
      reviewUrl: "https://github.com/o/r/pull/7#issuecomment-1",
    });
    expect(outputs).toEqual({
      findings_count: "3",
      high_count: "1",
      review_url: "https://github.com/o/r/pull/7#issuecomment-1",
      result_path: "/tmp/runner/result.json",
      tokens: "1234",
      cost_usd: "0.09",
    });
  });

  it("defaults optional fields to empty strings and zero tokens", () => {
    const outputs = buildActionOutputs({ findings: [] });
    expect(outputs.findings_count).toBe("0");
    expect(outputs.high_count).toBe("0");
    expect(outputs.tokens).toBe("0");
    expect(outputs.cost_usd).toBe("");
    expect(outputs.review_url).toBe("");
    expect(outputs.result_path).toBe("");
  });

  it("floors token counts and stringifies cost", () => {
    const outputs = buildActionOutputs({
      findings: [{ severity: "medium" }],
      tokens: 41.7,
      costUsd: 1,
    });
    expect(outputs.tokens).toBe("41");
    expect(outputs.cost_usd).toBe("1");
  });
});

describe("renderJobSummaryMarkdown", () => {
  it("renders a run table with partial flag and not-reviewed files", () => {
    const markdown = renderJobSummaryMarkdown({
      postedInline: 2,
      generalNotes: 1,
      droppedByReason: { below_min_severity: 3 },
      filesReviewed: ["src/a.ts", "src/b.ts"],
      filesNotReviewed: [{ path: "src/huge.ts", reason: "over max_diff_lines" }],
      tokens: 41000,
      costUsd: 0.09,
      partial: true,
      partialReason: "max_cost_usd reached",
    });
    expect(markdown).toContain("## Hammer Review");
    expect(markdown).toContain("| Posted inline | 2 |");
    expect(markdown).toContain("| Partial | yes — max_cost_usd reached |");
    expect(markdown).toContain("src/huge.ts");
    expect(markdown).toContain("| Tokens | 41000 |");
    expect(markdown).toContain("| Cost (USD) | $0.09 |");
  });

  it("escapes table cell pipes and newlines", () => {
    const markdown = renderJobSummaryMarkdown({
      modelSummary: "ok",
      filesReviewed: [],
      filesNotReviewed: [{ path: "a|b.ts", reason: "line 1\nline 2" }],
    });
    expect(markdown).toContain("a\\|b.ts");
    expect(markdown).not.toContain("a|b.ts —");
    expect(markdown).toContain("line 1<br />line 2");
  });

  it("renders the skip reason when the run was skipped", () => {
    const markdown = renderJobSummaryMarkdown({
      skipped: { reason: 'event "push" is not a review trigger', code: "unsupported_event" },
    });
    expect(markdown).toContain("## Hammer Review (skipped)");
    expect(markdown).toContain('[unsupported_event] event "push" is not a review trigger');
  });

  it("sanitizes model text before embedding it", () => {
    const markdown = renderJobSummaryMarkdown({
      modelSummary: "hello @attacker ![img](https://evil.test/x.png)",
      filesReviewed: [],
    });
    expect(markdown).not.toContain("@attacker");
    expect(markdown).not.toContain("![img]");
    expect(markdown).toContain("hello");
  });
});

describe("writeResultJson", () => {
  it("passes stringified JSON to the injected writer", async () => {
    const calls: Array<{ path: string; data: string }> = [];
    await writeResultJson("/tmp/result.json", { findings: 1 }, (path, data) => {
      calls.push({ path, data });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/tmp/result.json");
    expect(JSON.parse(calls[0]?.data ?? "")).toEqual({ findings: 1 });
  });
});
