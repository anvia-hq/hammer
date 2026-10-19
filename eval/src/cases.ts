import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type EvalCategory =
  | "correctness"
  | "security"
  | "performance"
  | "reliability"
  | "maintainability"
  | "tests"
  | "rule";

export type EvalSeverity = "high" | "medium" | "low";

export interface ExpectedFinding {
  path: string;
  startLine: number;
  endLine: number;
  category: EvalCategory;
  severity: EvalSeverity;
}

export type EvalCaseKind = "seeded" | "clean" | "adversarial";

export type AdversarialKind =
  | "pr-body-injection"
  | "code-comment-injection"
  | "filename-injection"
  | "symlink-escape"
  | "huge-generated";

export interface CaseFile {
  path: string;
  status: "added" | "modified" | "removed";
  patchFile: string;
}

export interface EvalCase {
  id: string;
  kind: EvalCaseKind;
  title: string;
  prBody: string;
  files: CaseFile[];
  expected: ExpectedFinding[];
  adversarial?: AdversarialKind | undefined;
  injectedText?: string | undefined;
  patches: Map<string, string>;
}

export class CaseLoadError extends Error {
  readonly caseDir: string;
  constructor(caseDir: string, message: string) {
    super(`invalid eval case ${caseDir}: ${message}`);
    this.name = "CaseLoadError";
    this.caseDir = caseDir;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(raw: Record<string, unknown>, field: string, caseDir: string): string {
  const value = raw[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new CaseLoadError(caseDir, `field ${field} must be a non-empty string`);
  }
  return value;
}

function parseExpected(raw: unknown, caseDir: string): ExpectedFinding[] {
  if (!Array.isArray(raw)) throw new CaseLoadError(caseDir, "field expected must be an array");
  return raw.map((entry, index) => {
    if (!isRecord(entry)) throw new CaseLoadError(caseDir, `expected[${index}] must be an object`);
    for (const field of ["path", "category", "severity"]) {
      if (typeof entry[field] !== "string" || (entry[field] as string).length === 0) {
        throw new CaseLoadError(caseDir, `expected[${index}].${field} must be a non-empty string`);
      }
    }
    for (const field of ["startLine", "endLine"]) {
      if (!Number.isInteger(entry[field]) || (entry[field] as number) <= 0) {
        throw new CaseLoadError(caseDir, `expected[${index}].${field} must be a positive integer`);
      }
    }
    const startLine = entry["startLine"] as number;
    const endLine = entry["endLine"] as number;
    if (startLine > endLine) {
      throw new CaseLoadError(caseDir, `expected[${index}].startLine must be <= endLine`);
    }
    return {
      path: entry["path"] as string,
      startLine,
      endLine,
      category: entry["category"] as EvalCategory,
      severity: entry["severity"] as EvalSeverity,
    };
  });
}

export function loadCase(casesRoot: string, caseDir: string): EvalCase {
  const dir = join(casesRoot, caseDir);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as unknown;
  } catch {
    throw new CaseLoadError(caseDir, "case.json is missing or is not valid JSON");
  }
  if (!isRecord(raw)) throw new CaseLoadError(caseDir, "case.json must be an object");
  const id = requiredString(raw, "id", caseDir);
  const kind = requiredString(raw, "kind", caseDir);
  if (kind !== "seeded" && kind !== "clean" && kind !== "adversarial") {
    throw new CaseLoadError(caseDir, "field kind must be seeded, clean or adversarial");
  }
  const title = requiredString(raw, "title", caseDir);
  if (typeof raw["prBody"] !== "string") {
    throw new CaseLoadError(caseDir, "field prBody must be a string");
  }
  if (!Array.isArray(raw["files"]) || raw["files"].length === 0) {
    throw new CaseLoadError(caseDir, "field files must be a non-empty array");
  }
  const files: CaseFile[] = raw["files"].map((entry: unknown, index: number) => {
    if (!isRecord(entry)) throw new CaseLoadError(caseDir, `files[${index}] must be an object`);
    const path = requiredString(entry, "path", caseDir);
    const status = requiredString(entry, "status", caseDir);
    if (status !== "added" && status !== "modified" && status !== "removed") {
      throw new CaseLoadError(caseDir, `files[${index}].status must be added, modified or removed`);
    }
    const patchFile = requiredString(entry, "patchFile", caseDir);
    return { path, status: status as CaseFile["status"], patchFile };
  });
  const expected = parseExpected(raw["expected"], caseDir);
  if (kind === "seeded" && expected.length === 0) {
    throw new CaseLoadError(caseDir, "seeded cases must list at least one expected finding");
  }
  if (kind === "clean" && expected.length !== 0) {
    throw new CaseLoadError(caseDir, "clean cases must have an empty expected list");
  }
  let adversarial: AdversarialKind | undefined;
  let injectedText: string | undefined;
  if (kind === "adversarial") {
    if (typeof raw["adversarial"] !== "string" || raw["adversarial"].length === 0) {
      throw new CaseLoadError(caseDir, "adversarial cases must name an adversarial kind");
    }
    adversarial = raw["adversarial"] as AdversarialKind;
    if (typeof raw["injectedText"] !== "string" || raw["injectedText"].length === 0) {
      throw new CaseLoadError(caseDir, "adversarial cases must include injectedText");
    }
    injectedText = raw["injectedText"] as string;
    if (expected.length !== 0) {
      throw new CaseLoadError(caseDir, "adversarial cases must have an empty expected list");
    }
  }
  const patches = new Map<string, string>();
  for (const file of files) {
    try {
      patches.set(file.path, readFileSync(join(dir, file.patchFile), "utf8"));
    } catch {
      throw new CaseLoadError(caseDir, `patch file ${file.patchFile} is missing`);
    }
  }
  return {
    id,
    kind,
    title,
    prBody: raw["prBody"] as string,
    files,
    expected,
    adversarial,
    injectedText,
    patches,
  };
}

export function loadCases(casesRoot: string): EvalCase[] {
  const dirs = readdirSync(casesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (dirs.length === 0) throw new CaseLoadError("(root)", "no case directories found");
  return dirs.map((dir) => loadCase(casesRoot, dir));
}
