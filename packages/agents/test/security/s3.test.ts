import { describe, expect, it } from "vitest";

import { buildReviewerTools } from "../../src/run";
import { assertReadOnlySteps, checkoutSteps, HOOKS_PATH } from "@anvia/hammer-core";

const OPTIONS = {
  directory: "/tmp/hammer-head",
  repositoryUrl: "https://github.com/acme/repo.git",
  headSha: "abc123",
  token: "ghs_test",
};

describe("S3 no code execution", () => {
  it("checkout builders never emit install, build, npm, pnpm or lfs install", () => {
    const plan = checkoutSteps(OPTIONS);
    const steps = [plan.init, plan.remote, plan.fetch, plan.checkout];
    assertReadOnlySteps(steps);
    const joined = steps.map((s) => `${s.file} ${s.args.join(" ")}`).join("\n");
    expect(joined).not.toMatch(/\b(install|build|npm|pnpm)\b/);
    expect(joined).not.toContain("lfs install");
    expect(joined).toContain(`core.hooksPath=${HOOKS_PATH}`);
    expect(HOOKS_PATH).toBe("/dev/null");
  });

  it("read-only agent tool names are exactly the allowlist", () => {
    const tools = buildReviewerTools({ checkoutRoot: "/tmp/x", files: [], discussion: {} });
    expect(tools.map((t) => t.name)).toEqual([
      "read_file",
      "list_dir",
      "search",
      "get_file_diff",
      "get_pr_discussion",
    ]);
  });

  it("no tool name suggests shell or network access", () => {
    const tools = buildReviewerTools({ checkoutRoot: "/tmp/x", files: [], discussion: {} });
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/shell|exec|run|network|fetch|http|curl|wget/i);
    }
  });
});
