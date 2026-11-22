import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CodexError, spawnCodex, type CodexExecParams } from "../src/index";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function execScript(script: string, overrides: Partial<CodexExecParams> = {}) {
  return spawnCodex({
    executablePath: process.execPath,
    args: ["-e", script],
    prompt: "",
    cwd: tmpdir(),
    env: {},
    ...overrides,
  });
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of stream) lines.push(line);
  return lines;
}

async function collectError(stream: AsyncIterable<string>): Promise<unknown> {
  try {
    await collect(stream);
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("codex process runner", () => {
  it("streams stdout a line at a time and accepts a clean exit", async () => {
    const lines = await collect(
      execScript(
        'console.log(JSON.stringify({type:"a"}));console.log(JSON.stringify({type:"b"}));',
      ),
    );
    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}']);
  });

  it("fails a turn whose process exits non-zero, with the tail of stderr", async () => {
    const error = await collectError(
      execScript('console.error("missing optional dependency");process.exit(3);'),
    );
    expect(error).toBeInstanceOf(CodexError);
    const codex = error as CodexError;
    expect(codex.code).toBe("exit");
    expect(codex.message).toContain("exited with code 3");
    expect(codex.message).toContain("missing optional dependency");
  });

  it("reports a missing executable instead of hanging", async () => {
    const error = await collectError(
      execScript('console.log("never")', {
        executablePath: "/nonexistent/codex",
      }),
    );
    expect(error).toBeInstanceOf(CodexError);
    expect((error as CodexError).message).toContain("ENOENT");
  });

  it("stops the process when the turn is aborted", async () => {
    const controller = new AbortController();
    const consumed = collect(
      execScript("setInterval(() => {}, 1000)", { signal: controller.signal }),
    );
    controller.abort();
    expect(await consumed).toEqual([]);
  });

  it("starts in the checkout Hammer hands it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hammer-codex-exec-"));
    roots.push(cwd);
    const lines = await collect(execScript("console.log(process.cwd())", { cwd }));
    expect(lines[0]).toBe(await realpath(cwd));
  });
});
