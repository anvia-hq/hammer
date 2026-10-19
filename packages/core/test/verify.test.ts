import { describe, expect, it, vi } from "vitest";

import type { Finding } from "../src/agent/schema";
import {
  applyVerification,
  buildVerificationPrompt,
  VerificationResultSchema,
  verifyCostOk,
} from "../src/verify";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    path: "src/app.ts",
    line: 12,
    severity: "high",
    category: "correctness",
    title: "Null check missing",
    body: "Dereferences a possibly null value; guard before use.",
    confidence: 0.9,
    ...overrides,
  };
}

describe("buildVerificationPrompt", () => {
  it("includes finding ids and titles", () => {
    const prompt = buildVerificationPrompt({
      findings: [finding({ title: "First bug" }), finding({ title: "Second bug" })],
    });
    expect(prompt).toContain("f1");
    expect(prompt).toContain("First bug");
    expect(prompt).toContain("f2");
    expect(prompt).toContain("Second bug");
  });
});

describe("VerificationResultSchema", () => {
  it("accepts a valid payload and rejects out-of-range scores", () => {
    expect(VerificationResultSchema.safeParse({ scores: [{ id: "f1", score: 6 }] }).success).toBe(
      true,
    );
    expect(VerificationResultSchema.safeParse({ scores: [{ id: "f1", score: 11 }] }).success).toBe(
      false,
    );
  });

  it("rejects more than 100 entries", () => {
    const scores = Array.from({ length: 101 }, (_, i) => ({ id: `f${i + 1}`, score: 5 }));
    expect(VerificationResultSchema.safeParse({ scores }).success).toBe(false);
  });
});

describe("applyVerification", () => {
  it("returns findings unchanged without calling the verifier when verify is false", async () => {
    const runVerifier = vi.fn(async () => ({ scores: [] }));
    const input = [finding()];
    const result = await applyVerification({ findings: input, verify: false, runVerifier });
    expect(result.status).toBe("unverified_disabled");
    expect(result.findings).toBe(input);
    expect(result.dropped).toEqual([]);
    expect(runVerifier).not.toHaveBeenCalled();
  });

  it("drops scores below the threshold with reason", async () => {
    const result = await applyVerification({
      findings: [finding(), finding({ title: "Other" })],
      verifyThreshold: 6,
      runVerifier: async () => ({
        scores: [
          { id: "f1", score: 4 },
          { id: "f2", score: 8 },
        ],
      }),
    });
    expect(result.status).toBe("verified");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("Other");
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.reason).toBe("verify_below_threshold");
  });

  it("keeps scores at the threshold with original confidence", async () => {
    const result = await applyVerification({
      findings: [finding({ confidence: 0.7 })],
      verifyThreshold: 6,
      runVerifier: async () => ({ scores: [{ id: "f1", score: 6 }] }),
    });
    expect(result.status).toBe("verified");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.confidence).toBe(0.7);
  });

  it("applies relocatedLine within the same file", async () => {
    const result = await applyVerification({
      findings: [finding({ startLine: 10, line: 12 })],
      runVerifier: async () => ({ scores: [{ id: "f1", score: 9, relocatedLine: 11 }] }),
    });
    expect(result.status).toBe("verified");
    expect(result.findings[0]?.line).toBe(11);
    expect(result.findings[0]?.path).toBe("src/app.ts");
  });

  it("never moves a finding to another file when relocating", async () => {
    const result = await applyVerification({
      findings: [finding({ startLine: 10, line: 12 })],
      runVerifier: async () => ({ scores: [{ id: "f1", score: 9, relocatedLine: 99 }] }),
    });
    expect(result.status).toBe("verified");
    expect(result.findings[0]?.line).toBe(99);
    expect(result.findings[0]?.path).toBe("src/app.ts");
  });

  it("returns unverified and keeps all findings when the verifier throws", async () => {
    const input = [finding(), finding({ title: "Other" })];
    const result = await applyVerification({
      findings: input,
      runVerifier: async () => {
        throw new Error("model down");
      },
    });
    expect(result.status).toBe("unverified");
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.confidence).toBe(0.9);
    expect(result.dropped).toEqual([]);
    expect(result.note).toContain("model down");
  });

  it("repairs invalid output once when the retry is valid", async () => {
    const runVerifier = vi.fn(async (prompt: string) =>
      prompt.includes("did not match") ? { scores: [{ id: "f1", score: 7 }] } : { nope: true },
    );
    const result = await applyVerification({ findings: [finding()], runVerifier });
    expect(runVerifier).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("verified");
    expect(result.findings).toHaveLength(1);
  });

  it("returns unverified when output is invalid twice", async () => {
    const runVerifier = vi.fn(async () => ({ nope: true }));
    const result = await applyVerification({ findings: [finding()], runVerifier });
    expect(runVerifier).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("unverified");
    expect(result.findings).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });

  it("returns unverified with reason budget when canContinue is false", async () => {
    const runVerifier = vi.fn(async () => ({ scores: [{ id: "f1", score: 9 }] }));
    const result = await applyVerification({
      findings: [finding()],
      runVerifier,
      canContinue: () => false,
    });
    expect(result.status).toBe("unverified");
    expect(result.note).toBe("budget");
    expect(result.findings).toHaveLength(1);
    expect(runVerifier).not.toHaveBeenCalled();
  });
});

describe("verifyCostOk", () => {
  it("allows exactly 30 percent extra cost", () => {
    expect(verifyCostOk(1000, 300)).toBe(true);
    expect(verifyCostOk(1000, 301)).toBe(false);
  });
});
