import { DEFAULT_CAPS } from "./config";
import type { PullFileEntry } from "./github/files";

export interface PlanOptions {
  ignore?: string[];
  include?: string[];
  maxFiles?: number;
  maxDiffLines?: number;
}

export interface SkippedPlanFile {
  path: string;
  reason: string;
}

export interface ReviewPlan {
  reviewFiles: PullFileEntry[];
  skippedFiles: SkippedPlanFile[];
  notReviewed: SkippedPlanFile[];
  totalDiffLines: number;
  partial: boolean;
}

// Minimal glob dialect: `*` matches any run of characters except `/`, `**`
// matches any run including `/`, and `**/` also matches zero directories so
// `docs/**` covers `docs/a/b` and `**/*.ts` covers `foo.ts`. Every other
// character matches literally. A pattern without a `/` is also tried against
// the basename, so `*.snap` matches snapshots in any directory.
export function matchesGlob(pattern: string, path: string): boolean {
  if (pattern === "") return false;
  const full = globToRegExp(pattern);
  if (full.test(path)) return true;
  if (!pattern.includes("/")) {
    return full.test(basename(path));
  }
  return false;
}

function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] !== "*") {
      out += escapeRegExpChar(pattern[i] ?? "");
      i += 1;
      continue;
    }
    let end = i;
    while (pattern[end] === "*") end += 1;
    if (end - i >= 2 && pattern[end] === "/") {
      out += "(?:.*/)?";
      i = end + 1;
    } else if (end - i >= 2) {
      out += ".*";
      i = end;
    } else {
      out += "[^/]*";
      i = end;
    }
  }
  return new RegExp(`^${out}$`);
}

function escapeRegExpChar(char: string): string {
  return char.replace(/[.+^${}()|[\]\\?]/, "\\$&");
}

const LOCKFILE_BASENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "pipfile.lock",
  "podfile.lock",
  "pubspec.lock",
  "uv.lock",
  "deno.lock",
  "mix.lock",
  "packages.lock.json",
  "go.sum",
  "go.work.sum",
]);

const BUILD_DIR_NAMES = new Set(["dist", "build", "vendor"]);

const TEST_DIR_NAMES = new Set(["test", "tests", "spec", "__tests__"]);

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function isLockfile(path: string): boolean {
  const lower = basename(path).toLowerCase();
  return LOCKFILE_BASENAMES.has(lower) || lower.endsWith(".lock");
}

function buildDirName(path: string): string | undefined {
  for (const segment of path.split("/")) {
    if (BUILD_DIR_NAMES.has(segment)) return segment;
  }
  return undefined;
}

export function isTestPath(path: string): boolean {
  const base = basename(path).toLowerCase();
  if (base.includes(".test.") || base.includes(".spec.")) return true;
  return path.split("/").some((segment) => TEST_DIR_NAMES.has(segment.toLowerCase()));
}

function filterReason(
  file: PullFileEntry,
  ignore: string[],
  include: string[],
): string | undefined {
  if (file.patch === undefined) return "binary";
  if (file.patch.toLowerCase().includes("@generated")) return "generated";
  if (isLockfile(file.filename)) return "ignored by default: lockfile";
  const dir = buildDirName(file.filename);
  if (dir !== undefined) return `ignored by default: ${dir}/`;
  const base = basename(file.filename);
  if (base.includes(".min.")) return "ignored by default: minified";
  if (base.endsWith(".snap")) return "ignored by default: snapshot";
  for (const glob of ignore) {
    if (matchesGlob(glob, file.filename)) return `user ignore: ${glob}`;
  }
  if (include.length > 0 && !include.some((glob) => matchesGlob(glob, file.filename))) {
    return "not in include list";
  }
  return undefined;
}

function diffLines(file: PullFileEntry): number {
  return file.additions + file.deletions;
}

export function buildReviewPlan(files: PullFileEntry[], options: PlanOptions = {}): ReviewPlan {
  const ignore = options.ignore ?? [];
  const include = options.include ?? [];
  const maxFiles = Math.max(0, Math.floor(options.maxFiles ?? DEFAULT_CAPS.max_files));
  const maxDiffLines = Math.max(0, Math.floor(options.maxDiffLines ?? DEFAULT_CAPS.max_diff_lines));

  const skippedFiles: SkippedPlanFile[] = [];
  const candidates: PullFileEntry[] = [];
  for (const file of files) {
    const reason = filterReason(file, ignore, include);
    if (reason === undefined) {
      candidates.push(file);
    } else {
      skippedFiles.push({ path: file.filename, reason });
    }
  }

  const ranked = candidates
    .map((file, index) => ({ file, index }))
    .sort((a, b) => {
      const testRank = Number(isTestPath(a.file.filename)) - Number(isTestPath(b.file.filename));
      if (testRank !== 0) return testRank;
      const sizeRank = diffLines(b.file) - diffLines(a.file);
      if (sizeRank !== 0) return sizeRank;
      return a.index - b.index;
    })
    .map((rankedFile) => rankedFile.file);

  const reviewFiles: PullFileEntry[] = [];
  const notReviewed: SkippedPlanFile[] = [];
  let totalDiffLines = 0;
  for (const file of ranked) {
    const lines = diffLines(file);
    if (reviewFiles.length >= maxFiles) {
      notReviewed.push({ path: file.filename, reason: "over max_files" });
    } else if (totalDiffLines + lines > maxDiffLines) {
      notReviewed.push({ path: file.filename, reason: "over max_diff_lines" });
    } else {
      reviewFiles.push(file);
      totalDiffLines += lines;
    }
  }

  return {
    reviewFiles,
    skippedFiles,
    notReviewed,
    totalDiffLines,
    partial: notReviewed.length > 0,
  };
}
