import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateFindings, type Finding, type PullFileEntry } from "@anvia/hammer-core";

import { loadCases, type EvalCase } from "./cases";
import { scoreCase, summarize, type EvalTotals, type ScoredCase } from "./score";

export const M1_PRECISION_TARGET = 0.7;

export type ReviewerFn = (c: EvalCase) => Finding[] | Promise<Finding[]>;

export interface EvalRunResult {
  totals: EvalTotals;
  scored: ScoredCase[];
}

function caseFiles(c: EvalCase): PullFileEntry[] {
  return c.files.map((file) => ({
    sha: "eval",
    filename: file.path,
    status: file.status === "removed" ? "removed" : "modified",
    additions: 0,
    deletions: 0,
    changes: 0,
    patch: c.patches.get(file.path),
  }));
}

export async function runEval(
  casesRoot: string,
  reviewer: ReviewerFn,
  options: { reportsDir?: string; writeReports?: boolean } = {},
): Promise<EvalRunResult> {
  const cases = loadCases(casesRoot);
  const scored: ScoredCase[] = [];
  for (const c of cases) {
    const raw = await reviewer(c);
    const validated = validateFindings(raw, caseFiles(c), {
      min_severity: "low",
      max_comments: 25,
    });
    const kept = [
      ...validated.inline.map((entry) => entry.finding),
      ...validated.single.map((entry) => entry.finding),
    ];
    scored.push(scoreCase(c, kept));
  }
  const totals = summarize(scored, cases);
  if (options.writeReports !== false) {
    writeReports(options.reportsDir ?? join(casesRoot, "..", "reports"), totals, scored);
  }
  return { totals, scored };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderMarkdownReport(totals: EvalTotals, scored: ScoredCase[]): string {
  const gate = totals.precision >= M1_PRECISION_TARGET ? "PASS" : "FAIL";
  const lines = [
    "# Hammer eval report (offline oracle)",
    "",
    `- Cases: ${totals.cases} (${totals.passed} passed)`,
    `- High-severity recall: ${percent(totals.recallHigh)} (${totals.matchedHigh}/${totals.expectedHigh})`,
    `- Precision: ${percent(totals.precision)} (${totals.truePositives}/${totals.findings})`,
    `- False positives per clean case: ${totals.falsePositivesPerCleanCase.toFixed(2)}`,
    `- Gate (M1 target: precision >= 70%): ${gate}`,
    "- Note: real model results are not measured yet; this run uses the deterministic offline oracle.",
    "",
    "| Case | Kind | Findings | Matched | FP | Pass |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const s of scored) {
    lines.push(
      `| ${s.caseId} | ${s.kind} | ${s.findingsCount} | ${s.matched}/${s.expectedCount} | ${s.falsePositives} | ${s.pass ? "pass" : "fail"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function writeReports(dir: string, totals: EvalTotals, scored: ScoredCase[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.md"), renderMarkdownReport(totals, scored));
  writeFileSync(join(dir, "report.json"), JSON.stringify({ totals, cases: scored }, null, 2));
}

export function oracleReviewer(c: EvalCase): Finding[] {
  if (c.kind !== "seeded") return [];
  return c.expected.map((e) => ({
    path: e.path,
    startLine: e.startLine === e.endLine ? undefined : e.startLine,
    line: e.endLine,
    severity: e.severity,
    category: e.category,
    title: `Eval oracle: expected ${e.category} finding`,
    body: "Offline oracle finding for a seeded defect. Real model results are not measured yet.",
    confidence: 1,
  }));
}
