import type { PullFileEntry, SkippedPlanFile } from "@anvia/hammer-core";
import { approxTokens, renderPromptFile } from "./prompt";

export type FitStage = "full" | "no-context" | "no-deletions" | "packed";

export interface FitResult {
  files: PullFileEntry[];
  contents: Record<string, string>;
  omitted: SkippedPlanFile[];
  stage: FitStage;
  tokens: number;
}

function splitHunks(patch: string): { head: string[]; hunks: string[][] } {
  const head: string[] = [];
  const hunks: string[][] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) hunks.push([line]);
    else if (hunks.length === 0) head.push(line);
    else hunks.at(-1)?.push(line);
  }
  return { head, hunks };
}

function hasAddition(hunk: string[]): boolean {
  return hunk.some((line, index) => index > 0 && line.startsWith("+") && !line.startsWith("+++"));
}

export function dropDeletionOnlyHunks(file: PullFileEntry): PullFileEntry | null {
  if (file.patch === undefined) return file;
  const { head, hunks } = splitHunks(file.patch);
  const kept = hunks.filter(hasAddition);
  if (kept.length === hunks.length) return file;
  if (kept.length === 0) return null;
  return { ...file, patch: [...head, ...kept.flat()].join("\n") };
}

function cost(file: PullFileEntry, contents: Record<string, string>): number {
  return approxTokens(renderPromptFile(file, contents)) + 2;
}

function total(files: PullFileEntry[], contents: Record<string, string>): number {
  return files.reduce((sum, file) => sum + cost(file, contents), 0);
}

export function fitDiff(
  files: PullFileEntry[],
  contents: Record<string, string>,
  maxTokens: number,
): FitResult {
  const result = (
    stage: FitStage,
    kept: PullFileEntry[],
    keptContents: Record<string, string>,
    omitted: SkippedPlanFile[],
  ): FitResult => ({
    files: kept,
    contents: keptContents,
    omitted,
    stage,
    tokens: total(kept, keptContents),
  });
  if (total(files, contents) <= maxTokens) return result("full", files, contents, []);
  if (total(files, {}) <= maxTokens) return result("no-context", files, {}, []);

  const omitted: SkippedPlanFile[] = [];
  const condensed: PullFileEntry[] = [];
  for (const file of files) {
    const slim = dropDeletionOnlyHunks(file);
    if (slim === null) {
      omitted.push({
        path: file.filename,
        reason: "deletion-only changes left out to fit the diff token budget",
      });
    } else {
      if (slim !== file)
        omitted.push({
          path: file.filename,
          reason: "deletion-only hunks left out to fit the diff token budget",
        });
      condensed.push(slim);
    }
  }
  if (total(condensed, {}) <= maxTokens) return result("no-deletions", condensed, {}, omitted);

  const packed: PullFileEntry[] = [];
  const dropped: SkippedPlanFile[] = [];
  let used = 0;
  for (const file of condensed) {
    const tokens = cost(file, {});
    if (used + tokens <= maxTokens) {
      packed.push(file);
      used += tokens;
    } else {
      dropped.push({
        path: file.filename,
        reason: `diff of ~${tokens} tokens does not fit the diff token budget (${maxTokens})`,
      });
    }
  }
  return result("packed", packed, {}, [
    ...omitted.filter((entry) => !dropped.some((file) => file.path === entry.path)),
    ...dropped,
  ]);
}
