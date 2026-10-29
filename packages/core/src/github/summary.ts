import type { Finding } from "../schema";
import { SEVERITY_ICON } from "./review-body";
import { MAX_COMMENT_CHARS, sanitizeForPosting, type SanitizeCommentOptions } from "./sanitize";

export const SUMMARY_MARKER = "<!-- hammer:summary -->";

const ZERO_WIDTH_JOINER = "‍";

export interface SummaryScopeFile {
  path: string;
  status: string;
  previousPath?: string | undefined;
}

export interface SkippedSummaryFile {
  path: string;
  reason: string;
}

export interface RenderSummaryOptions {
  files: SummaryScopeFile[];
  skipped?: SkippedSummaryFile[];
  notReviewed?: SkippedSummaryFile[];
  headSha?: string | null | undefined;
  findings?: Finding[];
  summary?: string;
  generalNotes?: string[];
  model?: string;
  tokens?: number;
  costUsd?: number | null;
  partial?: boolean;
  unverified?: boolean;
  reviewError?: string;
  error?: string;
  runUrl?: string;
  repoUrl?: string;
}

export function sanitizeSummaryText(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^()]*\)/g, "")
    .replace(/<[^<>]*>/g, "")
    .replace(/`/g, "")
    .replace(/@/g, `@${ZERO_WIDTH_JOINER}`);
}

function lastShaLine(headSha: string | null | undefined): string | null {
  if (headSha === undefined || headSha === null || headSha === "") return null;
  return `<!-- hammer:last-sha=${headSha} -->`;
}

const SAFE_LINK_PATH = /^[\w./-]+$/;

function severityLabel(severity: Finding["severity"]): string {
  return `${SEVERITY_ICON[severity]} ${severity[0]?.toUpperCase() ?? ""}${severity.slice(1)}`;
}

function describeFile(file: SummaryScopeFile): string {
  const path = sanitizeSummaryText(file.path);
  if (file.status === "renamed" && file.previousPath !== undefined && file.previousPath !== "") {
    return `- \`${sanitizeSummaryText(file.previousPath)}\` → \`${path}\` — renamed`;
  }
  return `- \`${path}\` — ${sanitizeSummaryText(file.status)}`;
}

function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
}

function findingFileCell(finding: Finding, options: RenderSummaryOptions): string {
  const label = `${tableCell(finding.path)}:${finding.line}`;
  if (!options.repoUrl || !options.headSha || !SAFE_LINK_PATH.test(finding.path)) return label;
  const anchor =
    finding.startLine !== undefined && finding.startLine < finding.line
      ? `L${finding.startLine}-L${finding.line}`
      : `L${finding.line}`;
  const shortSha = options.headSha.slice(0, 7);
  return `[${label}](${options.repoUrl}/blob/${shortSha}/${finding.path}#${anchor})`;
}

function formatTokens(tokens: number): string {
  return `${tokens.toLocaleString("en-US")} tokens`;
}

function detailsBlock(summary: string, entries: string[]): string[] {
  return ["<details>", `<summary>${summary}</summary>`, "", ...entries, "", "</details>"];
}

export function renderSummaryBody(options: RenderSummaryOptions): string {
  const lines: string[] = [SUMMARY_MARKER, "### Hammer Review", ""];
  const incomplete = options.reviewError !== undefined;
  if (options.reviewError !== undefined) {
    lines.push(
      "> [!WARNING]",
      `> **Not reviewed.** ${sanitizeSummaryText(options.reviewError).replace(/\s+/g, " ").trim()}`,
      "> Hammer could not finish reviewing this PR, so having no findings does not mean the code is clean.",
      "",
    );
  }
  if (options.findings !== undefined && !incomplete) {
    const high = options.findings.filter((finding) => finding.severity === "high").length;
    lines.push(
      `${options.findings.length} findings (${high} high)${options.partial ? " · partial" : ""}`,
      "",
    );
    if (high > 0)
      lines.push(
        "> [!CAUTION]",
        `> ${high} high-severity issue(s) should be fixed before merge.`,
        "",
      );
    if (options.findings.length === 0 && !options.error)
      lines.push(
        options.partial ? "No issues found in the completed portion." : "No issues found.",
        "",
      );
    if (options.summary) lines.push(`**What this PR does:** ${options.summary}`, "");
    if (options.findings.length > 0) {
      lines.push("| Severity | File | Finding |", "| --- | --- | --- |");
      for (const finding of options.findings) {
        lines.push(
          `| ${severityLabel(finding.severity)} | ${findingFileCell(finding, options)} | ${tableCell(finding.title)} |`,
        );
      }
      lines.push("");
    }
  }
  if (options.error)
    lines.push(
      `Review error: ${options.error}`,
      options.runUrl ? `Run: ${options.runUrl}` : "",
      "",
    );
  if (options.unverified && !incomplete && (options.findings?.length ?? 0) > 0)
    lines.push(
      "> [!NOTE]",
      "> Not verified: the verifier did not finish, so these findings were not double-checked.",
      "",
    );
  if (options.generalNotes?.length)
    lines.push("General notes:", "", ...options.generalNotes.map((note) => `- ${note}`), "");
  const files = options.files;
  const skipped = options.skipped ?? [];
  const notReviewed = options.notReviewed ?? [];
  const footer: string[] = [
    incomplete
      ? `Not reviewed: ${files.length} file${files.length === 1 ? "" : "s"} in scope`
      : `Reviewed ${files.length} file${files.length === 1 ? "" : "s"}${options.headSha ? ` at \`${options.headSha.slice(0, 7)}\`` : ""}`,
  ];
  if (skipped.length > 0) footer.push(`skipped ${skipped.length}`);
  if (notReviewed.length > 0) footer.push(`not reviewed ${notReviewed.length}`);
  if (options.model) footer.push(options.model);
  if (options.tokens !== undefined) footer.push(formatTokens(options.tokens));
  if (options.costUsd != null) footer.push(`$${options.costUsd.toFixed(4)}`);
  lines.push(footer.join(" · "), "");
  const fileEntries = files.length === 0 ? ["_No files in scope._"] : files.map(describeFile);
  lines.push(...detailsBlock(`Files in scope (${files.length})`, fileEntries));
  if (skipped.length > 0) {
    lines.push(
      "",
      ...detailsBlock(
        `Skipped files (${skipped.length})`,
        skipped.map(
          (entry) =>
            `- \`${sanitizeSummaryText(entry.path)}\` — ${sanitizeSummaryText(entry.reason)}`,
        ),
      ),
    );
  }
  if (notReviewed.length > 0) {
    lines.push(
      "",
      ...detailsBlock(
        `Not reviewed (${notReviewed.length})`,
        notReviewed.map(
          (entry) =>
            `- \`${sanitizeSummaryText(entry.path)}\` — ${sanitizeSummaryText(entry.reason)}`,
        ),
      ),
    );
  }
  const shaLine = lastShaLine(options.headSha);
  if (shaLine !== null) {
    lines.push("", shaLine);
  }
  return `${lines.join("\n")}\n`;
}

export interface ListedComment {
  id: number;
  body?: string | null | undefined;
}

export type ListCommentPage = (page: number, perPage: number) => Promise<ListedComment[]>;

export type CreateIssueComment = (body: string) => Promise<{ id: number }>;

export type UpdateComment = (commentId: number, body: string) => Promise<void>;

export interface UpsertSummaryOptions {
  perPage?: number;
  sanitizeOptions?: SanitizeCommentOptions;
}

export interface UpsertSummaryResult {
  id: number;
  action: "created" | "updated";
}

export async function upsertSummaryComment(
  listComments: ListCommentPage,
  createComment: CreateIssueComment,
  updateComment: UpdateComment,
  body: string,
  options: UpsertSummaryOptions = {},
): Promise<UpsertSummaryResult> {
  const sha = /<!--\s*hammer:last-sha=([0-9a-f]{4,64})\s*-->\s*$/i.exec(body)?.[1];
  const metadata = `${SUMMARY_MARKER}\n`;
  const state = sha ? `\n<!-- hammer:last-sha=${sha} -->` : "";
  body = `${metadata}${sanitizeForPosting(body, options.sanitizeOptions)
    .replace(/^\n/, "")
    .slice(0, MAX_COMMENT_CHARS - metadata.length - state.length)}${state}`;
  const perPage = Math.max(1, Math.floor(options.perPage ?? 100));
  let page = 1;
  for (;;) {
    const comments = await listComments(page, perPage);
    for (const comment of comments) {
      if (comment.body?.includes(SUMMARY_MARKER) === true) {
        await updateComment(comment.id, body);
        return { id: comment.id, action: "updated" };
      }
    }
    if (comments.length < perPage) break;
    page += 1;
  }
  const created = await createComment(body);
  return { id: created.id, action: "created" };
}
