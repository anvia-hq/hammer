import type { PullFileEntry } from "@anvia/hammer-core";
import { renderPromptFile, untrusted } from "./prompt";

export const DIFF_PAGE_LINES = 400;

export interface DiffTocEntry {
  filename: string;
  status: PullFileEntry["status"];
  additions: number;
  deletions: number;
  startLine: number;
  endLine: number;
}

export interface PrMeta {
  title: string;
  baseRef?: string | undefined;
  headRef?: string | undefined;
  headSha?: string | undefined;
}

export interface PrDiff {
  totalLines: number;
  toc: DiffTocEntry[];
  read(startLine?: number, endLine?: number): string;
  coverage(): number;
}

export function buildPrDiff(files: PullFileEntry[], contents?: Record<string, string>): PrDiff {
  const lines: string[] = [];
  const toc: DiffTocEntry[] = [];
  for (const file of files) {
    const rendered = renderPromptFile(file, contents).split("\n");
    toc.push({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      startLine: lines.length + 1,
      endLine: lines.length + rendered.length,
    });
    lines.push(...rendered);
  }
  const seen = new Set<number>();
  return {
    totalLines: lines.length,
    toc,
    read(startLine = 1, endLine) {
      const start = Math.max(1, Math.floor(startLine));
      const last = Math.min(
        lines.length,
        Math.floor(endLine ?? lines.length),
        start + DIFF_PAGE_LINES - 1,
      );
      if (lines.length === 0) return untrusted("(no files in scope)");
      if (start > lines.length) return `Diff has ${lines.length} lines; ${start} is past the end.`;
      let fresh = false;
      for (let line = start; line <= last; line += 1) {
        if (!seen.has(line)) fresh = true;
        seen.add(line);
      }
      if (!fresh) {
        return `Diff lines ${start}-${last} were already returned earlier in this review; use that output instead of reading them again.`;
      }
      const done = seen.size === lines.length;
      const next =
        last < lines.length
          ? `\n(diff lines ${start}-${last} of ${lines.length}; call read_diff with startLine ${last + 1} for the rest)`
          : `\n(diff lines ${start}-${last} of ${lines.length}; end of diff${done ? ". You have now read the whole diff. Do not read it again: investigate the surrounding code if needed, then reply with the JSON review" : ""})`;
      return untrusted(lines.slice(start - 1, last).join("\n")) + next;
    },
    coverage() {
      return lines.length === 0 ? 1 : seen.size / lines.length;
    },
  };
}

export function renderCheckout(meta: PrMeta, diff: PrDiff): string {
  const header = [
    `PR title: ${meta.title.replace(/\s+/g, " ").trim()}`,
    ...(meta.baseRef ? [`Base: ${meta.baseRef}`] : []),
    ...(meta.headRef ? [`Head: ${meta.headRef}${meta.headSha ? ` @ ${meta.headSha}` : ""}`] : []),
  ];
  const toc = diff.toc.map(
    (entry) =>
      `- ${entry.filename} (${entry.status}, +${entry.additions} -${entry.deletions}): diff lines ${entry.startLine}-${entry.endLine}`,
  );
  return [
    untrusted(header.join("\n")),
    `Diff: ${diff.totalLines} lines in ${diff.toc.length} files. Read all of it with read_diff, using these ranges as a checklist.`,
    untrusted(toc.join("\n")),
  ].join("\n");
}
