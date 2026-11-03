import { createHash } from "node:crypto";

export interface FindingFingerprints {
  bodyFp: string;
  suggestionFp: string;
}

export interface DedupeFinding {
  path: string;
  body: string;
  suggestion?: string | undefined;
}

export interface PriorFinding {
  path: string;
  line: number;
  title: string;
  body: string;
}

export const MAX_PRIOR_FINDINGS_CHARS = 16000;
const PRIOR_BODY_SNIPPET_CHARS = 500;

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fingerprints(
  path: string,
  body: string,
  suggestion?: string | undefined,
): FindingFingerprints {
  const bodyFp = sha256Hex(`${path}\n${normalize(body)}`);
  const suggestionFp = sha256Hex(
    `${path}\n${suggestion === undefined ? "" : normalize(suggestion)}`,
  );
  return { bodyFp, suggestionFp };
}

export function formatFingerprintComment(fp: FindingFingerprints): string {
  return `<!-- hammer:fp=${fp.bodyFp},${fp.suggestionFp} -->`;
}

const FINGERPRINT_MARKER_RE = /<!--\s*hammer:fp=([0-9a-fA-F]{64}),([0-9a-fA-F]{64})\s*-->/g;

export function parsePriorFingerprints(commentBodies: string[]): Set<string> {
  const found = new Set<string>();
  for (const body of commentBodies) {
    for (const match of body.matchAll(FINGERPRINT_MARKER_RE)) {
      const bodyFp = match[1];
      const suggestionFp = match[2];
      if (bodyFp !== undefined) found.add(bodyFp.toLowerCase());
      if (suggestionFp !== undefined) found.add(suggestionFp.toLowerCase());
    }
  }
  return found;
}

export function isDuplicate(finding: DedupeFinding, priorSet: Set<string>): boolean {
  const fp = fingerprints(finding.path, finding.body, finding.suggestion);
  return (
    priorSet.has(fp.bodyFp) || (finding.suggestion !== undefined && priorSet.has(fp.suggestionFp))
  );
}

export function filterDuplicates<T extends DedupeFinding>(
  findings: T[],
  priorSet: Set<string>,
): { kept: T[]; duplicates: T[] } {
  const kept: T[] = [];
  const duplicates: T[] = [];
  for (const finding of findings) {
    if (isDuplicate(finding, priorSet)) {
      duplicates.push(finding);
    } else {
      kept.push(finding);
    }
  }
  return { kept, duplicates };
}

function renderFindingLines(
  priorFindings: PriorFinding[],
  lines: string[],
  maxChars: number,
  focusPaths: ReadonlySet<string>,
): string {
  const ordered = [
    ...priorFindings.filter((prior) => focusPaths.has(prior.path)),
    ...priorFindings.filter((prior) => !focusPaths.has(prior.path)),
  ];
  const kept = [...lines];
  let length = kept.join("\n").length + 1;
  let omitted = 0;
  for (const prior of ordered) {
    const snippet =
      prior.body.length > PRIOR_BODY_SNIPPET_CHARS
        ? `${prior.body.slice(0, PRIOR_BODY_SNIPPET_CHARS)}…`
        : prior.body;
    const line = `- ${prior.path}:${prior.line} — ${prior.title}: ${snippet}`;
    if (length + line.length + 1 > maxChars) {
      omitted += 1;
      continue;
    }
    kept.push(line);
    length += line.length + 1;
  }
  if (omitted > 0) kept.push(`- ${omitted} more earlier findings omitted to save space.`);
  const full = `${kept.join("\n")}\n`;
  return full.length > maxChars ? full.slice(0, maxChars) : full;
}

export function buildResolvedFindingsContext(
  resolvedFindings: PriorFinding[],
  maxChars: number = MAX_PRIOR_FINDINGS_CHARS,
  focusPaths: ReadonlySet<string> = new Set(),
): string {
  return renderFindingLines(
    resolvedFindings,
    [
      "Findings from earlier Hammer reviews that a person marked resolved. Do not raise them again, reworded or not, unless the current code reintroduces the problem:",
    ],
    maxChars,
    focusPaths,
  );
}

export function buildPriorFindingsContext(
  priorFindings: PriorFinding[],
  maxChars: number = MAX_PRIOR_FINDINGS_CHARS,
  focusPaths: ReadonlySet<string> = new Set(),
): string {
  const lines = [
    "Previously posted open Hammer findings. If a finding below is still valid, restate it word for word instead of posting a reworded duplicate:",
  ];
  return renderFindingLines(priorFindings, lines, maxChars, focusPaths);
}
