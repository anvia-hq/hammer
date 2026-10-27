import { describe, expect, it } from "vitest";

import { buildReviewPrompt, MAX_GUIDANCE_TOKENS, type BuildReviewPromptInput } from "../src/index";
import { type PullFileEntry } from "@anvia/hammer-core";
import { parsePatch } from "@anvia/hammer-core";

function file(filename: string, patch: string): PullFileEntry {
  return {
    sha: "abc123",
    filename,
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch,
  };
}

const MULTI_HUNK = [
  "diff --git a/src/big.ts b/src/big.ts",
  "--- a/src/big.ts",
  "+++ b/src/big.ts",
  "@@ -1,3 +1,3 @@ first",
  " line1",
  "-old2",
  "+new2",
  " line3",
  "@@ -10,4 +10,5 @@ second",
  " line10",
  " line11",
  "+added12",
  " line13",
  " line14",
].join("\n");

const baseInput: BuildReviewPromptInput = {
  title: "Add retry with backoff",
  files: [file("src/big.ts", MULTI_HUNK)],
  config: { rules: [], path_instructions: [], use_repo_guidelines: true },
};

describe("buildReviewPrompt hunks", () => {
  it("numbers new-side lines exactly as parsePatch reports", () => {
    const { prompt } = buildReviewPrompt(baseInput);
    const hunks = parsePatch(MULTI_HUNK);
    const expectedNew = hunks
      .flatMap((h) => h.lines)
      .filter((line) => line.kind !== "removed" && line.newLine !== null)
      .map((line) => String(line.newLine));
    for (const num of expectedNew) {
      expect(prompt).toMatch(new RegExp(`^[ +]${num} `, "m"));
    }
    expect(prompt).toContain("+2 new2");
    expect(prompt).toContain("+12 added12");
    expect(prompt).toContain(" 10 line10");
    expect(prompt).toContain("__new hunk__");
  });

  it("renders removed lines in an unnumbered __old hunk__ block", () => {
    const { prompt } = buildReviewPrompt(baseInput);
    const oldIndex = prompt.indexOf("__old hunk__");
    expect(oldIndex).toBeGreaterThan(-1);
    expect(prompt.slice(oldIndex)).toMatch(/^-old2/m);
    expect(prompt).not.toMatch(/^-\d+ old2/m);
  });

  it("widens context to the enclosing scope but stops at 40 lines", () => {
    const target = Array.from({ length: 60 }, (_, i) => `  stmt${i};`);
    const body = ["function review() {", ...target, "}"].join("\n");
    const patch = ["@@ -1,2 +1,3 @@", " function review() {", "+added();", " stmt0;"].join("\n");
    const { prompt } = buildReviewPrompt({
      ...baseInput,
      files: [file("src/app.ts", patch)],
      fileContents: { "src/app.ts": body },
    });
    const block = prompt.slice(prompt.indexOf("__new hunk__"));
    const numbered = block.match(/^\s\d+ /gm) ?? [];
    expect(numbered.length).toBeLessThanOrEqual(40);
  });

  it("falls back to a fixed window when no brace scope exists and adds trailing context", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `row${i + 1}: value`);
    const patch = ["@@ -30,2 +30,3 @@", " row30: value", "+added", " row31: value"].join("\n");
    const { prompt } = buildReviewPrompt({
      ...baseInput,
      files: [file("config.yaml", patch)],
      fileContents: { "config.yaml": lines.join("\n") },
    });
    expect(prompt).toContain(" 15 row15: value");
    expect(prompt).not.toContain(" 14 row14: value");
    expect(prompt).toContain(" 42 row42: value");
    expect(prompt).not.toContain(" 43 row43: value");
  });

  it("keeps the hunk as is when no enclosing scope is found", () => {
    const { prompt } = buildReviewPrompt({
      ...baseInput,
      fileContents: { "src/big.ts": "const x = 1;\nconst y = 2;\n" },
    });
    expect(prompt).toContain(" 1 line1");
  });
});

describe("buildReviewPrompt metadata", () => {
  it("includes the title and a capped, untrusted body inline", () => {
    const { prompt } = buildReviewPrompt({
      ...baseInput,
      title: "Add retry with backoff",
      body: `At most four attempts. ${"x".repeat(3000)}`,
      files: [],
    });
    expect(prompt).toContain("PR title: Add retry with backoff");
    expect(prompt).toContain("<untrusted>\nPR body: At most four attempts.");
    expect(prompt).not.toContain("x".repeat(1600));
  });

  it("marks an empty body", () => {
    const { prompt } = buildReviewPrompt({ ...baseInput, files: [] });
    expect(prompt).toContain("PR body: (empty)");
  });

  it("applies path_instructions only to matching paths", () => {
    const { prompt } = buildReviewPrompt({
      ...baseInput,
      files: [file("db/migrations/0042.sql", MULTI_HUNK)],
      config: {
        rules: [],
        path_instructions: [
          { path: "db/migrations/**", text: "Check backward compatibility." },
          { path: "**/*.test.ts", text: "Only flag failing tests." },
        ],
        use_repo_guidelines: false,
      },
    });
    expect(prompt).toContain("Check backward compatibility.");
    expect(prompt).not.toContain("Only flag failing tests.");
  });

  it("shows rule ids so the model can cite them", () => {
    const { prompt } = buildReviewPrompt({
      ...baseInput,
      config: {
        rules: [
          {
            id: "webhooks-idempotent",
            text: "Outbound webhook POSTs must send an Idempotency-Key.",
          },
        ],
        path_instructions: [],
        use_repo_guidelines: false,
      },
    });
    expect(prompt).toContain("`webhooks-idempotent`");
    expect(prompt).toContain("Outbound webhook POSTs must send an Idempotency-Key.");
  });

  it("truncates guidance over 8,000 tokens and flags it", () => {
    const big = "x".repeat((MAX_GUIDANCE_TOKENS + 100) * 4);
    const result = buildReviewPrompt({
      ...baseInput,
      config: {
        rules: [{ id: "big-rule", text: big }],
        path_instructions: [],
        use_repo_guidelines: false,
      },
    });
    expect(result.guidanceTruncated).toBe(true);
    expect(result.prompt).toContain("[guidance truncated]");
  });

  it("reports approxTokens and no truncation for small guidance", () => {
    const result = buildReviewPrompt(baseInput);
    expect(result.guidanceTruncated).toBe(false);
    expect(result.approxTokens).toBe(Math.ceil(result.prompt.length / 4));
  });

  it("excludes guideline strings when use_repo_guidelines is false", () => {
    const guidelines = { agentsMd: "Always use tabs.", claudeMd: "c", contributingMd: "d" };
    const off = buildReviewPrompt({
      ...baseInput,
      config: { rules: [], path_instructions: [], use_repo_guidelines: false },
      guidelines,
    });
    expect(off.prompt).not.toContain("Always use tabs.");
    const on = buildReviewPrompt({
      ...baseInput,
      config: { rules: [], path_instructions: [], use_repo_guidelines: true },
      guidelines,
    });
    expect(on.prompt).toContain("Always use tabs.");
  });
});
