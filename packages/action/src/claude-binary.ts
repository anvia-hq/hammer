import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";

import { proxiedFetch } from "./github";

export const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const CLAUDE_SDK_VERSION = "0.3.326";

export interface ClaudePlatformPackage {
  package: string;
  tarball: string;
  integrity: string;
  unpackedSize: number;
  binary: string;
}

const REGISTRY = "https://registry.npmjs.org";

function tarballUrl(name: string): string {
  const short = name.slice(name.indexOf("/") + 1);
  return `${REGISTRY}/${name}/-/${short}-${CLAUDE_SDK_VERSION}.tgz`;
}

function platformPackage(name: string, binary: string, unpackedSize: number, integrity: string) {
  return {
    package: name,
    tarball: tarballUrl(name),
    integrity,
    unpackedSize,
    binary,
  } satisfies ClaudePlatformPackage;
}

// One row per optionalDependency of @anthropic-ai/claude-agent-sdk, pinned to the same version.
export const CLAUDE_PLATFORM_PACKAGES: Record<string, ClaudePlatformPackage> = {
  "linux-x64": platformPackage(
    "@anthropic-ai/claude-agent-sdk-linux-x64",
    "claude",
    371_430_493,
    "sha512-WMhDY07gk2O0E8FXTbrVYmPjSLFaYPDCPwsNueVxm6vZ7ek+lPaKuOMAxTb1K07TzSmTOexoWeX2Y9VrbVDMpw==",
  ),
  "linux-arm64": platformPackage(
    "@anthropic-ai/claude-agent-sdk-linux-arm64",
    "claude",
    370_272_269,
    "sha512-nYVN8jCcH490DCXIvby7rllzQFxLzKeKClfo2u/yv7mx3ipZQv344caULL/amwZ8w8GUzYyZ8hnS6pI9goSq+A==",
  ),
  "linux-x64-musl": platformPackage(
    "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
    "claude",
    357_789_539,
    "sha512-kK9VO3uFqNd4wgeU0Cefluam5AdPu6mvF1nn6aboGy8TA5NoxlWTmA4/AwMhK39zK1S9Q2OjeX0JtAahYlIchw==",
  ),
  "linux-arm64-musl": platformPackage(
    "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
    "claude",
    355_366_443,
    "sha512-baSsuP2/wuWujRpHjKT4WkJB5lhttqKq9jcTfY2KRtQpylbk8E5PWcct/pmwJfNCKIUoE8CD+JpmoWzsdd5Ajw==",
  ),
  "darwin-x64": platformPackage(
    "@anthropic-ai/claude-agent-sdk-darwin-x64",
    "claude",
    367_810_240,
    "sha512-m8K3Im2S8STdAVBrriuDZyJcnjsu/Vc3476wIOqTAefnCCdtdZ4AHcOcWxt+4KIHE5Vx1qT2qacTRrQBaVVweA==",
  ),
  "darwin-arm64": platformPackage(
    "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    "claude",
    353_038_248,
    "sha512-D3ZbowCMdKNet0YPZlsJxdJUW1t1Q8KLy1BwNd+5eilf18TlCRtWZlm8DrewFLmu/gxBK7gcsq6uysrIVbPyQg==",
  ),
  "win32-x64": platformPackage(
    "@anthropic-ai/claude-agent-sdk-win32-x64",
    "claude.exe",
    378_068_192,
    "sha512-Yn1gZXYFuHmjHz7SpHx4TqDcRDsC8TfwWcntJdYjFzMWm+caPAp6QRqr/aTvirjqVA1D+D8Rd29xhuytpE3xTQ==",
  ),
  "win32-arm64": platformPackage(
    "@anthropic-ai/claude-agent-sdk-win32-arm64",
    "claude.exe",
    360_078_056,
    "sha512-S+Ai+HhGRVFfTDmYWRfTrdWF3b4KMsfLSThZCqRJ0WCOKOXrRShMKV1hqqHBljx/wkMDPCpY0V/9S/e6w57eGQ==",
  ),
};

export type ClaudeSetupErrorCode = "unsupported_platform" | "download_failed" | "checksum_failed";

export class ClaudeSetupError extends Error {
  readonly code: ClaudeSetupErrorCode;

  constructor(code: ClaudeSetupErrorCode, message: string) {
    super(message);
    this.name = "ClaudeSetupError";
    this.code = code;
  }
}

export function isMuslLinux(): boolean {
  if (process.platform !== "linux") return false;
  const report: unknown =
    typeof process.report?.getReport === "function" ? process.report.getReport() : null;
  const header = (report as { header?: { glibcVersionRuntime?: string } } | null)?.header;
  return header?.glibcVersionRuntime === undefined;
}

export interface PlatformQuery {
  platform?: NodeJS.Platform;
  arch?: string;
  musl?: boolean;
}

export function claudePlatformKey(query: PlatformQuery = {}): string | null {
  const platform = query.platform ?? process.platform;
  const arch = query.arch ?? process.arch;
  if (platform === "win32" || platform === "darwin")
    return `${platform}-${arch}` in CLAUDE_PLATFORM_PACKAGES ? `${platform}-${arch}` : null;
  if (platform !== "linux") return null;
  const musl = query.musl ?? isMuslLinux();
  const key = `linux-${arch}${musl ? "-musl" : ""}`;
  return key in CLAUDE_PLATFORM_PACKAGES ? key : null;
}

function unsupportedPlatform(query: PlatformQuery): ClaudeSetupError {
  const platform = query.platform ?? process.platform;
  const arch = query.arch ?? process.arch;
  const musl = platform === "linux" && (query.musl ?? isMuslLinux());
  return new ClaudeSetupError(
    "unsupported_platform",
    `The Claude Agent SDK has no claude binary for ${platform}-${arch}${musl ? "-musl" : ""}. Supported platforms: ${Object.keys(CLAUDE_PLATFORM_PACKAGES).join(", ")}. Run reviews on a supported runner, set claude-path to a claude binary you installed yourself, or use client: anthropic, openai, gemini, openai-compatible or azure with an API key.`,
  );
}

async function sha512File(path: string): Promise<string> {
  const hash = createHash("sha512");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function verifiedBinary(binaryPath: string): Promise<boolean> {
  const marker = `${binaryPath}.sha512`;
  if (!(await exists(binaryPath)) || !(await exists(marker))) return false;
  try {
    const expected = (await readFile(marker, "utf8")).trim();
    return expected !== "" && (await sha512File(binaryPath)) === expected;
  } catch {
    return false;
  }
}

async function download(
  url: string,
  destination: string,
  request: typeof globalThis.fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await request(url, {
      headers: { "user-agent": "hammer-action" },
      redirect: "follow",
    });
  } catch (error) {
    throw new ClaudeSetupError(
      "download_failed",
      `Could not download the Claude binary from ${url}: ${error instanceof Error ? error.message : String(error)}. Check the runner's network access and proxy settings, or set claude-path.`,
    );
  }
  if (!response.ok || response.body === null) {
    throw new ClaudeSetupError(
      "download_failed",
      `Could not download the Claude binary from ${url}: HTTP ${response.status}. Check the runner's network access and proxy settings, or set claude-path.`,
    );
  }
  const hash = createHash("sha512");
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      hasher,
      createWriteStream(destination),
    );
  } catch (error) {
    throw new ClaudeSetupError(
      "download_failed",
      `The Claude binary download broke off: ${error instanceof Error ? error.message : String(error)}. Try again, or set claude-path.`,
    );
  }
  return `sha512-${hash.digest("base64")}`;
}

async function extractBinary(
  archive: string,
  entryName: string,
  destination: string,
): Promise<number> {
  const unpacker = extract();
  const source = createReadStream(archive);
  let found = false;
  const done = new Promise<void>((resolve, reject) => {
    unpacker.on("finish", () => resolve());
    unpacker.on("error", reject);
    source.on("error", reject);
    unpacker.on("entry", (header, stream, next) => {
      if (header.name !== entryName) {
        stream.on("end", next);
        stream.resume();
        return;
      }
      found = true;
      const writer = createWriteStream(destination);
      writer.on("finish", next);
      writer.on("error", reject);
      stream.pipe(writer);
    });
  });
  source.pipe(createGunzip()).pipe(unpacker);
  await done;
  if (!found)
    throw new ClaudeSetupError(
      "download_failed",
      `The downloaded archive does not contain ${entryName}; the Claude binary was not provisioned. Set claude-path to a claude binary you installed yourself.`,
    );
  return (await stat(destination)).size;
}

export interface ProvisionOptions {
  temp: string;
  version?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  musl?: boolean;
  request?: typeof globalThis.fetch;
  log?: (message: string) => void;
  packages?: Record<string, ClaudePlatformPackage>;
}

export async function provisionClaudeBinary(options: ProvisionOptions): Promise<string> {
  const version = options.version ?? CLAUDE_SDK_VERSION;
  const query: PlatformQuery = {
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.arch !== undefined ? { arch: options.arch } : {}),
    ...(options.musl !== undefined ? { musl: options.musl } : {}),
  };
  const packages = options.packages ?? CLAUDE_PLATFORM_PACKAGES;
  const key = claudePlatformKey(query);
  if (key === null) throw unsupportedPlatform(query);
  const entry = packages[key];
  if (entry === undefined) throw unsupportedPlatform(query);
  const log = options.log ?? (() => {});
  const request = options.request ?? proxiedFetch;
  const directory = join(options.temp, "hammer-claude", version, key);
  const binaryPath = join(directory, entry.binary);
  await mkdir(directory, { recursive: true });
  if (await verifiedBinary(binaryPath)) {
    log(`[hammer] using the provisioned Claude binary at ${binaryPath}`);
    return binaryPath;
  }
  await rm(binaryPath, { force: true });
  await rm(`${binaryPath}.sha512`, { force: true });
  const archive = join(directory, `${entry.binary}.download`);
  const extracted = join(directory, `${entry.binary}.extract`);
  log(
    `[hammer] downloading ${entry.package}@${version} (${Math.round(entry.unpackedSize / 1_048_576)} MiB unpacked)`,
  );
  try {
    const actual = await download(entry.tarball, archive, request);
    if (actual !== entry.integrity) {
      throw new ClaudeSetupError(
        "checksum_failed",
        `The Claude binary download failed its checksum: expected ${entry.integrity} for ${entry.tarball}, got ${actual}. Nothing was installed; delete RUNNER_TEMP/hammer-claude and run again, and if it repeats, check for a proxy or mirror that rewrites packages.`,
      );
    }
    const size = await extractBinary(archive, `package/${entry.binary}`, extracted);
    if (size <= 0 || size > entry.unpackedSize)
      throw new ClaudeSetupError(
        "checksum_failed",
        `The extracted Claude binary is ${size} bytes, which is outside the expected size of ${entry.package}. Nothing was installed.`,
      );
    await chmod(extracted, 0o755);
    await rename(extracted, binaryPath);
    await writeFile(`${binaryPath}.sha512`, `${await sha512File(binaryPath)}\n`, { mode: 0o644 });
    return binaryPath;
  } finally {
    await rm(archive, { force: true });
    await rm(extracted, { force: true });
  }
}
