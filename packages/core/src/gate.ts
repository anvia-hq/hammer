export type GateFailOn = "none" | "high" | "medium";

export type GateSeverity = "high" | "medium" | "low";

export type GateErrorCode = "invalid_fail_on";

export interface GateFinding {
  severity: GateSeverity;
}

export interface DecideExitCodeInput {
  failOn: string;
  findings: GateFinding[];
  failOnError?: boolean;
  errored?: boolean;
}

export type DecideExitCodeResult =
  | { ok: true; exitCode: 0 | 1; reason: string }
  | { ok: false; error: GateErrorCode; message: string };

const VALID_FAIL_ON: ReadonlySet<string> = new Set(["none", "high", "medium"]);

export function decideExitCode(input: DecideExitCodeInput): DecideExitCodeResult {
  if (!VALID_FAIL_ON.has(input.failOn)) {
    return {
      ok: false,
      error: "invalid_fail_on",
      message: `Invalid fail_on ${JSON.stringify(input.failOn)}: expected one of "none", "high", "medium".`,
    };
  }
  const failOn = input.failOn as GateFailOn;
  const errored = input.errored ?? false;
  const failOnError = input.failOnError ?? false;
  if (errored && failOnError) {
    return { ok: true, exitCode: 1, reason: "action errored and fail_on_error is true" };
  }
  if (errored) {
    return { ok: true, exitCode: 0, reason: "action errored but fail_on_error is false" };
  }
  const high = input.findings.filter((finding) => finding.severity === "high").length;
  if (failOn === "none") {
    return {
      ok: true,
      exitCode: 0,
      reason: 'fail_on is "none", findings do not affect the exit code',
    };
  }
  if (failOn === "high") {
    if (high > 0) {
      return {
        ok: true,
        exitCode: 1,
        reason: `fail_on "high" matched ${high} high finding${high === 1 ? "" : "s"} posted`,
      };
    }
    return { ok: true, exitCode: 0, reason: 'fail_on "high": no high findings posted' };
  }
  const gated = input.findings.filter(
    (finding) => finding.severity === "high" || finding.severity === "medium",
  ).length;
  if (gated > 0) {
    return {
      ok: true,
      exitCode: 1,
      reason: `fail_on "medium" matched ${gated} high/medium finding${gated === 1 ? "" : "s"} posted`,
    };
  }
  return { ok: true, exitCode: 0, reason: 'fail_on "medium": no high or medium findings posted' };
}
