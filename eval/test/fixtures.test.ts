import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parsePatch } from "@anvia/hammer-core";
import { SEEDED } from "../scripts/seeded-definitions";
import { OTHER_CASES } from "../scripts/other-definitions";
import { fixturePatch } from "../scripts/fixture-patch";
import { loadCases } from "../src/cases";

function compile(source: string) {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  expect(
    result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error),
  ).toEqual([]);
  return result.outputText;
}
function witness(source: string, test: string) {
  return runInNewContext(
    `${compile(source)}\n(async () => { ${test} })()`,
    { exports: {}, structuredClone },
    { timeout: 1000 },
  );
}

describe.each(SEEDED)("$id ground truth", (definition) => {
  it("passes its behavioral contract before the change and violates it afterward", async () => {
    expect(await witness(definition.before, definition.witness)).toBe(true);
    expect(await witness(definition.after, definition.witness)).toBe(false);
  });
  it("ships the complete before/after patch without exposing its labels", async () => {
    const directory = join(import.meta.dirname, "..", "cases", definition.id);
    const patch = await readFile(join(directory, "changes.patch"), "utf8");
    expect(patch.trimEnd()).toBe(fixturePatch(definition.before, definition.after).patch);
    const hunks = parsePatch(patch);
    const before =
      hunks
        .flatMap((hunk) =>
          hunk.lines.filter((line) => line.kind !== "added").map((line) => line.text),
        )
        .join("\n") + "\n";
    const after =
      hunks
        .flatMap((hunk) =>
          hunk.lines.filter((line) => line.kind !== "removed").map((line) => line.text),
        )
        .join("\n") + "\n";
    expect(before).toBe(definition.before);
    expect(after).toBe(definition.after);
    const metadata = JSON.parse(await readFile(join(directory, "case.json"), "utf8"));
    expect(metadata.title).not.toContain("Seeded");
    expect(metadata.prBody).toBe(definition.contract);
    expect(metadata.prBody).not.toContain(definition.witness);
    const diff = fixturePatch(definition.before, definition.after);
    expect(metadata.expected).toEqual([
      {
        path: definition.file,
        startLine: diff.startLine,
        endLine: diff.endLine,
        category: definition.category,
        severity: definition.severity,
      },
    ]);
    expect(metadata.files).toEqual([
      { path: definition.file, status: "modified", patchFile: "changes.patch" },
    ]);
  });
});

it("keeps all hunk counts correct and all clean/adversarial source files syntactically valid", () => {
  for (const c of loadCases(join(import.meta.dirname, "..", "cases"))) {
    for (const patch of c.patches.values())
      for (const hunk of parsePatch(patch)) {
        expect(hunk.lines.filter((line) => line.kind !== "added")).toHaveLength(hunk.oldLines);
        expect(hunk.lines.filter((line) => line.kind !== "removed")).toHaveLength(hunk.newLines);
      }
  }
  for (const c of OTHER_CASES)
    for (const file of c.files) {
      if (file.path.endsWith(".json")) {
        expect(() => JSON.parse(file.before)).not.toThrow();
        expect(() => JSON.parse(file.after)).not.toThrow();
      } else if (file.path.includes(".ts") || file.path.endsWith(".js")) {
        compile(file.before);
        compile(file.after);
      }
    }
});
