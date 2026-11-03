import { describe, expect, it } from "vitest";

import { formatInlineBody, renderReviewBody, type Finding } from "../src/index";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    path: "src/app.ts",
    line: 9,
    severity: "medium",
    category: "reliability",
    title: "No backoff",
    body: "Retries hammer the API. Add a delay between attempts.",
    confidence: 0.8,
    ...overrides,
  };
}

describe("renderReviewBody", () => {
  it("opens with the CAUTION callout when any finding is high", () => {
    const body = renderReviewBody({
      findings: [finding({ severity: "high" }), finding({ severity: "low" })],
    });
    expect(body.startsWith("> [!CAUTION]\n> 1 high-severity finding, fix before merging.")).toBe(
      true,
    );
    expect(body).toContain("2 findings (1 high, 1 low)");
  });

  it("uses IMPORTANT for medium and an info line for minor suggestions", () => {
    expect(renderReviewBody({ findings: [finding()] }).startsWith("> [!IMPORTANT]\n")).toBe(true);
    expect(
      renderReviewBody({ findings: [finding({ severity: "low" }), finding({ severity: "low" })] }),
    ).toContain("> ℹ️ No critical issues — 2 minor suggestions inline.");
  });

  it("lists reviewed changes as bullets, skipping blanks and collapsing whitespace", () => {
    const body = renderReviewBody({
      findings: [finding()],
      changes: ["Added retry\nwith jitter", "  ", "Dropped cache"],
    });
    expect(body).toContain("**Reviewed changes**\n\n- Added retry with jitter\n- Dropped cache");
  });

  it("puts the summary under the heading before the bullets", () => {
    const body = renderReviewBody({
      findings: [finding()],
      summary: "Reviewed the\nfull diff.",
      changes: ["Added retry"],
    });
    expect(body).toContain("**Reviewed changes**\n\nReviewed the full diff.\n\n- Added retry");
  });

  it("ends with a footer linking the run and naming the model", () => {
    const body = renderReviewBody({
      findings: [finding()],
      model: "anthropic/claude-sonnet-5-5",
      runUrl: "https://github.com/acme/app/actions/runs/1",
    });
    expect(
      body.endsWith(
        "🔨 **Hammer** | 1 finding (1 medium) | [View workflow run](https://github.com/acme/app/actions/runs/1) | Using `anthropic/claude-sonnet-5-5`",
      ),
    ).toBe(true);
  });

  it("omits the changes block when there are none", () => {
    expect(renderReviewBody({ findings: [finding()] })).not.toContain("Reviewed changes");
  });
});

describe("formatInlineBody", () => {
  it("maps severity to a GitHub alert", () => {
    expect(formatInlineBody(finding({ severity: "high" }))).toMatch(/^> \[!CAUTION\]\n/);
    expect(formatInlineBody(finding({ severity: "low" }))).toMatch(/^> \[!NOTE\]\n/);
  });

  it("renders severity, title, body and attribution without details", () => {
    const body = formatInlineBody(finding());
    expect(body.startsWith("> [!WARNING]\n> **Medium · reliability** — No backoff\n\n")).toBe(true);
    expect(body).toContain("<sub>Hammer</sub>");
    expect(body).not.toContain("<details>");
  });

  it("cites the rule id", () => {
    expect(formatInlineBody(finding({ ruleId: "no-retry" }))).toContain(
      "<sub>Rule: `no-retry` · Hammer</sub>",
    );
  });

  it("puts the suggestion before a collapsed technical details block", () => {
    const body = formatInlineBody(
      finding({ details: "- `src/app.ts:9` — no delay\n\nRequired: back off." }),
      "await sleep(100);",
    );
    expect(body.indexOf("```suggestion")).toBeLessThan(body.indexOf("<details>"));
    expect(body).toContain(
      "<details>\n<summary>Technical details</summary>\n\n- `src/app.ts:9` — no delay",
    );
    expect(body).toContain("\n\n</details>\n\n<sub>Hammer</sub>");
  });

  it("neutralises nested fences in a suggestion and closes an unbalanced fence in details", () => {
    const body = formatInlineBody(finding({ details: "```ts\nconst a = 1;" }), "a ``` b");
    expect(body).toContain("a ˋˋˋ b");
    expect(body).toContain("const a = 1;\n```\n\n</details>");
  });
});
