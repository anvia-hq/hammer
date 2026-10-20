export function fixturePatch(before: string, after: string) {
  const oldLines = before.trimEnd() === "" ? [] : before.trimEnd().split("\n");
  const newLines = after.trimEnd() === "" ? [] : after.trimEnd().split("\n");
  let prefix = 0;
  while (
    prefix < Math.min(oldLines.length, newLines.length) &&
    oldLines[prefix] === newLines[prefix]
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < Math.min(oldLines.length, newLines.length) - prefix &&
    oldLines.at(-1 - suffix) === newLines.at(-1 - suffix)
  )
    suffix += 1;
  const changed = newLines.length - prefix - suffix;
  return {
    startLine: prefix + 1,
    endLine: Math.max(prefix + 1, prefix + changed),
    patch: [
      `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
      ...oldLines.slice(0, prefix).map((line) => ` ${line}`),
      ...oldLines.slice(prefix, oldLines.length - suffix).map((line) => `-${line}`),
      ...newLines.slice(prefix, newLines.length - suffix).map((line) => `+${line}`),
      ...newLines.slice(newLines.length - suffix).map((line) => ` ${line}`),
    ].join("\n"),
  };
}
