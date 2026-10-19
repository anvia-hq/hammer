export interface PatchLine {
  kind: "added" | "context" | "removed";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: PatchLine[];
}

export type IncrementalScope = { mode: "full" };

export interface ReviewScopeOptions {
  lastSha?: string | null | undefined;
}

export function decideReviewScope(options: ReviewScopeOptions): IncrementalScope {
  if (options.lastSha === undefined || options.lastSha === null || options.lastSha === "") {
    return { mode: "full" };
  }
  return { mode: "full" };
}

export function extractLastSha(body: string): string | undefined {
  const match = /<!--\s*hammer:last-sha=([0-9a-fA-F]{4,64})\s*-->/.exec(body);
  if (match === null) return undefined;
  return match[1];
}

function parseHunkHeader(line: string): Omit<PatchHunk, "lines"> | null {
  const match = /^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/.exec(line);
  if (match === null) return null;
  const oldStart = Number(match[1]);
  const oldLines = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newLines = match[4] === undefined ? 1 : Number(match[4]);
  if (!Number.isInteger(oldStart) || !Number.isInteger(newStart)) return null;
  return { oldStart, oldLines, newStart, newLines };
}

export function parsePatch(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("@@")) {
      const header = parseHunkHeader(line);
      if (header === null) continue;
      current = { ...header, lines: [] };
      hunks.push(current);
      oldLine = header.oldStart;
      newLine = header.newStart;
      continue;
    }
    if (current === null) continue;
    if (line === "\\ No newline at end of file") continue;
    if (line.startsWith("+")) {
      current.lines.push({ kind: "added", text: line.slice(1), oldLine: null, newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      current.lines.push({ kind: "removed", text: line.slice(1), oldLine, newLine: null });
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      current.lines.push({ kind: "context", text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (line === "") {
      current.lines.push({ kind: "context", text: "", oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return hunks;
}

export function commentableLines(hunks: PatchHunk[]): Set<number> {
  const lines = new Set<number>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "added" || line.kind === "context") {
        if (line.newLine !== null) lines.add(line.newLine);
      }
    }
  }
  return lines;
}
