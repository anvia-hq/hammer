import { sanitizeForPosting } from "./github/sanitize";

export interface ActionOutputFinding {
  severity: "high" | "medium" | "low";
}

export interface BuildActionOutputsInput {
  findings: ActionOutputFinding[];
  tokens?: number;
  costUsd?: number | null;
  resultPath?: string;
  reviewUrl?: string | null;
}

export interface ActionOutputs {
  findings_count: string;
  high_count: string;
  review_url: string;
  result_path: string;
  tokens: string;
  cost_usd: string;
}

function normalizeTokens(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens)) return "0";
  return String(Math.max(0, Math.floor(tokens)));
}

function normalizeCost(costUsd: number | null | undefined): string {
  if (costUsd === null || costUsd === undefined || !Number.isFinite(costUsd)) return "";
  return String(costUsd);
}

export function buildActionOutputs(input: BuildActionOutputsInput): ActionOutputs {
  const findings = input.findings;
  const high = findings.filter((finding) => finding.severity === "high").length;
  return {
    findings_count: String(findings.length),
    high_count: String(high),
    review_url: input.reviewUrl ?? "",
    result_path: input.resultPath ?? "",
    tokens: normalizeTokens(input.tokens),
    cost_usd: normalizeCost(input.costUsd),
  };
}

export interface JobSummarySkipped {
  reason: string;
  code?: string | null;
}

export interface JobSummaryNotReviewedFile {
  path: string;
  reason: string;
}

export interface RenderJobSummaryInput {
  skipped?: JobSummarySkipped | null;
  postedInline?: number;
  generalNotes?: number;
  droppedByReason?: Record<string, number>;
  filesReviewed?: string[];
  filesNotReviewed?: JobSummaryNotReviewedFile[];
  tokens?: number;
  costUsd?: number | null;
  partial?: boolean;
  partialReason?: string | null;
  modelSummary?: string | null;
  error?: string | null;
}

export type WriteFileFn = (path: string, data: string) => void | Promise<void>;

export async function writeResultJson(
  path: string,
  result: unknown,
  writeFile: WriteFileFn,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br />");
}

function droppedCell(droppedByReason: Record<string, number>): string {
  const entries = Object.entries(droppedByReason)
    .filter((entry) => Number.isFinite(entry[1]) && entry[1] !== 0)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const total = entries.reduce((sum, entry) => sum + Math.max(0, Math.floor(entry[1])), 0);
  if (entries.length === 0) return String(total);
  const reasons = entries.map((entry) => `${entry[0]}: ${entry[1]}`).join(", ");
  return `${total} (${reasons})`;
}

function notReviewedCell(files: JobSummaryNotReviewedFile[]): string {
  if (files.length === 0) return "0";
  const listed = files
    .map((file) => `${escapeTableCell(file.path)} — ${escapeTableCell(file.reason)}`)
    .join("<br />");
  return `${files.length}<br />${listed}`;
}

function row(metric: string, value: string): string {
  return `| ${metric} | ${escapeTableCell(value)} |`;
}

export function renderJobSummaryMarkdown(input: RenderJobSummaryInput = {}): string {
  const postedInline = Math.max(0, Math.floor(input.postedInline ?? 0));
  const generalNotes = Math.max(0, Math.floor(input.generalNotes ?? 0));
  const filesReviewed = input.filesReviewed ?? [];
  const filesNotReviewed = input.filesNotReviewed ?? [];
  const tokens = normalizeTokens(input.tokens);
  const cost =
    input.costUsd === null || input.costUsd === undefined || !Number.isFinite(input.costUsd)
      ? "n/a"
      : `$${input.costUsd}`;
  const partial =
    input.partial === true ? `yes${input.partialReason ? ` — ${input.partialReason}` : ""}` : "no";

  const lines: string[] = [];
  if (input.skipped !== null && input.skipped !== undefined) {
    lines.push("## Hammer Review (skipped)", "");
    const code =
      input.skipped.code !== null && input.skipped.code !== undefined && input.skipped.code !== ""
        ? ` [${input.skipped.code}]`
        : "";
    lines.push(`Skipped:${code} ${escapeTableCell(input.skipped.reason)}`, "");
  } else {
    lines.push("## Hammer Review", "");
  }

  if (
    input.modelSummary !== null &&
    input.modelSummary !== undefined &&
    input.modelSummary !== ""
  ) {
    lines.push(sanitizeForPosting(input.modelSummary), "");
  }

  lines.push("| Metric | Value |", "| --- | --- |");
  if (input.skipped !== null && input.skipped !== undefined) {
    const code =
      input.skipped.code !== null && input.skipped.code !== undefined && input.skipped.code !== ""
        ? ` [${input.skipped.code}]`
        : "";
    lines.push(row("Skipped", `${input.skipped.reason}${code}`));
  }
  lines.push(row("Posted inline", String(postedInline)));
  lines.push(row("General notes", String(generalNotes)));
  lines.push(`| Dropped | ${escapeTableCell(droppedCell(input.droppedByReason ?? {}))} |`);
  lines.push(row("Files reviewed", String(filesReviewed.length)));
  lines.push(`| Files not reviewed | ${notReviewedCell(filesNotReviewed)} |`);
  lines.push(row("Tokens", tokens));
  lines.push(row("Cost (USD)", cost));
  lines.push(row("Partial", partial));

  if (input.error !== null && input.error !== undefined && input.error !== "") {
    lines.push("", "### Error", "", sanitizeForPosting(input.error));
  }

  return `${lines.join("\n")}\n`;
}
