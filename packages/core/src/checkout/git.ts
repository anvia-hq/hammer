export const HOOKS_PATH = "/dev/null";

export const CHECKOUT_ENV = {
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_TERMINAL_PROMPT: "0",
};

export interface CheckoutPlanOptions {
  directory: string;
  repositoryUrl: string;
  headSha: string;
  baseSha?: string | undefined;
  token: string;
}

export type ExecFn = (
  file: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface CheckoutStep {
  file: string;
  args: string[];
}

export interface CheckoutResult {
  directory: string;
  headSha: string;
  steps: number;
}

function basicAuthHeader(token: string): string {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
}

export function initArgs(directory: string): string[] {
  return ["init", directory];
}

export function remoteArgs(repositoryUrl: string): string[] {
  if (repositoryUrl.includes("@")) {
    throw new Error("repository URL must not contain credentials");
  }
  return ["remote", "add", "origin", repositoryUrl];
}

export function fetchArgs(
  options: Pick<CheckoutPlanOptions, "headSha" | "baseSha" | "token">,
): string[] {
  const args = [
    "-c",
    `core.hooksPath=${HOOKS_PATH}`,
    "-c",
    "protocol.file.allow=never",
    "-c",
    `http.extraheader=${basicAuthHeader(options.token)}`,
    "fetch",
    "--depth",
    "1",
    "--no-tags",
    "--no-recurse-submodules",
    "origin",
    options.headSha,
  ];
  if (options.baseSha !== undefined && options.baseSha !== options.headSha) {
    args.push(options.baseSha);
  }
  return args;
}

export function checkoutArgs(headSha = "FETCH_HEAD"): string[] {
  return [
    "-c",
    `core.hooksPath=${HOOKS_PATH}`,
    "-c",
    "submodule.recurse=false",
    "checkout",
    "--detach",
    headSha,
  ];
}

export function checkoutSteps(options: CheckoutPlanOptions): {
  init: CheckoutStep;
  remote: CheckoutStep;
  fetch: CheckoutStep;
  checkout: CheckoutStep;
  env: Record<string, string>;
} {
  return {
    init: { file: "git", args: initArgs(options.directory) },
    remote: { file: "git", args: remoteArgs(options.repositoryUrl) },
    fetch: { file: "git", args: fetchArgs(options) },
    checkout: { file: "git", args: checkoutArgs(options.headSha) },
    env: { ...CHECKOUT_ENV },
  };
}

export function assertReadOnlySteps(steps: CheckoutStep[]): void {
  for (const step of steps) {
    for (const arg of step.args) {
      if (arg === "submodule" || arg === "npm" || arg === "pnpm" || arg === "install") {
        throw new Error(`checkout step must stay read-only: ${step.args.join(" ")}`);
      }
    }
    const joined = step.args.join(" ");
    if (joined.includes("lfs install")) {
      throw new Error(`checkout step must stay read-only: ${joined}`);
    }
    for (let i = 0; i < step.args.length; i += 1) {
      if (step.args[i]?.startsWith("core.hooksPath=") && step.args[i - 1] !== "-c") {
        throw new Error(`hooksPath must be passed via -c: ${joined}`);
      }
      if (step.args[i] === "-c" && step.args[i + 1]?.startsWith("core.hooksPath=")) {
        if (step.args[i + 1] !== `core.hooksPath=${HOOKS_PATH}`) {
          throw new Error(`hooksPath must be ${HOOKS_PATH}: ${joined}`);
        }
      }
    }
  }
}

export async function runCheckoutPlan(
  options: CheckoutPlanOptions,
  exec: ExecFn,
): Promise<CheckoutResult> {
  const plan = checkoutSteps(options);
  assertReadOnlySteps([plan.init, plan.remote, plan.fetch, plan.checkout]);
  const env = { ...plan.env };
  for (const [index, step] of [plan.init, plan.remote, plan.fetch, plan.checkout].entries()) {
    const result = await exec(step.file, step.args, {
      ...(index === 0 ? {} : { cwd: options.directory }),
      env,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Read-only checkout failed at step ${index + 1} (exit ${result.exitCode}).`);
    }
  }
  return { directory: options.directory, headSha: options.headSha, steps: 4 };
}
