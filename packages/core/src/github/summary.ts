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
  headSha?: string | null | undefined;
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
