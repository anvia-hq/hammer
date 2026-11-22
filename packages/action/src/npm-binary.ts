import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";

export type BinarySetupErrorCode = "unsupported_platform" | "download_failed" | "checksum_failed";

export class BinarySetupError extends Error {
  readonly code: BinarySetupErrorCode;

  constructor(code: BinarySetupErrorCode, message: string) {
    super(message);
    this.name = "BinarySetupError";
    this.code = code;
  }
}

export interface BinaryPackage {
  package: string;
  tarball: string;
  integrity: string;
  unpackedSize: number;
  entry: string;
  binary: string;
}

export interface BinaryProvisionOptions {
  directory: string;
  entry: BinaryPackage;
  request: typeof globalThis.fetch;
  log: (message: string) => void;
  hint: string;
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
  hint: string,
): Promise<string> {
  let response: Response;
  try {
    response = await request(url, {
      headers: { "user-agent": "hammer-action" },
      redirect: "follow",
    });
  } catch (error) {
    throw new BinarySetupError(
      "download_failed",
      `Could not download the binary from ${url}: ${error instanceof Error ? error.message : String(error)}. Check the runner's network access and proxy settings, or ${hint}.`,
    );
  }
  if (!response.ok || response.body === null) {
    throw new BinarySetupError(
      "download_failed",
      `Could not download the binary from ${url}: HTTP ${response.status}. Check the runner's network access and proxy settings, or ${hint}.`,
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
    throw new BinarySetupError(
      "download_failed",
      `The binary download broke off: ${error instanceof Error ? error.message : String(error)}. Try again, or ${hint}.`,
    );
  }
  return `sha512-${hash.digest("base64")}`;
}

async function extractBinary(
  archive: string,
  entryName: string,
  destination: string,
  hint: string,
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
    throw new BinarySetupError(
      "download_failed",
      `The downloaded archive does not contain ${entryName}; the binary was not provisioned. ${hint}.`,
    );
  return (await stat(destination)).size;
}

// Downloads one pinned npm package into RUNNER_TEMP, verifies its sha512 before extracting
// anything, and extracts only the binary. A reuse is checked by hashing the file against the
// digest written next to it, so a second run does not download again.
export async function provisionNpmBinary(options: BinaryProvisionOptions): Promise<string> {
  const { entry, hint } = options;
  const directory = options.directory;
  const binaryPath = join(directory, entry.binary);
  await mkdir(directory, { recursive: true });
  if (await verifiedBinary(binaryPath)) {
    options.log(`[hammer] using the provisioned binary at ${binaryPath}`);
    return binaryPath;
  }
  await rm(binaryPath, { force: true });
  await rm(`${binaryPath}.sha512`, { force: true });
  const archive = join(directory, `${entry.binary}.download`);
  const extracted = join(directory, `${entry.binary}.extract`);
  options.log(
    `[hammer] downloading ${entry.package} (${Math.round(entry.unpackedSize / 1_048_576)} MiB unpacked)`,
  );
  try {
    const actual = await download(entry.tarball, archive, options.request, hint);
    if (actual !== entry.integrity) {
      throw new BinarySetupError(
        "checksum_failed",
        `The binary download failed its checksum: expected ${entry.integrity} for ${entry.tarball}, got ${actual}. Nothing was installed; delete the download under RUNNER_TEMP and run again, and if it repeats, check for a proxy or mirror that rewrites packages.`,
      );
    }
    const size = await extractBinary(archive, entry.entry, extracted, hint);
    if (size <= 0 || size > entry.unpackedSize)
      throw new BinarySetupError(
        "checksum_failed",
        `The extracted binary is ${size} bytes, which is outside the expected size of ${entry.package}. Nothing was installed.`,
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
