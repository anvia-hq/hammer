import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CORE_SRC = new URL("../../src/", import.meta.url);
const ACTION_SRC = new URL("../../../action/src/", import.meta.url);
const REPO = new URL("../../../../", import.meta.url);

function tsFiles(dir: URL): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir.pathname, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(new URL(`file://${full}/`)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("S9 no telemetry", () => {
  it("core and action src make no fetch or http calls to other hosts", () => {
    const bad: string[] = [];
    for (const file of [...tsFiles(CORE_SRC), ...tsFiles(ACTION_SRC)]) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (/\bfetch\s*\(/.test(line)) bad.push(`${file}:${i + 1}: ${line.trim()}`);
        if (/(node:https?|axios|XMLHttpRequest|undici)/.test(line)) bad.push(`${file}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it("README states code goes only to the configured model provider", () => {
    const readme = readFileSync(new URL("README.md", REPO), "utf8");
    expect(readme).toMatch(/only.*model provider|model provider.*only/i);
  });
});
