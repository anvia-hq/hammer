import { join } from "node:path";
import type { CompletionModel } from "@anvia/core/completion";
import { describe, expect, it, vi } from "vitest";
import { defaultRepoConfig, resolveConfig } from "@anvia/hammer-core";
import { loadReviewSkills, runReviewPipeline } from "../src/index";

const skillsDirectory = join(import.meta.dirname, "..", "..", "..", "skills");

describe("review skills", () => {
  it("loads the bundled code review skill", async () => {
    const skills = await loadReviewSkills(skillsDirectory);
    expect(skills.skills.map((skill) => skill.name)).toEqual(["code-review-and-quality"]);
    expect(skills.instructions).toContain("code-review-and-quality");
  });

  it("exposes only read-only skill tools, never script execution", async () => {
    const skills = await loadReviewSkills(skillsDirectory);
    expect(skills.tools.map((tool) => tool.name).sort()).toEqual([
      "get_skill_instructions",
      "get_skill_reference",
    ]);
  });

  it("gives the reviewer the skill tools and guidance", async () => {
    const skills = await loadReviewSkills(skillsDirectory);
    const model: CompletionModel = {
      provider: "test",
      modelId: "fake",
      capabilities: {
        outputSchema: false,
        tools: true,
        toolChoice: true,
        streaming: false,
        imageInput: false,
        documentInput: false,
        reasoning: false,
      },
      completion: vi.fn(async () => ({
        choice: [
          {
            type: "text" as const,
            text: JSON.stringify({ summary: "s", findings: [], generalNotes: [] }),
          },
        ],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        rawResponse: {},
      })),
    };
    await runReviewPipeline({
      title: "PR",
      files: [
        {
          filename: "a.ts",
          sha: "x",
          status: "modified",
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: "@@ -1 +1 @@\n-old\n+new",
        },
      ],
      config: resolveConfig(defaultRepoConfig(), { verify: false }),
      checkoutRoot: "/tmp/unused",
      discussion: {},
      modelRef: "openai/fake",
      model,
      skills,
    });
    const request = vi.mocked(model.completion).mock.calls[0]![0];
    const names = (request.tools ?? []).map((tool: { name: string }) => tool.name);
    expect(names).toContain("get_skill_instructions");
    expect(names).not.toContain("run_skill_script");
    expect(JSON.stringify(request)).toContain("code-review-and-quality");
  });
});
