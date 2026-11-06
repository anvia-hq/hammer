import { describe, expect, it } from "vitest";
import type { PullFileEntry } from "@anvia/hammer-core";
import { dropDeletionOnlyHunks, fitDiff } from "../src/index";
import { approxTokens, renderPromptFile } from "../src/prompt";

function file(name: string, patch: string): PullFileEntry {
  return {
    filename: name,
    sha: "x",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch,
  };
}

const mixed = [
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "@@ -20,3 +20,1 @@",
  " ctx",
  "-gone one",
  "-gone two",
].join("\n");

function addedPatch(lines: number): string {
  return [
    `@@ -1,1 +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, i) => `+const v${i} = ${i};`),
  ].join("\n");
}

const body = Array.from({ length: 200 }, (_, i) => `line ${i} of the original source file`).join(
  "\n",
);

describe("dropDeletionOnlyHunks", () => {
  it("keeps hunks with additions and removes deletion-only ones", () => {
    const slim = dropDeletionOnlyHunks(file("a.ts", mixed));
    expect(slim?.patch).toContain("+new");
    expect(slim?.patch).not.toContain("gone one");
  });

  it("returns null when every hunk only deletes", () => {
    expect(dropDeletionOnlyHunks(file("a.ts", "@@ -1,2 +0,0 @@\n-a\n-b"))).toBeNull();
  });
});

describe("fitDiff", () => {
  const small = file("src/a.ts", mixed);

  it("keeps everything with context when it fits", () => {
    const fit = fitDiff([small], { "src/a.ts": body }, 100_000);
    expect(fit.stage).toBe("full");
    expect(fit.omitted).toEqual([]);
    expect(Object.keys(fit.contents)).toEqual(["src/a.ts"]);
  });

  it("drops widening context first", () => {
    const contents = { "src/a.ts": body };
    const withContext = approxTokens(renderPromptFile(small, contents));
    const without = approxTokens(renderPromptFile(small, {}));
    expect(withContext).toBeGreaterThan(without);
    const fit = fitDiff([small], contents, without + 5);
    expect(fit.stage).toBe("no-context");
    expect(fit.contents).toEqual({});
    expect(fit.files).toEqual([small]);
  });

  it("then drops deletion-only hunks and names them", () => {
    const big = file("src/a.ts", `${mixed}\n${addedPatch(30)}`);
    const budget = approxTokens(renderPromptFile(big, {})) - 10;
    const fit = fitDiff([big], {}, budget);
    expect(fit.stage).toBe("no-deletions");
    expect(fit.omitted).toEqual([
      { path: "src/a.ts", reason: expect.stringContaining("deletion-only hunks") },
    ]);
  });

  it("then packs files greedily, skipping ones that do not fit and naming them", () => {
    const huge = file("src/huge.ts", addedPatch(400));
    const tiny = file("src/tiny.ts", addedPatch(2));
    const medium = file("src/medium.ts", addedPatch(40));
    const budget =
      approxTokens(renderPromptFile(medium, {})) + approxTokens(renderPromptFile(tiny, {})) + 10;
    const fit = fitDiff([huge, medium, tiny], {}, budget);
    expect(fit.stage).toBe("packed");
    expect(fit.files.map((f) => f.filename)).toEqual(["src/medium.ts", "src/tiny.ts"]);
    expect(fit.omitted.map((entry) => entry.path)).toEqual(["src/huge.ts"]);
    expect(fit.tokens).toBeLessThanOrEqual(budget);
  });
});
