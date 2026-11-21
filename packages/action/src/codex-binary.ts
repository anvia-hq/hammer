import { join } from "node:path";

import { proxiedFetch } from "./github";
import { BinarySetupError, provisionNpmBinary } from "./npm-binary";

export const CODEX_CLI_PACKAGE = "@openai/codex";
export const CODEX_CLI_VERSION = "0.171.0";

export interface CodexPlatformPackage {
  package: string;
  tarball: string;
  integrity: string;
  unpackedSize: number;
  binary: string;
  entry: string;
}

const REGISTRY = "https://registry.npmjs.org";

// The platform packages are published as `@openai/codex` with a per-platform version suffix, and
// vendored under `<package>/vendor/<target triple>/bin/codex`.
function platformPackage(input: {
  tag: string;
  triple: string;
  binary: string;
  unpackedSize: number;
  integrity: string;
}): CodexPlatformPackage {
  const version = `${CODEX_CLI_VERSION}-${input.tag}`;
  return {
    package: `${CODEX_CLI_PACKAGE}@${version}`,
    tarball: `${REGISTRY}/@openai/codex/-/codex-${version}.tgz`,
    integrity: input.integrity,
    unpackedSize: input.unpackedSize,
    binary: input.binary,
    entry: `package/vendor/${input.triple}/bin/${input.binary}`,
  };
}

// One row per optionalDependency of @openai/codex, pinned to the same version. The Linux binaries
// are the static musl builds, so one row covers glibc and musl runners.
export const CODEX_PLATFORM_PACKAGES: Record<string, CodexPlatformPackage> = {
  "linux-x64": platformPackage({
    tag: "linux-x64",
    triple: "x86_64-unknown-linux-musl",
    binary: "codex",
    unpackedSize: 443_947_738,
    integrity:
      "sha512-l66NZkQgdk2C3pbcfULDz42yEUB581MVA6I+Y43Wp4OIqEy73HCdmZ0GTjeAHY2ycuH4N00d9VsLrwT1jxshTw==",
  }),
  "linux-arm64": platformPackage({
    tag: "linux-arm64",
    triple: "aarch64-unknown-linux-musl",
    binary: "codex",
    unpackedSize: 442_039_428,
    integrity:
      "sha512-9z17t4bbUJ9UCIb49O4PoA+ki+45q3rd8nZ8PeH6sYnlKkBld/Xpo/OS3h3Ti954+foshX4o7k5TCU8N7zzqQA==",
  }),
  "darwin-x64": platformPackage({
    tag: "darwin-x64",
    triple: "x86_64-apple-darwin",
    binary: "codex",
    unpackedSize: 421_985_670,
    integrity:
      "sha512-pwN5uNEKx/mZjwBEf/6CKq6SJMfJS5kruV3sJQAk7ebIPvC58Ote3CicIxETDZtjLj35rNv3PLPd7mHCg6hGPw==",
  }),
  "darwin-arm64": platformPackage({
    tag: "darwin-arm64",
    triple: "aarch64-apple-darwin",
    binary: "codex",
    unpackedSize: 394_891_854,
    integrity:
      "sha512-hIYTkRUpuYpkVfTq4cpby0PXqhAVcIgE7f6FoyY1lt2RyARj3GXS1Can/dIYUBItVhXzhb98HYHZNzCX74QRlQ==",
  }),
  "win32-x64": platformPackage({
    tag: "win32-x64",
    triple: "x86_64-pc-windows-msvc",
    binary: "codex.exe",
    unpackedSize: 540_421_759,
    integrity:
      "sha512-HKWBK25tLQxdEg6svw0CrBf+v0bQhRyF8EBVdNqeRxErqpfFa/dfSar6r3sJt6tyPqozOtgz2BH8B2G3n/+gnQ==",
  }),
  "win32-arm64": platformPackage({
    tag: "win32-arm64",
    triple: "aarch64-pc-windows-msvc",
    binary: "codex.exe",
    unpackedSize: 465_382_015,
    integrity:
      "sha512-kkavDHtAkkNaYtO7eBw4IdBbE/PsWP+Ezp9JXcr/mBu/Cc7EevzFVIVC3sZYvWsF9xuvyjIUv9CKeN0LU0+N9Q==",
  }),
};

export type CodexSetupErrorCode = "unsupported_platform" | "download_failed" | "checksum_failed";

export class CodexSetupError extends Error {
  readonly code: CodexSetupErrorCode;

  constructor(code: CodexSetupErrorCode, message: string) {
    super(message);
    this.name = "CodexSetupError";
    this.code = code;
  }
}

export interface CodexPlatformQuery {
  platform?: NodeJS.Platform;
  arch?: string;
}

export function codexPlatformKey(query: CodexPlatformQuery = {}): string | null {
  const platform = query.platform ?? process.platform;
  const arch = query.arch ?? process.arch;
  const key = `${platform}-${arch}`;
  return key in CODEX_PLATFORM_PACKAGES ? key : null;
}

function unsupportedPlatform(query: CodexPlatformQuery): CodexSetupError {
  const platform = query.platform ?? process.platform;
  const arch = query.arch ?? process.arch;
  return new CodexSetupError(
    "unsupported_platform",
    `The Codex CLI has no binary for ${platform}-${arch}. Supported platforms: ${Object.keys(CODEX_PLATFORM_PACKAGES).join(", ")}. Run reviews on a supported runner, set codex-path to a codex binary you installed yourself, or use client: anthropic, openai, gemini, openai-compatible or azure with an API key.`,
  );
}

const CODEX_PATH_HINT = "set codex-path to a codex binary you installed yourself";

export interface CodexProvisionOptions {
  temp: string;
  platform?: NodeJS.Platform;
  arch?: string;
  request?: typeof globalThis.fetch;
  log?: (message: string) => void;
  packages?: Record<string, CodexPlatformPackage>;
}

export async function provisionCodexBinary(options: CodexProvisionOptions): Promise<string> {
  const query: CodexPlatformQuery = {
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.arch !== undefined ? { arch: options.arch } : {}),
  };
  const packages = options.packages ?? CODEX_PLATFORM_PACKAGES;
  const key = codexPlatformKey(query);
  if (key === null) throw unsupportedPlatform(query);
  const entry = packages[key];
  if (entry === undefined) throw unsupportedPlatform(query);
  try {
    return await provisionNpmBinary({
      directory: join(options.temp, "hammer-codex", CODEX_CLI_VERSION, key),
      entry: {
        package: entry.package,
        tarball: entry.tarball,
        integrity: entry.integrity,
        unpackedSize: entry.unpackedSize,
        entry: entry.entry,
        binary: entry.binary,
      },
      request: options.request ?? proxiedFetch,
      log: options.log ?? (() => {}),
      hint: CODEX_PATH_HINT,
    });
  } catch (error) {
    if (error instanceof BinarySetupError) throw new CodexSetupError(error.code, error.message);
    throw error;
  }
}
