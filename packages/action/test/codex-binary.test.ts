import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CODEX_CLI_VERSION,
  CODEX_PLATFORM_PACKAGES,
  CodexSetupError,
  codexPlatformKey,
  provisionCodexBinary,
  type CodexPlatformPackage,
} from "../src/codex-binary";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTarball(entry: string, contents: string): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: unknown) => chunks.push(Buffer.from(chunk as Uint8Array)));
  const done = new Promise<void>((resolve) => archive.on("end", () => resolve()));
  archive.entry({ name: entry, mode: 0o755 }, contents);
  archive.finalize();
  await done;
  return gzipSync(Buffer.concat(chunks));
}

function integrityOf(buffer: Buffer): string {
  return `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
}

const ENTRY = "package/vendor/x86_64-unknown-linux-musl/bin/codex";

function fakePackages(tarball: Buffer, integrity: string): Record<string, CodexPlatformPackage> {
  return {
    "linux-x64": {
      package: `@openai/codex@${CODEX_CLI_VERSION}-linux-x64`,
      tarball: `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_CLI_VERSION}-linux-x64.tgz`,
      integrity,
      unpackedSize: tarball.length * 4,
      binary: "codex",
      entry: ENTRY,
    },
  };
}

function serving(tarball: Buffer) {
  return vi.fn(async () => new Response(new Uint8Array(tarball), { status: 200 }));
}

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hammer-codex-bin-"));
  roots.push(root);
  return root;
}

describe("codex binary provisioning table", () => {
  it("pins one checksummed tarball per platform the CLI ships", () => {
    expect(CODEX_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(CODEX_PLATFORM_PACKAGES).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ]);
    for (const [key, entry] of Object.entries(CODEX_PLATFORM_PACKAGES)) {
      expect(entry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
      expect(entry.tarball).toContain(`${CODEX_CLI_VERSION}-${key}.tgz`);
      expect(entry.package).toBe(`@openai/codex@${CODEX_CLI_VERSION}-${key}`);
      expect(entry.unpackedSize).toBeGreaterThan(300_000_000);
      expect(entry.binary).toBe(key.startsWith("win32") ? "codex.exe" : "codex");
      expect(entry.entry).toMatch(
        /^package\/vendor\/[a-z0-9_]+-[a-z0-9_]+-[\w-]+\/bin\/codex(\.exe)?$/,
      );
    }
  });

  it("maps a runner to its platform key and refuses the rest", () => {
    expect(codexPlatformKey({ platform: "linux", arch: "x64" })).toBe("linux-x64");
    expect(codexPlatformKey({ platform: "darwin", arch: "arm64" })).toBe("darwin-arm64");
    expect(codexPlatformKey({ platform: "win32", arch: "arm64" })).toBe("win32-arm64");
    expect(codexPlatformKey({ platform: "freebsd", arch: "x64" })).toBeNull();
    expect(codexPlatformKey({ platform: "linux", arch: "ia32" })).toBeNull();
  });
});

describe("codex binary provisioning", () => {
  it("downloads, verifies the sha512, extracts only the codex binary and reuses it", async () => {
    const tarball = await makeTarball(ENTRY, "#!/bin/sh\necho codex\n");
    const directory = await temp();
    const log = vi.fn();
    const path = await provisionCodexBinary({
      temp: directory,
      platform: "linux",
      arch: "x64",
      request: serving(tarball),
      packages: fakePackages(tarball, integrityOf(tarball)),
      log,
    });
    expect(path).toBe(join(directory, "hammer-codex", CODEX_CLI_VERSION, "linux-x64", "codex"));
    expect(await readFile(path, "utf8")).toContain("echo codex");
    expect(log.mock.calls.join("\n")).toContain("@openai/codex");
    const request = serving(tarball);
    const again = await provisionCodexBinary({
      temp: directory,
      platform: "linux",
      arch: "x64",
      request,
      packages: fakePackages(tarball, integrityOf(tarball)),
    });
    expect(again).toBe(path);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a download that fails its checksum and installs nothing", async () => {
    const tarball = await makeTarball(ENTRY, "codex");
    const directory = await temp();
    await expect(
      provisionCodexBinary({
        temp: directory,
        platform: "linux",
        arch: "x64",
        request: serving(tarball),
        packages: fakePackages(tarball, "sha512-expected"),
      }),
    ).rejects.toThrow(/failed its checksum/);
    const failures = await provisionCodexBinary({
      temp: directory,
      platform: "linux",
      arch: "x64",
      request: serving(tarball),
      packages: fakePackages(tarball, "sha512-expected"),
    }).catch((error: unknown) => error);
    expect(failures).toBeInstanceOf(CodexSetupError);
    expect((failures as CodexSetupError).code).toBe("checksum_failed");
    expect((failures as CodexSetupError).message).toContain("Nothing was installed");
  });

  it("fails an unsupported platform with the supported list and the way out", async () => {
    const directory = await temp();
    const error = await provisionCodexBinary({
      temp: directory,
      platform: "linux",
      arch: "ia32",
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(CodexSetupError);
    const setup = error as CodexSetupError;
    expect(setup.code).toBe("unsupported_platform");
    expect(setup.message).toContain("linux-ia32");
    expect(setup.message).toContain("codex-path");
    expect(setup.message).toContain(
      "client: anthropic, openai, gemini, openai-compatible or azure",
    );
  });

  it("reports a missing archive entry instead of leaving a broken binary", async () => {
    const tarball = await makeTarball("package/README.md", "docs");
    const directory = await temp();
    await expect(
      provisionCodexBinary({
        temp: directory,
        platform: "linux",
        arch: "x64",
        request: serving(tarball),
        packages: fakePackages(tarball, integrityOf(tarball)),
      }),
    ).rejects.toThrow(/does not contain/);
  });
});
