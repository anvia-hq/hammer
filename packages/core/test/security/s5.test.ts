import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { assertCommentEvent, postPullReview } from "../../src/github/review";

const SRC = new URL("../../src/github/review.ts", import.meta.url);

describe("S5 review POST allowlist", () => {
  it("always posts event COMMENT", async () => {
    const seen: Array<{ event: string }> = [];
    await postPullReview(
      { owner: "o", repo: "r", pullNumber: 1, commitId: "abc", inline: [], body: "hi" },
      { createReview: async (p) => void seen.push(p) },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.event).toBe("COMMENT");
  });

  it("assertCommentEvent throws for APPROVE and REQUEST_CHANGES", () => {
    expect(() => assertCommentEvent("APPROVE")).toThrow();
    expect(() => assertCommentEvent("REQUEST_CHANGES")).toThrow();
  });

  it("postPullReview rejects APPROVE and REQUEST_CHANGES without calling the API", async () => {
    for (const event of ["APPROVE", "REQUEST_CHANGES"]) {
      let calls = 0;
      const result = await postPullReview(
        { owner: "o", repo: "r", pullNumber: 1, commitId: "abc", inline: [], body: "hi", event },
        { createReview: async () => void (calls += 1) },
      );
      expect(result.ok).toBe(false);
      expect(calls).toBe(0);
    }
  });

  it("no approve, merge, label or push helper is reachable", () => {
    const text = readFileSync(SRC, "utf8");
    const names = [...text.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map((m) => m[1]);
    for (const name of names) {
      expect(name).not.toMatch(/approve|merge|label|push/i);
    }
    expect(text).not.toContain("APPROVE");
    expect(text).not.toContain("REQUEST_CHANGES");
    expect(text).not.toMatch(/pulls\.merge|issues\.(addLabels|setLabels)|git push/);
  });
});
