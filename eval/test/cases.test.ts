import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CaseLoadError, loadCase, loadCases } from "../src/cases";

const CASES_ROOT = join(import.meta.dirname, "..", "cases");

function writeTmpCase(files: Record<string, string>): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "hammer-eval-"));
  const dir = join(root, "case-01");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return { root, dir };
}

describe("case loader", () => {
  it("rejects a case.json with missing fields", () => {
    const { root } = writeTmpCase({ "case.json": JSON.stringify({ id: "case-01" }) });
    expect(() => loadCase(root, "case-01")).toThrow(CaseLoadError);
  });

  it("rejects a case with a missing patch file", () => {
    const { root } = writeTmpCase({
      "case.json": JSON.stringify({
        id: "case-01",
        kind: "clean",
        title: "Clean",
        prBody: "ok",
        files: [{ path: "src/a.ts", status: "modified", patchFile: "missing.patch" }],
        expected: [],
      }),
    });
    expect(() => loadCase(root, "case-01")).toThrow(/patch file/);
  });

  it("loads the 31 shipped cases with 20/6/5 composition", () => {
    const cases = loadCases(CASES_ROOT);
    expect(cases).toHaveLength(31);
    expect(cases.filter((c) => c.kind === "seeded")).toHaveLength(20);
    expect(cases.filter((c) => c.kind === "clean")).toHaveLength(6);
    expect(cases.filter((c) => c.kind === "adversarial")).toHaveLength(5);
    for (const c of cases) {
      for (const file of c.files) {
        expect(c.patches.get(file.path)).toBeTypeOf("string");
      }
    }
  });
});
