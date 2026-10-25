import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { oracleReviewer, renderMarkdownReport, runEval } from "../src/runner";

const CASES_ROOT = join(import.meta.dirname, "..", "cases");

describe("offline oracle run", () => {
  it("passes all cases with 100% precision and full high-severity recall", async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), "hammer-eval-reports-"));
    const { totals, scored } = await runEval(CASES_ROOT, oracleReviewer, { reportsDir });
    expect(scored).toHaveLength(31);
    expect(totals.passed).toBe(31);
    expect(totals.precision).toBe(1);
    expect(totals.recallHigh).toBe(1);
    expect(totals.falsePositivesPerCleanCase).toBe(0);
  });

  it("reports the M1 gate line and the real-model note", async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), "hammer-eval-reports-"));
    const { totals, scored } = await runEval(CASES_ROOT, oracleReviewer, { reportsDir });
    const markdown = renderMarkdownReport(totals, scored);
    expect(markdown).toContain("precision >= 70%");
    expect(markdown).toContain("real model results are not measured yet");
  });
});
