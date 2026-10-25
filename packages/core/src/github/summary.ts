import type { Finding } from "../agent/schema";
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
  error?: string;
  runUrl?: string;
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

function describeFile(file: SummaryScopeFile): string {
  const path = sanitizeSummaryText(file.path);
  if (file.status === "renamed" && file.previousPath !== undefined && file.previousPath !== "") {
    return `- \`${sanitizeSummaryText(file.previousPath)}\` → \`${path}\` — renamed`;
  }
  return `- \`${path}\` — ${sanitizeSummaryText(file.status)}`;
}

export function renderSummaryBody(options: RenderSummaryOptions): string {
  const lines: string[] = [SUMMARY_MARKER, "### Hammer Review", ""];
  if (options.findings !== undefined) {
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
        const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
        lines.push(
          `| ${finding.severity} | ${cell(finding.path)}:${finding.line} | ${cell(finding.title)} |`,
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
  if (options.unverified) lines.push("Verification: unverified.", "");
  if (options.generalNotes?.length)
    lines.push("General notes:", "", ...options.generalNotes.map((note) => `- ${note}`), "");
  if (options.model)
    lines.push(
      `${options.model} · ${options.tokens ?? 0} tokens · ${options.costUsd == null ? "cost unavailable" : `$${options.costUsd.toFixed(4)}`}`,
      "",
    );
  const files = options.files;
  lines.push(`Files in scope (${files.length}):`);
  if (files.length === 0) {
    lines.push("", "_No files in scope._");
  } else {
    lines.push("", ...files.map(describeFile));
  }
  const skipped = options.skipped ?? [];
  if (skipped.length > 0) {
    lines.push("", `Skipped files (${skipped.length}):`, "");
    for (const entry of skipped) {
      lines.push(`- \`${sanitizeSummaryText(entry.path)}\` — ${sanitizeSummaryText(entry.reason)}`);
    }
  }
  const notReviewed = options.notReviewed ?? [];
  if (notReviewed.length > 0) {
    lines.push("", `Not reviewed (${notReviewed.length}):`, "");
    for (const entry of notReviewed) {
      lines.push(`- \`${sanitizeSummaryText(entry.path)}\` — ${sanitizeSummaryText(entry.reason)}`);
    }
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
