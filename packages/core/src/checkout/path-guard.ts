import { promises as fs } from "node:fs";
import path from "node:path";

export const MAX_READABLE_FILE_BYTES = 1024 * 1024;

export type PathGuardReason =
  | "outside_root"
  | "symlink_escape"
  | "denylisted"
  | "too_large"
  | "not_found";

export type PathGuardResult = { ok: true; path: string } | { ok: false; reason: PathGuardReason };

export function isDenylistedBasename(base: string): boolean {
  return (
    base.startsWith(".env") ||
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    base.startsWith("id_rsa")
  );
}

function hasGitSegment(relativePath: string): boolean {
  return relativePath.split(path.sep).includes(".git");
}

function escapesRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${path.sep}`);
}

export async function resolveInsideRoot(root: string, relPath: string): Promise<PathGuardResult> {
  if (path.isAbsolute(relPath)) return { ok: false, reason: "outside_root" };
  const absRoot = path.resolve(root);
  const candidate = path.resolve(absRoot, relPath);
  if (escapesRoot(path.relative(absRoot, candidate))) return { ok: false, reason: "outside_root" };
  let realRoot: string;
  try {
    realRoot = await fs.realpath(absRoot);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  let realCandidate: string;
  try {
    realCandidate = await fs.realpath(candidate);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  const realRelative = path.relative(realRoot, realCandidate);
  if (escapesRoot(realRelative) || path.isAbsolute(realRelative)) {
    return { ok: false, reason: "symlink_escape" };
  }
  if (hasGitSegment(path.relative(absRoot, candidate)) || hasGitSegment(realRelative)) {
    return { ok: false, reason: "denylisted" };
  }
  if (
    isDenylistedBasename(path.basename(candidate)) ||
    isDenylistedBasename(path.basename(realCandidate))
  ) {
    return { ok: false, reason: "denylisted" };
  }
  let size: number;
  try {
    const stat = await fs.stat(realCandidate);
    if (stat.isDirectory()) return { ok: true, path: realCandidate };
    size = stat.size;
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (size > MAX_READABLE_FILE_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true, path: realCandidate };
}
