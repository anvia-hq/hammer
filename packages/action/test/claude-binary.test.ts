import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { describe, expect, it, vi } from "vitest";

import {
  CLAUDE_PLATFORM_PACKAGES,
  CLAUDE_SDK_VERSION,
  ClaudeSetupError,
  claudePlatformKey,
  provisionClaudeBinary,
  type ClaudePlatformPackage,
} from "../src/claude-binary";

const AGENTS_PACKAGE = new URL("../../agents/package.json", import.meta.url);
const SDK_PACKAGE = new URL(
  "../../agents/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
  import.meta.url,
);

async function readJson(url: URL): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(url, "utf8")) as Record<string, unknown>;
}

async function makeTarball(binary: string, contents: string): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: unknown) => chunks.push(Buffer.from(chunk as Uint8Array)));
  const done = new Promise<void>((resolve) => archive.on("end", () => resolve()));
  archive.entry({ name: `package/${binary}`, mode: 0o755 }, contents);
  archive.finalize();
  await done;
  return gzipSync(Buffer.concat(chunks));
}

function integrityOf(buffer: Buffer): string {
  return `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
}

function fakePackages(tarball: Buffer, integrity: string): Record<string, ClaudePlatformPackage> {
  return {
    "linux-x64": {
      package: "@anthropic-ai/claude-agent-sdk-linux-x64",
      tarball: "https://registry.npmjs.org/example/claude-0.3.326.tgz",
      integrity,
      unpackedSize: tarball.length * 4,
      binary: "claude",
    },
  };
}

function serving(tarball: Buffer) {
  return vi.fn(async () => new Response(new Uint8Array(tarball), { status: 200 }));
}

describe("claude binary provisioning table", () => {
  it("pins the version of the installed Claude Agent SDK", async () => {
    const agents = await readJson(AGENTS_PACKAGE);
    const dependencies = agents["dependencies"] as Record<string, string>;
    expect(dependencies["@anthropic-ai/claude-agent-sdk"]).toBe(CLAUDE_SDK_VERSION);
    expect(CLAUDE_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("covers every platform the SDK declares as an optional dependency", async () => {
    const sdk = await readJson(SDK_PACKAGE);
    const optional = Object.keys((sdk["optionalDependencies"] ?? {}) as Record<string, string>);
    expect(optional).not.toHaveLength(0);
    const covered = Object.values(CLAUDE_PLATFORM_PACKAGES).map((entry) => entry.package);
    expect(covered.sort()).toEqual(optional.sort());
    for (const entry of Object.values(CLAUDE_PLATFORM_PACKAGES)) {
      expect(entry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
      expect(entry.tarball).toContain(CLAUDE_SDK_VERSION);
      expect(entry.unpackedSize).toBeGreaterThan(100_000_000);
      expect(entry.binary).toMatch(/^claude(\.exe)?$/);
    }
  });

  it("picks the platform key from platform, arch and libc", () => {
    expect(claudePlatformKey({ platform: "linux", arch: "x64", musl: false })).toBe("linux-x64");
    expect(claudePlatformKey({ platform: "linux", arch: "arm64", musl: true })).toBe(
      "linux-arm64-musl",
    );
    expect(claudePlatformKey({ platform: "darwin", arch: "arm64" })).toBe("darwin-arm64");
    expect(claudePlatformKey({ platform: "win32", arch: "x64" })).toBe("win32-x64");
    expect(claudePlatformKey({ platform: "linux", arch: "ia32", musl: false })).toBeNull();
    expect(claudePlatformKey({ platform: "freebsd", arch: "x64" })).toBeNull();
  });
});

describe("claude binary provisioning", () => {
  it("downloads, verifies, extracts and reuses the binary", async () => {
    const tarball = await makeTarball("claude", "#!/bin/sh\necho 'Claude Code 2.1.326'\n");
    const request = serving(tarball);
    const temp = await mkdtemp(join(tmpdir(), "hammer-claude-prov-"));
    const log = vi.fn();
    const options = {
      temp,
      platform: "linux" as const,
      arch: "x64",
      musl: false,
      request,
      packages: fakePackages(tarball, integrityOf(tarball)),
      log,
    };
    const binaryPath = await provisionClaudeBinary(options);
    expect(
      binaryPath.endsWith(join("hammer-claude", CLAUDE_SDK_VERSION, "linux-x64", "claude")),
    ).toBe(true);
    expect(await readFile(binaryPath, "utf8")).toContain("Claude Code 2.1.326");
    expect((await stat(binaryPath)).mode & 0o777).toBe(0o755);
    expect(await readFile(`${binaryPath}.sha512`, "utf8")).toMatch(/^[0-9a-f]{128}\n$/);
    expect(request).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("downloading"));

    const again = await provisionClaudeBinary(options);
    expect(again).toBe(binaryPath);
    expect(request).toHaveBeenCalledTimes(1);

    await writeFile(binaryPath, "corrupted");
    await provisionClaudeBinary(options);
    expect(request).toHaveBeenCalledTimes(2);
    expect(await readFile(binaryPath, "utf8")).toContain("Claude Code 2.1.326");
    const leftovers = await readdir(join(temp, "hammer-claude", CLAUDE_SDK_VERSION, "linux-x64"));
    expect(
      leftovers.filter((name) => name.endsWith(".download") || name.endsWith(".extract")),
    ).toEqual([]);
  });

  it("fails on a checksum mismatch before installing anything", async () => {
    const tarball = await makeTarball("claude", "binary");
    const temp = await mkdtemp(join(tmpdir(), "hammer-claude-bad-"));
    const error = await provisionClaudeBinary({
      temp,
      platform: "linux",
      arch: "x64",
      musl: false,
      request: serving(tarball),
      packages: fakePackages(tarball, integrityOf(Buffer.from("something else"))),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClaudeSetupError);
    expect((error as ClaudeSetupError).code).toBe("checksum_failed");
    expect((error as Error).message).toContain("failed its checksum");
    const directory = join(temp, "hammer-claude", CLAUDE_SDK_VERSION, "linux-x64");
    expect((await readdir(directory)).filter((name) => name === "claude")).toEqual([]);
  });

  it("names an unsupported platform and the way out", async () => {
    const temp = await mkdtemp(join(tmpdir(), "hammer-claude-platform-"));
    const error = await provisionClaudeBinary({ temp, platform: "freebsd", arch: "x64" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ClaudeSetupError);
    expect((error as ClaudeSetupError).code).toBe("unsupported_platform");
    expect((error as Error).message).toContain("claude-path");
    expect((error as Error).message).toContain("freebsd-x64");
  });

  it("reports an HTTP failure instead of an empty binary", async () => {
    const temp = await mkdtemp(join(tmpdir(), "hammer-claude-404-"));
    const tarball = await makeTarball("claude", "binary");
    const error = await provisionClaudeBinary({
      temp,
      platform: "linux",
      arch: "x64",
      musl: false,
      request: vi.fn(async () => new Response(null, { status: 404 })),
      packages: fakePackages(tarball, integrityOf(tarball)),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClaudeSetupError);
    expect((error as ClaudeSetupError).code).toBe("download_failed");
    expect((error as Error).message).toContain("HTTP 404");
  });
});
