import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import { runCheckoutPlan, type CheckoutPlanOptions } from "@anvia/hammer-core";

const execute = promisify(execFile);

export async function extractArchive(archive: Buffer, directory: string): Promise<void> {
  const unpack = extract();
  let bytes = 0;
  unpack.on("entry", (header, stream, next) => {
    void (async () => {
      const parts = header.name.split("/");
      if (
        parts.some((part) => part === "..") ||
        posix.isAbsolute(header.name) ||
        header.name.includes("\\")
      )
        throw new Error("Unsafe archive path.");
      const path = parts.slice(1).join("/");
      const destination = resolve(directory, path);
      const rel = relative(resolve(directory), destination);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new Error("Archive path escaped the checkout.");
      bytes += header.size ?? 0;
      if (bytes > 512 * 1024 * 1024) throw new Error("Archive exceeds the checkout size limit.");
      if (path && header.type === "directory") await mkdir(destination, { recursive: true });
      if (
        path &&
        header.type === "file" &&
        (header.size ?? 0) <= 1_000_000 &&
        !parts.includes(".git")
      ) {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          if (!Buffer.isBuffer(chunk)) throw new Error("Invalid archive chunk.");
          chunks.push(chunk);
        }
        await mkdir(join(destination, ".."), { recursive: true });
        await writeFile(destination, Buffer.concat(chunks), { flag: "wx", mode: 0o600 });
      } else {
        stream.resume();
        await new Promise<void>((done, reject) => {
          stream.on("end", done);
          stream.on("error", reject);
        });
      }
      next();
    })().catch((error: Error) => unpack.destroy(error));
  });
  await pipeline(Readable.from(archive), createGunzip(), unpack);
}

export async function checkoutHead(
  options: CheckoutPlanOptions,
  archive: () => Promise<Buffer>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await runCheckoutPlan(options, async (file, args, config) => {
      const result = await execute(file, args, {
        cwd: config?.cwd,
        env: {
          ...env,
          ...config?.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TEMPLATE_DIR: "",
          GIT_CONFIG_COUNT: "0",
          GIT_SSL_CAINFO: env.NODE_EXTRA_CA_CERTS ?? env.GIT_SSL_CAINFO,
        },
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
      return { ...result, exitCode: 0 };
    });
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw new Error("Read-only git checkout failed.");
    await rm(options.directory, { recursive: true, force: true });
    await mkdir(options.directory, { recursive: true });
    await extractArchive(await archive(), options.directory);
  }
}
