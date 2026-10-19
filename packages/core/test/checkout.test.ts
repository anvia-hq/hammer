import { describe, expect, it, vi } from "vitest";

import {
  assertReadOnlySteps,
  CHECKOUT_ENV,
  checkoutArgs,
  checkoutSteps,
  fetchArgs,
  HOOKS_PATH,
  initArgs,
  remoteArgs,
  runCheckoutPlan,
  type CheckoutPlanOptions,
  type ExecFn,
} from "../src/index";

const OPTIONS: CheckoutPlanOptions = {
  directory: "/tmp/hammer-head",
  repositoryUrl: "https://github.com/acme/repo.git",
  headSha: "abc123",
  baseSha: "def456",
  token: "ghs_test",
};

describe("checkout argument builders", () => {
  it("inits in the given directory", () => {
    expect(initArgs("/tmp/hammer-head")).toEqual(["init", "/tmp/hammer-head"]);
  });

  it("adds the remote without credentials in the URL", () => {
    expect(remoteArgs("https://github.com/acme/repo.git")).toEqual([
      "remote",
      "add",
      "origin",
      "https://github.com/acme/repo.git",
    ]);
    expect(() => remoteArgs("https://x-access-token:abc@github.com/acme/repo.git")).toThrow();
  });

  it("fetches head and base shas at depth 1 without submodules or LFS", () => {
    const args = fetchArgs(OPTIONS);
    expect(args).toContain("fetch");
    expect(args).toContain("--depth");
    expect(args[args.indexOf("--depth") + 1]).toBe("1");
    expect(args).toContain("--no-recurse-submodules");
    expect(args).toContain("--no-tags");
    expect(args).toContain("origin");
    expect(args).toContain("abc123");
    expect(args).toContain("def456");
  });

  it("omits the base sha when it equals the head sha", () => {
    const args = fetchArgs({ ...OPTIONS, baseSha: "abc123" });
    expect(args.filter((arg) => arg === "abc123")).toHaveLength(1);
  });

  it("checks out FETCH_HEAD read-only", () => {
    expect(checkoutArgs()).toEqual(["checkout", "FETCH_HEAD"]);
  });

  it("passes the token only via -c http.extraheader", () => {
    const args = fetchArgs(OPTIONS);
    const joined = args.join(" ");
    expect(joined).toContain("-c http.extraheader=AUTHORIZATION: basic ");
    expect(joined).not.toContain("ghs_test");
    expect(joined).not.toContain("@github.com");
    expect(joined).toContain(`core.hooksPath=${HOOKS_PATH}`);
  });

  it("sets hooksPath to /dev/null", () => {
    const { fetch } = checkoutSteps(OPTIONS);
    const hooksIndex = fetch.args.indexOf("-c");
    expect(fetch.args.slice(hooksIndex, hooksIndex + 2)).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
    ]);
  });

  it("returns GIT_LFS_SKIP_SMUDGE in the env", () => {
    expect(checkoutSteps(OPTIONS).env.GIT_LFS_SKIP_SMUDGE).toBe("1");
    expect(CHECKOUT_ENV.GIT_LFS_SKIP_SMUDGE).toBe("1");
  });

  it("never produces build or install commands", () => {
    const plan = checkoutSteps(OPTIONS);
    const steps = [plan.init, plan.remote, plan.fetch, plan.checkout];
    assertReadOnlySteps(steps);
    for (const step of steps) {
      for (const arg of step.args) {
        expect(["submodule", "npm", "pnpm", "install"]).not.toContain(arg);
      }
      expect(step.args.join(" ")).not.toContain("lfs install");
    }
    const joined = steps.map((step) => `${step.file} ${step.args.join(" ")}`).join("\n");
    expect(joined).not.toMatch(/hooksPath=(?!\/dev\/null)/);
  });

  it("rejects non-read-only steps", () => {
    expect(() => assertReadOnlySteps([{ file: "git", args: ["submodule", "update"] }])).toThrow();
    expect(() => assertReadOnlySteps([{ file: "npm", args: ["install"] }])).toThrow();
    expect(() =>
      assertReadOnlySteps([{ file: "git", args: ["-c", "core.hooksPath=/tmp/hooks", "fetch"] }]),
    ).toThrow();
  });
});

describe("runCheckoutPlan", () => {
  it("runs init, remote, fetch and checkout with a fake exec", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec: ExecFn = vi.fn(async (file: string, args: string[]) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const result = await runCheckoutPlan(OPTIONS, exec);
    expect(result).toEqual({ directory: "/tmp/hammer-head", headSha: "abc123", steps: 4 });
    expect(calls.map((call) => call.args[0])).toEqual(["init", "remote", "-c", "checkout"]);
    expect(calls[2]!.args).toContain("fetch");
    expect(exec).toHaveBeenCalledTimes(4);
  });
});
