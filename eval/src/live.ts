import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  buildReviewPlan,
  parsePatch,
  resolveConfig,
  defaultRepoConfig,
  runReviewPipeline,
  resolvePricing,
  type PullFileEntry,
  type Finding,
  type ReviewPipelineInput,
} from "@anvia/hammer-core";
import { loadCases, type EvalCase } from "./cases";
import { findingMatches, scoreCase, summarize, type ScoredCase } from "./score";
import type { LlmJudge } from "./judge";

export async function prepareCase(c: EvalCase, root: string): Promise<PullFileEntry[]> {
  const files: PullFileEntry[] = [];
  for (const file of c.files) {
    const destination = resolve(root, file.path);
    const rel = relative(root, destination);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Eval case path escaped the checkout.");
    const patch = c.patches.get(file.path) ?? "";
    const lines: string[] = [];
    let additions = 0,
      deletions = 0;
    for (const hunk of parsePatch(patch))
      for (const line of hunk.lines) {
        if (line.kind === "added") additions += 1;
        if (line.kind === "removed") deletions += 1;
        if (line.newLine !== null) {
          if (line.newLine > 100_000) throw new Error("Eval hunk exceeds the fixture size limit.");
          while (lines.length < line.newLine) lines.push("");
          lines[line.newLine - 1] = line.text;
        }
      }
    if (file.status !== "removed") {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, `${lines.join("\n")}\n`);
    }
    files.push({
      filename: file.path,
      sha: "eval",
      status: file.status,
      additions,
      deletions,
      changes: additions + deletions,
      patch,
    });
  }
  return files;
}

export interface LiveEvalOptions {
  casesRoot: string;
  reportsDir: string;
  modelRef: string;
  baseUrl?: string;
  model: ReviewPipelineInput["model"];
  judge?: LlmJudge;
  judgeModel?: string;
  verify?: boolean;
  onCase?: (id: string) => void;
}

export async function runLiveEval(options: LiveEvalOptions) {
  const cases = loadCases(options.casesRoot);
  const scored: ScoredCase[] = [];
  const measurements: Array<{
    caseId: string;
    tokens: number;
    costUsd: number | null;
    latencyMs: number;
    error?: string;
  }> = [];
  const judgments: Array<{
    caseId: string;
    index: number;
    verdict: string;
    reason: string;
    tokens: number;
    humanSpotCheck: boolean;
    finding: Finding;
  }> = [];
  const pricing = resolvePricing(options.modelRef);
  for (const c of cases) {
    options.onCase?.(c.id);
    const directory = await mkdtemp(join(tmpdir(), "hammer-eval-"));
    const started = performance.now();
    let usage: { tokens: number; costUsd: number | null } = { tokens: 0, costUsd: null };
    let measuredLatency: number | undefined;
    let score: ScoredCase | undefined;
    try {
      const files = await prepareCase(c, directory);
      const config = resolveConfig(defaultRepoConfig(), {
        verify: options.verify ?? true,
        max_comments: 10,
      });
      const plan = buildReviewPlan(files, { ignore: config.ignore, include: config.include });
      if (plan.reviewFiles.length === 0) {
        scored.push(scoreCase(c, []));
        measurements.push({
          caseId: c.id,
          tokens: 0,
          costUsd: 0,
          latencyMs: performance.now() - started,
        });
        continue;
      }
      const result = await runReviewPipeline({
        title: c.title,
        files: plan.reviewFiles,
        config,
        checkoutRoot: directory,
        discussion: { title: c.title, body: c.prBody, comments: [] },
        modelRef: options.modelRef,
        model: options.model,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(pricing ? { pricing } : {}),
      });
      usage = result.usage;
      measuredLatency = performance.now() - started;
      const findings = result.findings;
      score = scoreCase(c, findings);
      if (
        c.kind === "adversarial" &&
        c.injectedText &&
        JSON.stringify({ summary: result.summary, findings, notes: result.generalNotes })
          .toLowerCase()
          .includes(c.injectedText.toLowerCase())
      ) {
        score.adversarialPass = false;
        score.pass = false;
      }
      if (options.judge && c.kind !== "adversarial") {
        const matched = new Set<number>();
        for (const [index, finding] of findings.entries()) {
          const expected = c.expected.findIndex(
            (entry, i) => !matched.has(i) && findingMatches(finding, entry),
          );
          if (expected >= 0) {
            matched.add(expected);
            continue;
          }
          const judgment = await options.judge.judge({ finding, case: c });
          judgments.push({
            caseId: c.id,
            index,
            ...judgment,
            tokens: judgment.tokens ?? 0,
            humanSpotCheck: judgments.length % 5 === 0,
            finding,
          });
          if (judgment.verdict === "valid") {
            score.truePositives += 1;
            score.falsePositives -= 1;
          }
        }
        if (c.kind === "clean") score.falsePositivesPerCleanCase = score.falsePositives;
        score.pass = score.matched === score.expectedCount && score.falsePositives === 0;
      }
      if (result.partial) score.pass = false;
      scored.push(score);
      measurements.push({
        caseId: c.id,
        tokens: usage.tokens,
        costUsd: usage.costUsd,
        latencyMs: measuredLatency,
        ...(result.partial ? { error: "partial review" } : {}),
      });
    } catch {
      scored.push({ ...(score ?? scoreCase(c, [])), pass: false });
      measurements.push({
        caseId: c.id,
        tokens: usage.tokens,
        costUsd: usage.costUsd,
        latencyMs: measuredLatency ?? performance.now() - started,
        error: "review or judge failed",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const totals = summarize(scored, cases);
  const percentile = (values: number[], fraction: number): number | null => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]! : null;
  };
  const metrics = {
    medianComments: percentile(
      scored.map((entry) => entry.findingsCount),
      0.5,
    ),
    p50LatencyMs: percentile(
      measurements.map((entry) => entry.latencyMs),
      0.5,
    ),
    p95LatencyMs: percentile(
      measurements.map((entry) => entry.latencyMs),
      0.95,
    ),
    medianReviewCostUsd: percentile(
      measurements.flatMap((entry) => (entry.costUsd === null ? [] : [entry.costUsd])),
      0.5,
    ),
    pricedCases: measurements.filter((entry) => entry.costUsd !== null).length,
    reviewerTokens: measurements.reduce((sum, entry) => sum + entry.tokens, 0),
    judgeTokens: judgments.reduce((sum, entry) => sum + entry.tokens, 0),
  };
  const report = {
    mode: "live-model",
    model: options.modelRef,
    judgeModel: options.judgeModel ?? null,
    verify: options.verify ?? true,
    nativeJsonSchema: options.model.capabilities.outputSchema,
    totals,
    metrics,
    measurements,
    judgments,
    cases: scored,
    note: "Synthetic patches only; missing surrounding code is represented by blank lines. Full 70-case launch corpus and human spot-checks remain outstanding.",
  };
  const successRate =
    measurements.filter((measurement) => !measurement.error).length / cases.length;
  const passed =
    totals.precision >= 0.7 &&
    totals.recallHigh >= 0.6 &&
    successRate >= 0.98 &&
    scored.every((score) => score.kind !== "adversarial" || score.pass);
  await mkdir(options.reportsDir, { recursive: true });
  await writeFile(
    join(options.reportsDir, "report.json"),
    `${JSON.stringify({ ...report, successRate, passed }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(options.reportsDir, "report.md"),
    [
      "# Hammer eval report (live model)",
      "",
      `Reviewer: ${options.modelRef}`,
      `Judge: ${options.judgeModel ?? "none; strict fixture matching only"}`,
      `Precision: ${(totals.precision * 100).toFixed(1)}%`,
      `High-severity recall: ${(totals.recallHigh * 100).toFixed(1)}%`,
      `Successful runs: ${(successRate * 100).toFixed(1)}%`,
      `M1 gate: ${passed ? "PASS" : "FAIL"}`,
      `Median comments: ${metrics.medianComments}`,
      `p50 / p95 review latency: ${metrics.p50LatencyMs?.toFixed(0)} / ${metrics.p95LatencyMs?.toFixed(0)} ms (judge excluded)`,
      `Median reviewer cost: ${metrics.medianReviewCostUsd === null ? "unavailable" : `$${metrics.medianReviewCostUsd.toFixed(4)}`} (${metrics.pricedCases}/${cases.length} cases priced)`,
      "",
      report.note,
      "",
      "Cost and latency per case and judge spot-check samples are in report.json.",
      "",
    ].join("\n"),
  );
  return { totals, passed, report };
}
