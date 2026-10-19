import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isDenylistedBasename, resolveInsideRoot } from "../src/index";

let root = "";
let outside = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hammer-root-"));
  outside = await mkdtemp(path.join(tmpdir(), "hammer-outside-"));
  await writeFile(path.join(root, "ok.ts"), "export const x = 1;\n");
  await mkdir(path.join(root, "nested"), { recursive: true });
  await writeFile(path.join(root, "nested", "deep.ts"), "export const y = 2;\n");
  await writeFile(path.join(root, ".env"), "SECRET=1\n");
  await writeFile(path.join(root, ".env.local"), "SECRET=1\n");
  await writeFile(path.join(root, "cert.pem"), "pem\n");
  await writeFile(path.join(root, "cert.key"), "key\n");
  await writeFile(path.join(root, "id_rsa"), "rsa\n");
  await mkdir(path.join(root, ".git"), { recursive: true });
  await writeFile(path.join(root, ".git", "config"), "[core]\n");
  await writeFile(path.join(outside, "secret.txt"), "outside\n");
  await symlink(path.join(root, "ok.ts"), path.join(root, "link-inside"));
  await symlink(path.join(outside, "secret.txt"), path.join(root, "link-outside"));
  const big = Buffer.alloc(1024 * 1024 + 8, 0);
  await writeFile(path.join(root, "big.bin"), big);
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("resolveInsideRoot", () => {
  it("allows a normal file and a nested file", async () => {
    const top = await resolveInsideRoot(root, "ok.ts");
    expect(top.ok).toBe(true);
    const nested = await resolveInsideRoot(root, "nested/deep.ts");
    expect(nested.ok).toBe(true);
  });

  it("allows a symlink pointing inside the root", async () => {
    const result = await resolveInsideRoot(root, "link-inside");
    expect(result.ok).toBe(true);
  });

  it("rejects a symlink pointing outside as symlink_escape", async () => {
    const result = await resolveInsideRoot(root, "link-outside");
    expect(result).toEqual({ ok: false, reason: "symlink_escape" });
  });

  it("rejects traversal and absolute paths", async () => {
    expect(await resolveInsideRoot(root, "../escape")).toEqual({
      ok: false,
      reason: "outside_root",
    });
    expect(await resolveInsideRoot(root, "nested/../../escape")).toEqual({
      ok: false,
      reason: "outside_root",
    });
    expect(await resolveInsideRoot(root, path.join(outside, "secret.txt"))).toEqual({
      ok: false,
      reason: "outside_root",
    });
  });

  it("rejects denylisted names and .git contents", async () => {
    for (const rel of [".env", ".env.local", "cert.pem", "cert.key", "id_rsa", ".git/config"]) {
      expect(await resolveInsideRoot(root, rel)).toEqual({ ok: false, reason: "denylisted" });
    }
  });

  it("rejects files over 1 MB", async () => {
    expect(await resolveInsideRoot(root, "big.bin")).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("reports missing files as not_found", async () => {
    expect(await resolveInsideRoot(root, "missing.ts")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("isDenylistedBasename", () => {
  it("matches the S4 patterns on basenames", () => {
    expect(isDenylistedBasename(".env")).toBe(true);
    expect(isDenylistedBasename(".env.production")).toBe(true);
    expect(isDenylistedBasename("server.pem")).toBe(true);
    expect(isDenylistedBasename("server.key")).toBe(true);
    expect(isDenylistedBasename("id_rsa_backup")).toBe(true);
    expect(isDenylistedBasename("app.ts")).toBe(false);
  });
});
