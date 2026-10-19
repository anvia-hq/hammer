import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function symlinkEscapePair(): Promise<{ root: string; outside: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "hammer-adv-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "hammer-adv-outside-"));
  await writeFile(path.join(outside, "secret.txt"), "top-secret\n");
  await symlink(path.join(outside, "secret.txt"), path.join(root, "escape-link"));
  return { root, outside };
}

export async function cleanup(dirs: string[]): Promise<void> {
  const { rm } = await import("node:fs/promises");
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
}
