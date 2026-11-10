import { describe, expect, it } from "vitest";

import { applyJudgement, buildJudgePrompt } from "../src/judge";

const threads = [
  { id: "PRRT_a", path: "src/a.ts", line: 3, body: "Null deref.\n<!-- hammer:fp=x -->" },
  { id: "PRRT_b", path: "src/b.ts", line: 9, body: "Leaks a handle." },
];

describe("applyJudgement", () => {
  it("maps verdicts back to thread ids", async () => {
    const result = await applyJudgement({
      threads,
      runJudge: () => '{"verdicts":[{"id":"t1","verdict":"fixed"},{"id":"t2","verdict":"open"}]}',
    });
    expect(result.judged).toEqual([
      { id: "PRRT_a", fixed: true },
      { id: "PRRT_b", fixed: false },
    ]);
  });

  it("treats a missing verdict as open", async () => {
    const result = await applyJudgement({
      threads,
      runJudge: () => ({ verdicts: [{ id: "t1", verdict: "fixed" }] }),
    });
    expect(result.judged.map((entry) => entry.fixed)).toEqual([true, false]);
  });

  it("judges nothing when the output is invalid or the call fails", async () => {
    expect((await applyJudgement({ threads, runJudge: () => "nope" })).judged).toEqual([]);
    expect(
      (
        await applyJudgement({
          threads,
          runJudge: () => {
            throw new Error("boom");
          },
        })
      ).judged,
    ).toEqual([]);
  });

  it("skips the call when there are no threads or no budget", async () => {
    let calls = 0;
    const runJudge = () => {
      calls += 1;
      return "{}";
    };
    await applyJudgement({ threads: [], runJudge });
    await applyJudgement({ threads, runJudge, canContinue: () => false });
    expect(calls).toBe(0);
  });

  it("strips hidden markers from the prompt", () => {
    expect(buildJudgePrompt(threads)).not.toContain("hammer:fp");
  });
});
