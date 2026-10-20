import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixturePatch } from "./fixture-patch";
import { SEEDED } from "./seeded-definitions";
import { OTHER_CASES } from "./other-definitions";

const root = join(import.meta.dirname, "..", "cases");
function writeCase(id: string, metadata: unknown, patches: Record<string, string>) {
  const directory = join(root, id);
  mkdirSync(directory, { recursive: true });
  for (const name of readdirSync(directory)) {
    if (name.endsWith(".patch") && !(name in patches)) rmSync(join(directory, name));
  }
  writeFileSync(join(directory, "case.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  for (const [name, patch] of Object.entries(patches))
    writeFileSync(join(directory, name), `${patch}\n`);
}
for (const definition of SEEDED) {
  const diff = fixturePatch(definition.before, definition.after);
  writeCase(
    definition.id,
    {
      id: definition.id,
      kind: "seeded",
      title: definition.title,
      prBody: definition.contract,
      files: [{ path: definition.file, status: "modified", patchFile: "changes.patch" }],
      expected: [
        {
          path: definition.file,
          startLine: diff.startLine,
          endLine: diff.endLine,
          category: definition.category,
          severity: definition.severity,
        },
      ],
    },
    { "changes.patch": diff.patch },
  );
}
for (const definition of OTHER_CASES) {
  const patches: Record<string, string> = {};
  const files = definition.files.map((file, index) => {
    const patchFile = `file-${index + 1}.patch`;
    patches[patchFile] = fixturePatch(file.before, file.after).patch;
    return { path: file.path, status: file.before === "" ? "added" : "modified", patchFile };
  });
  writeCase(definition.id, { ...definition, files, expected: [] }, patches);
}
console.log(`wrote ${SEEDED.length + OTHER_CASES.length} cases`);
