import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PullFileEntry } from "@anvia/hammer-core";
import { extractCandidates, findChangeLeads } from "../src/leads";

function file(name: string, patch: string): PullFileEntry {
  return {
    filename: name,
    sha: "x",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch,
  };
}

const changed = file(
  "src/api.ts",
  [
    "@@ -1,3 +1,3 @@",
    "-export function fetchUser(id: string) {",
    "+export function loadUser(id: string, force: boolean) {",
    " return 1;",
    "+const data = 1;",
  ].join("\n"),
);

async function checkout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "leads-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules/dep"), { recursive: true });
  await writeFile(join(root, "src/api.ts"), "export function loadUser() {}\n");
  await writeFile(
    join(root, "src/caller.ts"),
    "import { fetchUser } from './api';\nfetchUser('1');\n",
  );
  await writeFile(join(root, "node_modules/dep/index.js"), "fetchUser();\n");
  return root;
}

describe("extractCandidates", () => {
  it("lists removed declarations first, skips noise and short names", () => {
    expect(extractCandidates([changed], 10)).toEqual(["fetchUser", "loadUser"]);
  });

  it("respects the candidate limit", () => {
    expect(extractCandidates([changed], 1)).toEqual(["fetchUser"]);
  });
});

describe("findChangeLeads", () => {
  it("finds references outside the changed files and node_modules", async () => {
    const root = await checkout();
    const leads = await findChangeLeads([changed], root);
    expect(leads).toContain("`fetchUser`");
    expect(leads).toContain("src/caller.ts:1");
    expect(leads).toContain("src/caller.ts:2");
    expect(leads).not.toContain("node_modules");
    expect(leads).not.toContain("src/api.ts:");
    expect(leads).toContain("leads, not a complete list");
  });

  it("limits references per name and total size", async () => {
    const root = await checkout();
    const limited = await findChangeLeads([changed], root, { maxRefsPerCandidate: 1 });
    expect(limited.match(/src\/caller\.ts/g)).toHaveLength(1);
    const tiny = await findChangeLeads([changed], root, { maxChars: 10 });
    expect(tiny).toBe("");
  });

  it("returns nothing when there is no checkout or no candidates", async () => {
    expect(await findChangeLeads([changed], "")).toBe("");
    expect(await findChangeLeads([file("a.ts", "@@ -1 +1 @@\n-x\n+y")], await checkout())).toBe("");
    expect(await findChangeLeads([changed], "/nonexistent/path/xyz")).toBe("");
  });
});
