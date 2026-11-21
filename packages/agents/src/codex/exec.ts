import { spawn } from "node:child_process";

import { codexExitError } from "./errors";

export interface CodexExecParams {
  executablePath: string;
  args: readonly string[];
  prompt: string;
  cwd: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal | undefined;
}

export type CodexExecFn = (params: CodexExecParams) => AsyncIterable<string>;

const STDERR_TAIL_CHARS = 4_000;

function stderrTail(chunks: string[]): string {
  const joined = chunks.join("");
  return joined.length <= STDERR_TAIL_CHARS
    ? joined
    : joined.slice(joined.length - STDERR_TAIL_CHARS);
}

// Streams stdout line by line and fails once the process exits: a JSONL turn is only usable when
// the child succeeded, and the tail of stderr says why when it did not.
export const spawnCodex: CodexExecFn = (params) =>
  (async function* () {
    const child = spawn(params.executablePath, [...params.args], {
      cwd: params.cwd,
      env: params.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: string[] = [];
    const stderr: string[] = [];
    let buffer = "";
    let finished = false;
    let spawnError: string | undefined;
    let resolveLine: (() => void) | undefined;
    const exit: { code: number | null; signal: NodeJS.Signals | null } = {
      code: null,
      signal: null,
    };

    const wake = (): void => {
      resolveLine?.();
      resolveLine = undefined;
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      wake();
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr.push(chunk);
      if (stderr.join("").length > STDERR_TAIL_CHARS * 2) stderr.splice(0, stderr.length - 1);
    });

    child.on("error", (error: Error) => {
      spawnError = error.message;
      finished = true;
      wake();
    });
    child.on("close", (code, signal) => {
      exit.code = code;
      exit.signal = signal;
      finished = true;
      wake();
    });

    const abort = (): void => {
      child.kill("SIGTERM");
    };
    params.signal?.addEventListener("abort", abort, { once: true });

    child.stdin.on("error", () => {});
    child.stdin.end(params.prompt);

    try {
      for (;;) {
        const line = lines.shift();
        if (line !== undefined) {
          yield line;
          continue;
        }
        if (finished) break;
        await new Promise<void>((resolve) => {
          resolveLine = resolve;
        });
      }
      if (buffer.trim() !== "") yield buffer;
    } finally {
      params.signal?.removeEventListener("abort", abort);
    }

    if (spawnError !== undefined) throw codexExitError(1, spawnError);
    if (params.signal?.aborted === true) return;
    if (exit.signal !== null) throw codexExitError(1, `Codex was stopped by ${exit.signal}.`);
    if (exit.code !== 0) throw codexExitError(exit.code ?? 1, stderrTail(stderr));
  })();
