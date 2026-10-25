import { describe, expect, it } from "vitest";

import {
  commentableLines,
  decideReviewScope,
  extractLastSha,
  fetchPullFiles,
  MAX_PULL_FILES,
  parsePatch,
  type PullFileEntry,
} from "../src/index";

const MODIFY_PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -3,4 +3,5 @@",
  " line3",
  "-old line4",
  "+new line4",
  "+new line5",
  " line6",
].join("\n");

const ADD_PATCH = [
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,3 @@",
  "+line1",
  "+line2",
  "+line3",
].join("\n");

const DELETE_PATCH = [
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,3 +0,0 @@",
  "-line1",
  "-line2",
  "-line3",
].join("\n");

const RENAME_PATCH = [
  "diff --git a/src/old.ts b/src/new.ts",
  "similarity index 90%",
  "rename from src/old.ts",
  "rename to src/new.ts",
  "--- a/src/old.ts",
  "+++ b/src/new.ts",
  "@@ -1,3 +1,3 @@",
  " line1",
  "-line2",
  "+line2 changed",
  " line3",
].join("\n");

const MULTI_HUNK_PATCH = [
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

const NO_NEWLINE_PATCH = [
  "diff --git a/src/nn.ts b/src/nn.ts",
  "--- a/src/nn.ts",
  "+++ b/src/nn.ts",
  "@@ -1,2 +1,2 @@",
  " line1",
  "-old2",
  "\\ No newline at end of file",
  "+new2",
  "\\ No newline at end of file",
].join("\n");

function fileEntry(overrides: Partial<PullFileEntry> = {}): PullFileEntry {
  return {
    sha: "abc123",
    filename: "src/app.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    changes: 3,
    patch: MODIFY_PATCH,
    ...overrides,
  };
}

describe("parsePatch", () => {
  it.each([
    ["@@ -1,1 +1,1 @@\n-old\n+new\n", [1]],
    ["@@ -0,0 +1,1 @@\n+new\n", [1]],
    ["@@ -1,1 +0,0 @@\n-old\n", []],
    ["@@ -1,2 +1,2 @@\n same\n \n", [1, 2]],
  ])("does not invent an anchor from a terminal patch newline", (patch, lines) => {
    expect([...commentableLines(parsePatch(patch))]).toEqual(lines);
  });
  it("parses a modify patch with RIGHT-side line numbers", () => {
    const hunks = parsePatch(MODIFY_PATCH);
    expect(hunks).toHaveLength(1);
    const hunk = hunks[0]!;
    expect(hunk.oldStart).toBe(3);
    expect(hunk.newStart).toBe(3);
    const kinds = hunk.lines.map((line) => [line.kind, line.newLine, line.oldLine]);
    expect(kinds).toEqual([
      ["context", 3, 3],
      ["removed", null, 4],
      ["added", 4, null],
      ["added", 5, null],
      ["context", 6, 5],
    ]);
  });

  it("parses an added-file patch starting at line 1", () => {
    const hunks = parsePatch(ADD_PATCH);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines.map((line) => line.newLine)).toEqual([1, 2, 3]);
    expect(commentableLines(hunks)).toEqual(new Set([1, 2, 3]));
  });

  it("records old-file numbers for removed lines in a deleted file", () => {
    const hunks = parsePatch(DELETE_PATCH);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines.every((line) => line.newLine === null)).toBe(true);
    expect(hunks[0]!.lines.map((line) => line.oldLine)).toEqual([1, 2, 3]);
    expect(commentableLines(hunks).size).toBe(0);
  });

  it("tracks renamed-file hunks on the RIGHT side", () => {
    const hunks = parsePatch(RENAME_PATCH);
    expect(hunks).toHaveLength(1);
    expect(commentableLines(hunks)).toEqual(new Set([1, 2, 3]));
  });

  it("parses multiple hunks with correct line numbers", () => {
    const hunks = parsePatch(MULTI_HUNK_PATCH);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.lines.map((line) => line.newLine)).toEqual([1, null, 2, 3]);
    expect(hunks[1]!.lines.map((line) => line.newLine)).toEqual([10, 11, 12, 13, 14]);
    expect(commentableLines(hunks)).toEqual(new Set([1, 2, 3, 10, 11, 12, 13, 14]));
  });

  it("skips no-newline markers without shifting line numbers", () => {
    const hunks = parsePatch(NO_NEWLINE_PATCH);
    expect(hunks).toHaveLength(1);
    const kinds = hunks[0]!.lines.map((line) => [line.kind, line.newLine, line.oldLine]);
    expect(kinds).toEqual([
      ["context", 1, 1],
      ["removed", null, 2],
      ["added", 2, null],
    ]);
  });

  it("returns no hunks when the patch is absent (binary or truncated)", () => {
    expect(parsePatch("")).toEqual([]);
    expect(parsePatch("Binary files a/logo.png and b/logo.png differ\n")).toEqual([]);
  });
});

describe("pull file entries", () => {
  it("represents binary files with no patch", () => {
    const entry = fileEntry({ filename: "assets/logo.png", status: "added", patch: undefined });
    expect(entry.patch).toBeUndefined();
    expect(parsePatch(entry.patch ?? "")).toEqual([]);
  });

  it("represents truncated patches with no patch but nonzero changes", () => {
    const entry = fileEntry({ changes: 1200, additions: 900, deletions: 300, patch: undefined });
    expect(entry.patch).toBeUndefined();
    expect(entry.changes).toBeGreaterThan(0);
  });

  it("represents renamed files with previous_filename", () => {
    const entry = fileEntry({
      filename: "src/new.ts",
      status: "renamed",
      patch: RENAME_PATCH,
      previous_filename: "src/old.ts",
    });
    expect(entry.previous_filename).toBe("src/old.ts");
  });

  it("represents deleted files with no RIGHT-side commentable lines", () => {
    const entry = fileEntry({ filename: "src/gone.ts", status: "removed", patch: DELETE_PATCH });
    expect(commentableLines(parsePatch(entry.patch ?? "")).size).toBe(0);
  });
});

describe("fetchPullFiles", () => {
  it("paginates across two pages", async () => {
    const pages: PullFileEntry[][] = [
      [fileEntry({ filename: "a.ts" }), fileEntry({ filename: "b.ts" })],
      [fileEntry({ filename: "c.ts" })],
    ];
    const files = await fetchPullFiles(
      async (page, perPage) => {
        expect(perPage).toBe(2);
        return pages[page - 1] ?? [];
      },
      { perPage: 2 },
    );
    expect(files.map((file) => file.filename)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("caps results at the 3,000-file limit", async () => {
    const page = Array.from({ length: 100 }, (_, i) => fileEntry({ filename: `f${i}.ts` }));
    const files = await fetchPullFiles(async () => page, { perPage: 100 });
    expect(files).toHaveLength(MAX_PULL_FILES);
    expect(MAX_PULL_FILES).toBe(3000);
  });

  it("stops after a short final page", async () => {
    let calls = 0;
    const files = await fetchPullFiles(
      async () => {
        calls += 1;
        return [fileEntry({ filename: "only.ts" })];
      },
      { perPage: 100 },
    );
    expect(files).toHaveLength(1);
    expect(calls).toBe(1);
  });
});

describe("extractLastSha", () => {
  it("extracts the sha from a sticky-comment body", () => {
    const body = [
      "### Hammer Review",
      "<!-- hammer-review:v1 -->",
      "<!-- hammer:last-sha=a1b2c3d -->",
    ].join("\n");
    expect(extractLastSha(body)).toBe("a1b2c3d");
  });

  it("returns undefined when the marker is absent", () => {
    expect(extractLastSha("### Hammer Review\nno markers here")).toBeUndefined();
    expect(extractLastSha("")).toBeUndefined();
  });
});

describe("decideReviewScope", () => {
  it("returns full scope when lastSha is missing", () => {
    expect(decideReviewScope({})).toEqual({ mode: "full" });
    expect(decideReviewScope({ lastSha: undefined })).toEqual({ mode: "full" });
    expect(decideReviewScope({ lastSha: null })).toEqual({ mode: "full" });
    expect(decideReviewScope({ lastSha: "" })).toEqual({ mode: "full" });
  });
});
