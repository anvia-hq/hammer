import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFile, search } from "../../src/agent/tools";
import { resolveInsideRoot } from "../../src/checkout/path-guard";
import { cleanup, symlinkEscapePair } from "../fixtures/adversarial/symlink";

let root = "";
let outside: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hammer-s4-"));
  await writeFile(path.join(root, "ok.ts"), "const a = 1;\n");
  await writeFile(path.join(root, ".env"), "SECRET=1\n");
  await writeFile(path.join(root, ".env.local"), "SECRET=1\n");
  await writeFile(path.join(root, "cert.pem"), "x\n");
  await writeFile(path.join(root, "cert.key"), "x\n");
  await writeFile(path.join(root, "id_rsa"), "x\n");
  await writeFile(path.join(root, "id_rsa.pub"), "x\n");
});

afterEach(async () => {
  await cleanup([root, ...outside]);
  outside = [];
});

describe("S4 path guard", () => {
  for (const name of [".env", ".env.local", "cert.pem", "cert.key", "id_rsa", "id_rsa.pub"]) {
    it(`rejects ${name}`, async () => {
      expect(await readFile(root, name)).toMatchObject({ ok: false, reason: "denylisted" });
    });
  }

  it("rejects .git/config", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, ".git", "config"), "[core]\n");
    expect(await readFile(root, ".git/config")).toMatchObject({ ok: false, reason: "denylisted" });
  });

  it("rejects symlink escape", async () => {
    const pair = await symlinkEscapePair();
    outside.push(pair.outside);
    expect(await resolveInsideRoot(pair.root, "escape-link")).toMatchObject({
      ok: false,
      reason: "symlink_escape",
    });
    await cleanup([pair.root]);
    outside = outside.filter((d) => d !== pair.outside);
  });

  it("rejects traversal and absolute paths", async () => {
    expect(await resolveInsideRoot(root, "../escape")).toMatchObject({
      ok: false,
      reason: "outside_root",
    });
    expect(await resolveInsideRoot(root, "/etc/passwd")).toMatchObject({
      ok: false,
      reason: "outside_root",
    });
  });

  it("rejects files over 1 MB", async () => {
    const big = "x".repeat(1024 * 1024 + 1);
    await writeFile(path.join(root, "big.ts"), big);
    expect(await readFile(root, "big.ts")).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("hides denylisted content from search", async () => {
    const result = await search(root, "SECRET");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hits.map((h) => h.path)).not.toContain(".env");
  });
});
