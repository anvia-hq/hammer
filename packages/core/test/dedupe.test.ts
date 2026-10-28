import { describe, expect, it } from "vitest";

import {
  buildPriorFindingsContext,
  buildResolvedFindingsContext,
  filterDuplicates,
  fingerprints,
  formatFingerprintComment,
  isDuplicate,
  parsePriorFingerprints,
} from "../src/index";

describe("fingerprints", () => {
  it("is identical for the same path and body with different whitespace and case", () => {
    const left = fingerprints("src/app.ts", "  Fix  the   NULL  pointer\nDeref ");
    const right = fingerprints("src/app.ts", "fix the null pointer deref");
    expect(left).toEqual(right);
  });

  it("differs for a different path", () => {
    const left = fingerprints("src/a.ts", "fix the bug");
    const right = fingerprints("src/b.ts", "fix the bug");
    expect(left.bodyFp).not.toBe(right.bodyFp);
  });

  it("takes no line number input", () => {
    const params = fingerprints.toString().slice(0, fingerprints.toString().indexOf(")"));
    expect(params.toLowerCase()).not.toContain("line");
  });

  it("hashes an empty suggestion as an empty string", () => {
    expect(fingerprints("src/app.ts", "body").suggestionFp).toBe(
      fingerprints("src/app.ts", "body", "").suggestionFp,
    );
    expect(fingerprints("src/app.ts", "body").suggestionFp).not.toBe(
      fingerprints("src/app.ts", "body", "code").suggestionFp,
    );
  });

  it("round-trips through the fingerprint comment marker", () => {
    const fp = fingerprints("src/app.ts", "fix it", "code();");
    const body = `Some comment\n${formatFingerprintComment(fp)}`;
    expect(formatFingerprintComment(fp)).toBe(`<!-- hammer:fp=${fp.bodyFp},${fp.suggestionFp} -->`);
    const parsed = parsePriorFingerprints([body]);
    expect(parsed.has(fp.bodyFp)).toBe(true);
    expect(parsed.has(fp.suggestionFp)).toBe(true);
  });
});

describe("isDuplicate", () => {
  it("flags a body match as a duplicate", () => {
    const prior = fingerprints("src/app.ts", "null deref here", "other();");
    const priorSet = parsePriorFingerprints([formatFingerprintComment(prior)]);
    expect(isDuplicate({ path: "src/app.ts", body: "null deref here" }, priorSet)).toBe(true);
  });

  it("flags a suggestion match alone as a duplicate", () => {
    const prior = fingerprints("src/app.ts", "totally different text", "fix();");
    const priorSet = parsePriorFingerprints([formatFingerprintComment(prior)]);
    expect(
      isDuplicate(
        { path: "src/app.ts", body: "unrelated wording", suggestion: "fix();" },
        priorSet,
      ),
    ).toBe(true);
  });

  it("does not flag an unrelated finding", () => {
    const prior = fingerprints("src/app.ts", "null deref here", "fix();");
    const priorSet = parsePriorFingerprints([formatFingerprintComment(prior)]);
    expect(
      isDuplicate(
        { path: "src/app.ts", body: "missing await", suggestion: "await x();" },
        priorSet,
      ),
    ).toBe(false);
  });
});

describe("filterDuplicates", () => {
  it("keeps zero findings on a re-run when all are already present", () => {
    const findings = [
      { path: "src/a.ts", body: "first issue" },
      { path: "src/b.ts", body: "second issue", suggestion: "fix();" },
    ];
    const priorSet = parsePriorFingerprints(
      findings.map((finding) =>
        formatFingerprintComment(fingerprints(finding.path, finding.body, finding.suggestion)),
      ),
    );
    const result = filterDuplicates(findings, priorSet);
    expect(result.kept).toHaveLength(0);
    expect(result.duplicates).toHaveLength(2);
  });

  it("still yields zero kept after shifting code by 10 lines", () => {
    const prior = filterDuplicates(
      [{ path: "src/a.ts", body: "first issue", suggestion: "fix();" }],
      new Set<string>(),
    );
    expect(prior.kept).toHaveLength(1);
    const priorSet = parsePriorFingerprints([
      `old comment at line 12\n${formatFingerprintComment(
        fingerprints("src/a.ts", "first issue", "fix();"),
      )}`,
    ]);
    const shifted = { path: "src/a.ts", body: "first issue", suggestion: "fix();" };
    const result = filterDuplicates([shifted], priorSet);
    expect(result.kept).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
  });

  it("never remaps lines", () => {
    const findings = [{ path: "src/a.ts", body: "issue", suggestion: "fix();", line: 42 }];
    const result = filterDuplicates(findings, new Set<string>());
    expect(result.kept).toEqual(findings);
  });
});

describe("parsePriorFingerprints", () => {
  it("extracts markers from several comment bodies", () => {
    const first = fingerprints("src/a.ts", "one");
    const second = fingerprints("src/b.ts", "two", "code();");
    const bodies = [
      `text ${formatFingerprintComment(first)} tail`,
      "no marker here",
      `first ${formatFingerprintComment(first)}\nsecond ${formatFingerprintComment(second)}`,
    ];
    const parsed = parsePriorFingerprints(bodies);
    expect(parsed.has(first.bodyFp)).toBe(true);
    expect(parsed.has(first.suggestionFp)).toBe(true);
    expect(parsed.has(second.bodyFp)).toBe(true);
    expect(parsed.has(second.suggestionFp)).toBe(true);
  });
});

describe("buildPriorFindingsContext", () => {
  it("truncates at 8000 chars", () => {
    const priorFindings = Array.from({ length: 40 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      line: index + 1,
      title: `Finding ${index}`,
      body: "x".repeat(1000),
    }));
    const context = buildPriorFindingsContext(priorFindings);
    expect(context.length).toBeLessThanOrEqual(8000);
    const untruncated = buildPriorFindingsContext(priorFindings, Number.MAX_SAFE_INTEGER);
    expect(untruncated.length).toBeGreaterThan(8000);
  });
});

it("keeps unrelated findings on the same file when neither has a suggestion", () => {
  const previous = fingerprints("src/a.ts", "first issue");
  const prior = parsePriorFingerprints([formatFingerprintComment(previous)]);
  expect(isDuplicate({ path: "src/a.ts", body: "different issue" }, prior)).toBe(false);
});

describe("buildResolvedFindingsContext", () => {
  it("tells the model not to raise resolved findings again", () => {
    const context = buildResolvedFindingsContext([
      { path: "src/a.ts", line: 3, title: "Previous finding", body: "Null deref" },
    ]);
    expect(context).toContain("marked resolved");
    expect(context).toContain("src/a.ts:3");
  });
});
