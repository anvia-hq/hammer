import { rm, realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import * as core from "@actions/core";

export async function cleanup(directory: string, temp: string): Promise<void> {
  if (!directory) return;
  const root = await realpath(temp);
  let path: string;
  try {
    path = await realpath(directory);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  if (dirname(path) !== root || !basename(path).startsWith("hammer-review-"))
    throw new Error("Refusing to clean a directory outside Hammer's runner temp directory.");
  await rm(path, { recursive: true, force: true });
}

export async function post(): Promise<void> {
  try {
    await cleanup(core.getState("review-directory"), process.env.RUNNER_TEMP ?? "");
  } catch {
    core.warning("[hammer] Temporary checkout cleanup failed.");
  }
}

await post();
