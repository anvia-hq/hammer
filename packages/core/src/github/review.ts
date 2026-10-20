import { formatFingerprintComment, type FindingFingerprints } from "../dedupe";
import { MAX_COMMENT_CHARS, sanitizeForPosting, type SanitizeCommentOptions } from "./sanitize";

export type ReviewCommentEvent = "COMMENT";

export type ReviewPostErrorCode = "invalid_event" | "invalid_comment" | "review_failed";

export interface PullReviewInlineInput {
  path: string;
  line: number;
  body: string;
  start_line?: number;
  fingerprints?: FindingFingerprints;
}

export interface PostPullReviewInput {
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
  inline: PullReviewInlineInput[];
  body: string;
  event?: string;
}

export interface ReviewApiComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
  start_line?: number | undefined;
  start_side?: "RIGHT" | undefined;
}

export interface CreateReviewPayload {
  owner: string;
  repo: string;
  pull_number: number;
  commit_id: string;
  event: ReviewCommentEvent;
  body: string;
  comments: ReviewApiComment[];
}

export type CreateReviewFn = (payload: CreateReviewPayload) => Promise<unknown>;

export type SleepFn = (ms: number) => Promise<void>;

export interface PostPullReviewDeps {
  createReview: CreateReviewFn;
  sleep?: SleepFn;
  sanitizeOptions?: SanitizeCommentOptions;
}

export interface ReviewPostFailure {
  ok: false;
  error: ReviewPostErrorCode;
  message: string;
}

export interface MovedToSummaryNote {
  path: string;
  line: number;
  body: string;
}

export interface PostPullReviewSuccess {
  ok: true;
  attempts: number;
  movedToSummary: MovedToSummaryNote[];
}

export type PostPullReviewResult = PostPullReviewSuccess | ReviewPostFailure;

export const GENERIC_RETRY_SLEEPS_MS = [1000, 3000];

const GENERIC_422_MARKERS = ["unprocessable entity", "internal error"];

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorDetails(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      parts.push(value.toLowerCase());
    } else if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
    } else if (typeof value === "object" && value !== null) {
      for (const entry of Object.values(value as Record<string, unknown>)) collect(entry);
    }
  };
  collect(record["errors"]);
  collect(record["response"]);
  return parts.join(" ");
}

function isGeneric422(message: string): boolean {
  const lowered = message.toLowerCase();
  return GENERIC_422_MARKERS.some((marker) => lowered.includes(marker));
}

function namesAnchor(message: string, details: string, comment: ReviewApiComment): boolean {
  const haystack = `${message.toLowerCase()} ${details}`;
  return (
    haystack.includes(comment.path.toLowerCase()) ||
    haystack.includes('"line"') ||
    haystack.includes('"start_line"')
  );
}

function failure(error: ReviewPostErrorCode, message: string): ReviewPostFailure {
  return { ok: false, error, message };
}

function buildApiComment(entry: PullReviewInlineInput, body: string): ReviewApiComment {
  const comment: ReviewApiComment = {
    path: entry.path,
    line: entry.line,
    side: "RIGHT",
    body,
  };
  if (entry.start_line !== undefined && entry.start_line < entry.line) {
    comment.start_line = entry.start_line;
    comment.start_side = "RIGHT";
  }
  return comment;
}

export function formatAnchoredNote(path: string, line: number, body: string): string {
  return `${path}:${line}: ${body}`;
}

const defaultSleep: SleepFn = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export function assertCommentEvent(event: string): asserts event is ReviewCommentEvent {
  if (event !== "COMMENT") {
    throw new Error(`Unsupported review event "${event}": only COMMENT is allowed.`);
  }
}

export async function postPullReview(
  input: PostPullReviewInput,
  deps: PostPullReviewDeps,
): Promise<PostPullReviewResult> {
  const event = input.event ?? "COMMENT";
  if (event !== "COMMENT") {
    return failure(
      "invalid_event",
      `Unsupported review event "${event}": only COMMENT is allowed.`,
    );
  }
  for (const entry of input.inline) {
    if (entry.path === "" || !Number.isInteger(entry.line) || entry.line < 1) {
      return failure("invalid_comment", `Invalid inline comment anchor for "${entry.path}".`);
    }
    if (
      entry.start_line !== undefined &&
      (!Number.isInteger(entry.start_line) || entry.start_line < 1)
    ) {
      return failure("invalid_comment", `Invalid inline comment anchor for "${entry.path}".`);
    }
  }
  const sanitizeOptions: SanitizeCommentOptions = {
    ...deps.sanitizeOptions,
    owner: deps.sanitizeOptions?.owner ?? input.owner,
    repo: deps.sanitizeOptions?.repo ?? input.repo,
  };
  const summaryBody = sanitizeForPosting(input.body, sanitizeOptions);
  const comments = input.inline.map((entry) => {
    const marker = entry.fingerprints ? `\n${formatFingerprintComment(entry.fingerprints)}` : "";
    const body = sanitizeForPosting(entry.body, sanitizeOptions).slice(
      0,
      MAX_COMMENT_CHARS - marker.length,
    );
    return buildApiComment(entry, `${body}${marker}`);
  });
  const movedToSummary: MovedToSummaryNote[] = [];
  const sleep = deps.sleep ?? defaultSleep;
  let genericRetries = 0;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    try {
      await deps.createReview({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        commit_id: input.commitId,
        event: "COMMENT",
        body: summaryBody,
        comments,
      });
      return { ok: true, attempts, movedToSummary };
    } catch (error) {
      const status = errorStatus(error);
      const message = errorMessage(error);
      if (status !== 422) {
        return failure("review_failed", message === "" ? "Pull review request failed." : message);
      }
      const details = errorDetails(error);
      const anchorIndex = comments.findIndex((comment) => namesAnchor(message, details, comment));
      if (anchorIndex >= 0) {
        const [removed] = comments.splice(anchorIndex, 1);
        if (removed !== undefined) {
          movedToSummary.push({ path: removed.path, line: removed.line, body: removed.body });
        }
        continue;
      }
      if (isGeneric422(message) && genericRetries < GENERIC_RETRY_SLEEPS_MS.length) {
        const delay = GENERIC_RETRY_SLEEPS_MS[genericRetries] ?? 0;
        genericRetries += 1;
        await sleep(delay);
        continue;
      }
      const suffix =
        movedToSummary.length > 0
          ? ` Moved ${movedToSummary.length} comment(s) to the summary as general notes.`
          : "";
      return failure(
        "review_failed",
        `${message === "" ? "Pull review request failed." : message}${suffix}`,
      );
    }
  }
}
