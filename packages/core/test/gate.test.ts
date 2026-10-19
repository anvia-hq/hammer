import { describe, expect, it } from "vitest";

import { decideExitCode } from "../src/index";

describe("decideExitCode", () => {
  it('fail_on "none" never fails on findings', () => {
    const result = decideExitCode({
      failOn: "none",
      findings: [{ severity: "high" }, { severity: "medium" }, { severity: "low" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.exitCode).toBe(0);
  });

  it('fail_on "high" exits 1 with one high posted finding', () => {
    const result = decideExitCode({ failOn: "high", findings: [{ severity: "high" }] });
    expect(result).toMatchObject({ ok: true, exitCode: 1 });
  });

  it('fail_on "high" ignores medium and low findings', () => {
    const result = decideExitCode({
      failOn: "high",
      findings: [{ severity: "medium" }, { severity: "low" }],
    });
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
  });

  it('fail_on "medium" exits 1 for medium findings', () => {
    const result = decideExitCode({ failOn: "medium", findings: [{ severity: "medium" }] });
    expect(result).toMatchObject({ ok: true, exitCode: 1 });
  });

  it('fail_on "medium" exits 1 for high findings and 0 for low only', () => {
    expect(decideExitCode({ failOn: "medium", findings: [{ severity: "high" }] })).toMatchObject({
      ok: true,
      exitCode: 1,
    });
    expect(decideExitCode({ failOn: "medium", findings: [{ severity: "low" }] })).toMatchObject({
      ok: true,
      exitCode: 0,
    });
  });

  it("does not count findings the caller did not post", () => {
    const result = decideExitCode({ failOn: "high", findings: [] });
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
  });

  it("failOnError true with errored true exits 1", () => {
    const result = decideExitCode({
      failOn: "none",
      findings: [],
      failOnError: true,
      errored: true,
    });
    expect(result).toMatchObject({ ok: true, exitCode: 1 });
  });

  it("failOnError false with errored true exits 0", () => {
    const result = decideExitCode({
      failOn: "high",
      findings: [{ severity: "high" }],
      failOnError: false,
      errored: true,
    });
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
  });

  it("returns a coded error for invalid fail_on values", () => {
    const result = decideExitCode({ failOn: "critical", findings: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_fail_on");
      expect(result.message).toContain("critical");
    }
  });
});
