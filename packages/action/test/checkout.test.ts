import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import { checkoutHead, extractArchive } from "../src/checkout";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "hammer-archive-test-"));
  roots.push(root);
  return root;
}
async function archive(
  entries: Array<{ name: string; content?: string; type?: "file" | "symlink"; linkname?: string }>,
): Promise<Buffer> {
  const tar = pack();
  for (const entry of entries)
    tar.entry(
      {
        name: entry.name,
        type: entry.type ?? "file",
        ...(entry.linkname ? { linkname: entry.linkname } : {}),
      },
      entry.content ?? "",
    );
  tar.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of tar) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Invalid tar chunk");
    chunks.push(chunk);
  }
  return gzipSync(Buffer.concat(chunks));
}
describe("archive checkout", () => {
  it("uses the API archive when git is missing and extracts ordinary files", async () => {
    const root = await directory();
    const data = await archive([{ name: "repo-sha/src/a.ts", content: "const a = 1;" }]);
    await checkoutHead(
      {
        directory: join(root, "head"),
        repositoryUrl: "https://github.com/acme/sandbox.git",
        headSha: "a".repeat(40),
        token: "test",
      },
      async () => data,
      { PATH: "" },
    );
    expect(await readFile(join(root, "head/src/a.ts"), "utf8")).toBe("const a = 1;");
  });
  it("rejects traversal and does not materialize symlinks or git metadata", async () => {
    const root = await directory();
    await expect(
      extractArchive(await archive([{ name: "repo-sha/../escape", content: "bad" }]), root),
    ).rejects.toThrow("Unsafe archive path");
    await extractArchive(
      await archive([
        { name: "repo-sha/escape", type: "symlink", linkname: "/etc/passwd" },
        { name: "repo-sha/.git/config", content: "bad" },
      ]),
      root,
    );
    expect(await readdir(root)).toEqual([]);
  });
});
