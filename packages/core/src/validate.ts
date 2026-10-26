import type { Finding } from "./schema";
import type { Severity } from "./config";
import type { PullFileEntry } from "./github/files";
import { commentableLines, parsePatch } from "./github/patch";

export const MIN_FINDING_CONFIDENCE = 0.6;
export const DEFAULT_MAX_COMMENTS = 10;
export const DEFAULT_MIN_SEVERITY: Severity = "medium";

export type ValidateDropReason =
  | "below_min_severity"
  | "low_confidence"
  | "over_max_comments"
  | "not_in_diff"
  | "deleted_file"
  | "out_of_hunk"
  | "unknown_path";

export type GeneralNoteReason =
  | "over_max_comments"
  | "not_in_diff"
  | "deleted_file"
  | "out_of_hunk"
  | "unknown_path";

export interface ValidatedInlineComment {
  finding: Finding;
  startLine: number;
  line: number;
  suggestionKept: boolean;
}

export interface ValidatedSingleComment {
  finding: Finding;
  startLine: number;
  line: number;
  suggestionKept: boolean;
}

export interface ValidateGeneralNote {
  finding: Finding;
  reason: GeneralNoteReason;
}

export interface ValidateDropped {
  finding: Finding;
  reason: ValidateDropReason;
}

export interface ValidateFindingsOptions {
  min_severity?: Severity;
  max_comments?: number;
}

export interface ValidateFindingsResult {
  inline: ValidatedInlineComment[];
  single: ValidatedSingleComment[];
  generalNotes: ValidateGeneralNote[];
  dropped: ValidateDropped[];
}

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

interface FileAnchors {
  hunks: Array<Set<number>>;
  commentable: Set<number>;
  deleted: boolean;
}

function buildAnchors(file: PullFileEntry): FileAnchors {
  const hunks = parsePatch(file.patch ?? "");
  const sets = hunks.map((hunk) => {
    const set = new Set<number>();
    for (const line of hunk.lines) {
      if ((line.kind === "added" || line.kind === "context") && line.newLine !== null) {
        set.add(line.newLine);
      }
    }
    return set;
  });
  const commentable = commentableLines(hunks);
  const deleted = file.status === "removed" || (hunks.length > 0 && commentable.size === 0);
  return { hunks: sets, commentable, deleted };
}

function rangeInOneHunk(sets: Array<Set<number>>, start: number, end: number): boolean {
  return sets.some((set) => {
    for (let line = start; line <= end; line += 1) {
      if (!set.has(line)) return false;
    }
    return true;
  });
}

function rangeTouchesDiff(commentable: Set<number>, start: number, end: number): boolean {
  for (const line of commentable) {
    if (line >= start && line <= end) return true;
  }
  return false;
}

interface PlacedCandidate {
  finding: Finding;
  startLine: number;
  line: number;
  suggestionKept: boolean;
  single: boolean;
  rank: number;
  confidence: number;
}

export function validateFindings(
  findings: Finding[],
  files: PullFileEntry[],
  options: ValidateFindingsOptions = {},
): ValidateFindingsResult {
  const minRank = SEVERITY_RANK[options.min_severity ?? DEFAULT_MIN_SEVERITY];
  const maxComments = Math.max(0, Math.floor(options.max_comments ?? DEFAULT_MAX_COMMENTS));

  const anchors = new Map<string, FileAnchors>();
  for (const file of files) anchors.set(file.filename, buildAnchors(file));

  const inline: ValidatedInlineComment[] = [];
  const single: ValidatedSingleComment[] = [];
  const generalNotes: ValidateGeneralNote[] = [];
  const dropped: ValidateDropped[] = [];
  const candidates: PlacedCandidate[] = [];

  const note = (finding: Finding, reason: GeneralNoteReason): void => {
    generalNotes.push({ finding, reason });
    dropped.push({ finding, reason });
  };

  for (const finding of findings) {
    if (SEVERITY_RANK[finding.severity] < minRank) {
      dropped.push({ finding, reason: "below_min_severity" });
      continue;
    }
    if (finding.confidence < MIN_FINDING_CONFIDENCE) {
      dropped.push({ finding, reason: "low_confidence" });
      continue;
    }
    const entry = anchors.get(finding.path);
    if (entry === undefined) {
      note(finding, "unknown_path");
      continue;
    }
    if (entry.deleted) {
      note(finding, "deleted_file");
      continue;
    }
    const start =
      finding.startLine === undefined ? finding.line : Math.min(finding.startLine, finding.line);
    const end =
      finding.startLine === undefined ? finding.line : Math.max(finding.startLine, finding.line);
    if (rangeInOneHunk(entry.hunks, start, end)) {
      candidates.push({
        finding,
        startLine: start,
        line: end,
        suggestionKept: finding.suggestion !== undefined,
        single: false,
        rank: SEVERITY_RANK[finding.severity],
        confidence: finding.confidence,
      });
    } else if (entry.commentable.has(end)) {
      candidates.push({
        finding,
        startLine: end,
        line: end,
        suggestionKept: false,
        single: true,
        rank: SEVERITY_RANK[finding.severity],
        confidence: finding.confidence,
      });
    } else if (rangeTouchesDiff(entry.commentable, start, end)) {
      note(finding, "out_of_hunk");
    } else {
      note(finding, "not_in_diff");
    }
  }

  const ranked = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (left, right) =>
        right.candidate.rank - left.candidate.rank ||
        right.candidate.confidence - left.candidate.confidence ||
        left.index - right.index,
    )
    .map((rankedCandidate) => rankedCandidate.candidate);

  for (const candidate of ranked.slice(0, maxComments)) {
    if (candidate.single) {
      single.push({
        finding: candidate.finding,
        startLine: candidate.startLine,
        line: candidate.line,
        suggestionKept: candidate.suggestionKept,
      });
    } else {
      inline.push({
        finding: candidate.finding,
        startLine: candidate.startLine,
        line: candidate.line,
        suggestionKept: candidate.suggestionKept,
      });
    }
  }
  for (const candidate of ranked.slice(maxComments)) {
    note(candidate.finding, "over_max_comments");
  }

  return { inline, single, generalNotes, dropped };
}
