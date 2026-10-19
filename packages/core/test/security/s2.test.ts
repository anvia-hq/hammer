import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REPO = new URL("../../../../", import.meta.url);

function read(rel: string): string {
  return readFileSync(new URL(rel, REPO), "utf8");
}

describe("S2 no pull_request_target", () => {
  it("action.yml never uses pull_request_target", () => {
    expect(read("action.yml")).not.toContain("pull_request_target");
  });

  it("README never uses pull_request_target", () => {
    expect(read("README.md")).not.toContain("pull_request_target");
  });

  it("ci workflow never uses pull_request_target", () => {
    expect(read(".github/workflows/ci.yml")).not.toContain("pull_request_target");
  });

  it("docs mention it only as a prohibition, never in a workflow snippet", () => {
    const allowed = new Set([
      "docs/PRD.md",
      "docs/archive/PRD-v0-agent-for-github.md",
      "docs/decision/0005-fork-prs-by-comment-trigger.md",
    ]);
    const mentioning: string[] = [];
    for (const doc of [
      "docs/PRD.md",
      "docs/decision/0005-fork-prs-by-comment-trigger.md",
      "docs/archive/PRD-v0-agent-for-github.md",
    ]) {
      let text = "";
      try {
        text = read(doc);
      } catch {
        continue;
      }
      if (!text.includes("pull_request_target")) continue;
      mentioning.push(doc);
      for (const line of text.split("\n")) {
        if (!line.includes("pull_request_target")) continue;
        const context = line.toLowerCase();
        const ok =
          context.includes("never") ||
          context.includes("no ") ||
          context.includes("without") ||
          context.includes("instead") ||
          context.includes("reject") ||
          context.includes("safe only if no one ever") ||
          line.startsWith("|");
        expect(ok, `unexpected pull_request_target line in ${doc}: ${line}`).toBe(true);
      }
      expect(allowed.has(doc)).toBe(true);
    }
    expect(mentioning.length).toBeGreaterThan(0);
  });
});
