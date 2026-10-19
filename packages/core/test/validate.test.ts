import { describe, expect, it } from "vitest";

import { validateFindings, type Finding, type PullFileEntry } from "../src/index";

const APP_PATCH = [
  "@@ -1,5 +1,5 @@",
  " line1",
  " line2",
  "-old3",
  "+new3",
  " line4",
  " line5",
  "@@ -10,5 +10,6 @@",
  " line10",
  " line11",
  " line12",
  "+added13",
  " line14",
  " line15",
].join("\n");

const DELETED_PATCH = ["@@ -1,2 +0,0 @@", "-gone1", "-gone2"].join("\n");

function file(overrides: Partial<PullFileEntry> = {}): PullFileEntry {
  return {
    sha: "abc123",
    filename: "src/app.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    changes: 3,
    patch: APP_PATCH,
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    path: "src/app.ts",
    line: 3,
    severity: "medium",
    category: "correctness",
    title: "Something is wrong",
    body: "What is wrong, why it matters, and how to fix it.",
    confidence: 0.9,
    ...overrides,
  };
}

const LOW = { min_severity: "low" as const };

describe("validateFindings placement", () => {
  it("sends an out-of-diff line to general notes", () => {
    const result = validateFindings([finding({ line: 99 })], [file()], LOW);
    expect(result.inline).toHaveLength(0);
    expect(result.single).toHaveLength(0);
    expect(result.generalNotes).toEqual([
      { finding: finding({ line: 99 }), reason: "not_in_diff" },
    ]);
    expect(result.dropped).toEqual([{ finding: finding({ line: 99 }), reason: "not_in_diff" }]);
  });

  it("posts an in-hunk single line inline with its suggestion", () => {
    const input = finding({ line: 3, suggestion: "new3 = checked();" });
    const result = validateFindings([input], [file()], LOW);
    expect(result.inline).toEqual([
      { finding: input, startLine: 3, line: 3, suggestionKept: true },
    ]);
    expect(result.single).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
  });

  it("posts an in-hunk multi-line range inline", () => {
    const input = finding({ startLine: 1, line: 4, suggestion: "fix block" });
    const result = validateFindings([input], [file()], LOW);
    expect(result.inline).toEqual([
      { finding: input, startLine: 1, line: 4, suggestionKept: true },
    ]);
    expect(result.single).toHaveLength(0);
  });

  it("falls back to a single-line comment for a cross-hunk range with a valid end line", () => {
    const input = finding({ startLine: 3, line: 13, suggestion: "spans hunks" });
    const result = validateFindings([input], [file()], LOW);
    expect(result.inline).toHaveLength(0);
    expect(result.single).toEqual([
      { finding: input, startLine: 13, line: 13, suggestionKept: false },
    ]);
  });

  it("sends a cross-hunk range with an invalid end line to general notes", () => {
    const input = finding({ startLine: 3, line: 99 });
    const result = validateFindings([input], [file()], LOW);
    expect(result.inline).toHaveLength(0);
    expect(result.single).toHaveLength(0);
    expect(result.generalNotes).toEqual([{ finding: input, reason: "out_of_hunk" }]);
  });

  it("sends findings for deleted files to general notes", () => {
    const input = finding({ path: "src/gone.ts", line: 1 });
    const gone = file({ filename: "src/gone.ts", status: "removed", patch: DELETED_PATCH });
    const result = validateFindings([input], [gone], LOW);
    expect(result.inline).toHaveLength(0);
    expect(result.single).toHaveLength(0);
    expect(result.generalNotes).toEqual([{ finding: input, reason: "deleted_file" }]);
  });

  it("sends findings for unknown paths to general notes", () => {
    const input = finding({ path: "src/missing.ts", line: 3 });
    const result = validateFindings([input], [file()], LOW);
    expect(result.generalNotes).toEqual([{ finding: input, reason: "unknown_path" }]);
    expect(result.dropped).toEqual([{ finding: input, reason: "unknown_path" }]);
  });
});

describe("validateFindings thresholds", () => {
  it("min_severity high keeps only high", () => {
    const inputs = [
      finding({ line: 1, severity: "high" }),
      finding({ line: 2, severity: "medium" }),
      finding({ line: 3, severity: "low" }),
    ];
    const result = validateFindings(inputs, [file()], { min_severity: "high" });
    expect(result.inline.map((entry) => entry.finding.severity)).toEqual(["high"]);
    expect(
      result.dropped
        .filter((entry) => entry.reason === "below_min_severity")
        .map((entry) => entry.finding.line),
    ).toEqual([2, 3]);
  });

  it("default min_severity medium keeps high and medium", () => {
    const inputs = [
      finding({ line: 1, severity: "high" }),
      finding({ line: 2, severity: "medium" }),
      finding({ line: 3, severity: "low" }),
    ];
    const result = validateFindings(inputs, [file()]);
    expect(result.inline.map((entry) => entry.finding.severity).sort()).toEqual(["high", "medium"]);
    expect(result.dropped).toEqual([{ finding: inputs[2]!, reason: "below_min_severity" }]);
  });

  it("min_severity low keeps everything above the confidence floor", () => {
    const inputs = [
      finding({ line: 1, severity: "high" }),
      finding({ line: 2, severity: "medium" }),
      finding({ line: 3, severity: "low" }),
    ];
    const result = validateFindings(inputs, [file()], LOW);
    expect(result.inline).toHaveLength(3);
    expect(result.dropped).toHaveLength(0);
  });

  it("drops confidence 0.59 and keeps confidence 0.6", () => {
    const inputs = [finding({ line: 1, confidence: 0.59 }), finding({ line: 2, confidence: 0.6 })];
    const result = validateFindings(inputs, [file()], LOW);
    expect(result.inline.map((entry) => entry.finding.line)).toEqual([2]);
    expect(result.dropped).toEqual([{ finding: inputs[0]!, reason: "low_confidence" }]);
  });
});

describe("validateFindings max_comments cap", () => {
  function cappedInput(): Finding[] {
    return [
      finding({ line: 1, severity: "medium", confidence: 0.99 }),
      finding({ line: 2, severity: "high", confidence: 0.61 }),
      finding({ line: 3, severity: "medium", confidence: 0.7 }),
      finding({ line: 4, severity: "high", confidence: 0.9 }),
    ];
  }

  it("keeps the highest severity first, then higher confidence", () => {
    const result = validateFindings(cappedInput(), [file()], {
      min_severity: "low",
      max_comments: 2,
    });
    expect(result.inline.map((entry) => entry.finding.line)).toEqual([4, 2]);
    expect(result.generalNotes.map((entry) => entry.reason)).toEqual([
      "over_max_comments",
      "over_max_comments",
    ]);
    expect(result.dropped.map((entry) => entry.reason)).toEqual([
      "over_max_comments",
      "over_max_comments",
    ]);
  });

  it("orders same-severity comments by higher confidence first", () => {
    const inputs = [
      finding({ line: 1, severity: "high", confidence: 0.7 }),
      finding({ line: 2, severity: "high", confidence: 0.95 }),
    ];
    const result = validateFindings(inputs, [file()], { min_severity: "low", max_comments: 1 });
    expect(result.inline.map((entry) => entry.finding.line)).toEqual([2]);
    expect(result.generalNotes).toEqual([{ finding: inputs[0]!, reason: "over_max_comments" }]);
  });

  it("defaults to a cap of 10", () => {
    const inputs = Array.from({ length: 12 }, (_, index) =>
      finding({ line: index + 1, severity: "high" }),
    );
    const many = file({
      patch: [
        "@@ -1,12 +1,12 @@",
        ...Array.from({ length: 12 }, (_, index) => ` line${index + 1}`),
      ].join("\n"),
    });
    const result = validateFindings(inputs, [many], LOW);
    expect(result.inline).toHaveLength(10);
    expect(result.generalNotes).toHaveLength(2);
    expect(result.dropped.map((entry) => entry.reason)).toEqual([
      "over_max_comments",
      "over_max_comments",
    ]);
  });
});

describe("validateFindings suggestion handling", () => {
  it("drops the suggestion when falling back to a single-line comment", () => {
    const input = finding({ startLine: 1, line: 13, suggestion: "cross-hunk fix" });
    const result = validateFindings([input], [file()], LOW);
    expect(result.single).toEqual([
      { finding: input, startLine: 13, line: 13, suggestionKept: false },
    ]);
  });

  it("keeps the suggestion on a normalized in-hunk range", () => {
    const input = finding({ startLine: 4, line: 1, suggestion: "reversed range" });
    const result = validateFindings([input], [file()], LOW);
    expect(result.inline).toEqual([
      { finding: input, startLine: 1, line: 4, suggestionKept: true },
    ]);
  });
});
