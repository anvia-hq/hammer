import { promises as fs } from "node:fs";
import path from "node:path";

import {
  MAX_READABLE_FILE_BYTES,
  parsePatch,
  resolveInsideRoot,
  type PullFileEntry,
} from "@anvia/hammer-core";
import { collectFiles } from "./tools";

export interface LeadLimits {
  maxCandidates: number;
  maxRefsPerCandidate: number;
  maxChars: number;
  timeBudgetMs: number;
  maxScannedFiles: number;
}

export const DEFAULT_LEAD_LIMITS: LeadLimits = {
  maxCandidates: 24,
  maxRefsPerCandidate: 6,
  maxChars: 16_384,
  timeBudgetMs: 3000,
  maxScannedFiles: 4000,
};

const DECLARATION =
  /\b(?:function\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|record)\s+([A-Za-z_$][\w$]*)/;
const METHOD =
  /^\s*(?:export\s+)?(?:(?:public|private|protected|static|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/;
const NOISE = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "constructor",
  "main",
  "index",
  "test",
  "describe",
  "default",
  "value",
  "values",
  "data",
  "result",
  "error",
  "options",
  "input",
  "output",
  "name",
  "path",
  "type",
  "item",
  "items",
  "args",
  "props",
  "state",
  "config",
  "string",
  "number",
  "boolean",
  "undefined",
  "null",
  "true",
  "false",
]);

export function extractCandidates(files: PullFileEntry[], limit: number): string[] {
  const removed = new Map<string, number>();
  const added = new Map<string, number>();
  for (const file of files) {
    if (file.patch === undefined) continue;
    for (const hunk of parsePatch(file.patch)) {
      for (const line of hunk.lines) {
        if (line.kind === "context") continue;
        const name = (DECLARATION.exec(line.text) ?? METHOD.exec(line.text))?.[1];
        if (name === undefined || name.length < 4 || NOISE.has(name.toLowerCase())) continue;
        const bucket = line.kind === "removed" ? removed : added;
        bucket.set(name, (bucket.get(name) ?? 0) + 1);
      }
    }
  }
  const ordered: string[] = [];
  for (const name of removed.keys()) if (!ordered.includes(name)) ordered.push(name);
  for (const name of added.keys()) if (!ordered.includes(name)) ordered.push(name);
  return ordered.slice(0, limit);
}

interface Reference {
  path: string;
  line: number;
  text: string;
}

export async function findChangeLeads(
  files: PullFileEntry[],
  checkoutRoot: string,
  limits: Partial<LeadLimits> = {},
): Promise<string> {
  const bounds = { ...DEFAULT_LEAD_LIMITS, ...limits };
  const candidates = extractCandidates(files, bounds.maxCandidates);
  if (candidates.length === 0 || checkoutRoot === "") return "";
  const wanted = new Set(candidates);
  const changed = new Set(files.map((file) => file.filename));
  const refs = new Map<string, Reference[]>(candidates.map((name) => [name, []]));
  const deadline = Date.now() + bounds.timeBudgetMs;
  let complete = true;
  try {
    const root = await fs.realpath(path.resolve(checkoutRoot));
    const all: string[] = [];
    await collectFiles(root, all);
    all.sort();
    let scanned = 0;
    for (const absolute of all) {
      if (Date.now() > deadline || scanned >= bounds.maxScannedFiles) {
        complete = false;
        break;
      }
      const rel = path.relative(root, absolute).split(path.sep).join("/");
      if (changed.has(rel) || rel.split("/").includes(".git")) continue;
      const guard = await resolveInsideRoot(root, rel);
      if (!guard.ok) continue;
      let buffer: Buffer;
      try {
        const stat = await fs.stat(guard.path);
        if (!stat.isFile() || stat.size > MAX_READABLE_FILE_BYTES) continue;
        buffer = await fs.readFile(guard.path);
      } catch {
        continue;
      }
      if (buffer.includes(0)) continue;
      scanned += 1;
      const lines = buffer.toString("utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        for (const word of line.match(/[A-Za-z_$][\w$]*/g) ?? []) {
          if (!wanted.has(word)) continue;
          const list = refs.get(word);
          if (list === undefined || list.length >= bounds.maxRefsPerCandidate) continue;
          if (list.some((entry) => entry.path === rel && entry.line === index + 1)) continue;
          list.push({ path: rel, line: index + 1, text: line.trim().slice(0, 140) });
        }
      }
    }
  } catch {
    return "";
  }
  const out: string[] = [];
  let size = 0;
  let cut = false;
  for (const name of candidates) {
    const list = refs.get(name) ?? [];
    if (list.length === 0) continue;
    const block = [
      `- \`${name}\``,
      ...list.map((entry) => `  - ${entry.path}:${entry.line}: ${entry.text}`),
    ].join("\n");
    if (size + block.length > bounds.maxChars) {
      cut = true;
      break;
    }
    out.push(block);
    size += block.length + 1;
  }
  if (out.length === 0) return "";
  const note =
    cut || !complete
      ? "The list was cut short by its size or time limit."
      : `At most ${bounds.maxRefsPerCandidate} references per name are shown.`;
  return [
    "Names declared or removed in this PR, with references found outside the changed files by a bounded text search. These are leads, not a complete list: verify with search and read_file before reporting, and look for callers the search missed.",
    note,
    ...out,
  ].join("\n");
}
