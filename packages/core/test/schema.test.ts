import { describe, expect, it, vi } from "vitest";

import {
  buildRepairPrompt,
  type Finding,
  type ReviewBatch,
  ReviewBatchSchema,
  runWithRepair,
  validateBatchOutput,
} from "../src/schema";

function validFinding(overrides: Partial<Finding> = {}): Finding {
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

function validBatch(overrides: Partial<ReviewBatch> = {}): ReviewBatch {
  return {
    summary: "Adds null handling to the login flow.",
    findings: [validFinding()],
    generalNotes: ["Looks solid overall."],
    ...overrides,
  };
}

describe("validateBatchOutput", () => {
  it("passes a valid batch", () => {
    const result = validateBatchOutput(validBatch());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.summary).toContain("null handling");
  });

  it("rejects a title of 121 chars", () => {
    expect(
      validateBatchOutput(validBatch({ findings: [validFinding({ title: "t".repeat(121) })] })).ok,
    ).toBe(false);
  });

  it("rejects a body of 1501 chars", () => {
    expect(
      validateBatchOutput(validBatch({ findings: [validFinding({ body: "b".repeat(1501) })] })).ok,
    ).toBe(false);
  });

  it("rejects 26 findings", () => {
    const findings = Array.from({ length: 26 }, (_, i) =>
      validFinding({ title: `Finding ${i}`, line: i + 1 }),
    );
    const result = validateBatchOutput(validBatch({ findings }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });

  it("rejects 6 general notes", () => {
    const result = validateBatchOutput(
      validBatch({ generalNotes: ["n1", "n2", "n3", "n4", "n5", "n6"] }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a summary of 601 chars", () => {
    expect(validateBatchOutput(validBatch({ summary: "s".repeat(601) })).ok).toBe(false);
  });

  it("rejects confidence above 1", () => {
    expect(
      validateBatchOutput(validBatch({ findings: [validFinding({ confidence: 1.1 })] })).ok,
    ).toBe(false);
  });

  it("rejects a bad severity", () => {
    const raw = { ...validBatch(), findings: [{ ...validFinding(), severity: "critical" }] };
    const result = validateBatchOutput(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toContain("severity");
  });

  it("rejects a bad category", () => {
    const raw = { ...validBatch(), findings: [{ ...validFinding(), category: "style" }] };
    const result = validateBatchOutput(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toContain("category");
  });

  it("allows optional fields to be omitted", () => {
    const {
      startLine: _start,
      suggestion: _sug,
      ruleId: _rule,
      ...rest
    } = validFinding({
      startLine: 4,
      suggestion: "x",
      ruleId: "r1",
    });
    expect(validateBatchOutput(validBatch({ findings: [rest] })).ok).toBe(true);
    expect(validateBatchOutput(validBatch({ generalNotes: [] })).ok).toBe(true);
  });

  it("parses JSON string input", () => {
    const result = validateBatchOutput(JSON.stringify(validBatch()));
    expect(result.ok).toBe(true);
  });

  it("returns an issue for invalid JSON strings", () => {
    const result = validateBatchOutput("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBe(1);
      expect(result.issues[0]?.path).toBe("(root)");
    }
  });

  it("returns readable path and message per issue without throwing", () => {
    const result = validateBatchOutput({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const issue of result.issues) {
        expect(typeof issue.path).toBe("string");
        expect(typeof issue.message).toBe("string");
      }
    }
  });
});

describe("ReviewBatchSchema", () => {
  it("matches the spec shape", () => {
    expect(Object.keys(ReviewBatchSchema.shape).sort()).toEqual([
      "changes",
      "findings",
      "generalNotes",
      "summary",
    ]);
  });
});

describe("details and changes", () => {
  it("accepts a bounded details string and change bullets", () => {
    const result = validateBatchOutput(
      validBatch({
        changes: ["Extracted retry logic into one module"],
        findings: [validFinding({ details: "- `src/app.ts:12` — unguarded read" })],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects oversized details and too many changes", () => {
    expect(
      validateBatchOutput(validBatch({ findings: [validFinding({ details: "x".repeat(1201) })] }))
        .ok,
    ).toBe(false);
    expect(validateBatchOutput(validBatch({ changes: Array(7).fill("Changed a thing") })).ok).toBe(
      false,
    );
  });
});

describe("buildRepairPrompt", () => {
  it("includes the original prompt and each issue", () => {
    const prompt = buildRepairPrompt("original prompt", [
      { path: "findings.0.title", message: "Too long" },
    ]);
    expect(prompt).toContain("original prompt");
    expect(prompt).toContain("findings.0.title");
    expect(prompt).toContain("Too long");
  });
});

describe("runWithRepair", () => {
  it("uses the first result when valid, calling generate once", async () => {
    const generate = vi.fn(() => validBatch());
    const result = await runWithRepair({ prompt: "review this", generate });
    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith("review this");
  });

  it("repairs once and uses the second result, with issue text in the repair prompt", async () => {
    const bad = validBatch({ summary: "s".repeat(601) });
    const good = validBatch();
    const prompts: string[] = [];
    const generate = vi.fn((prompt: string) => {
      prompts.push(prompt);
      return prompts.length === 1 ? bad : good;
    });
    const result = await runWithRepair({ prompt: "review this", generate });
    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(prompts[0]).toBe("review this");
    expect(prompts[1]).not.toBe("review this");
    expect(prompts[1]).toContain("summary");
  });

  it("returns schema_violation after a failed repair without throwing", async () => {
    const bad = validBatch({ summary: "s".repeat(601) });
    const generate = vi.fn(() => bad);
    const result = await runWithRepair({ prompt: "review this", generate });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, error: "schema_violation" });
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });

  it("returns a coded generate_failed failure when generate throws", async () => {
    const generate = vi.fn(() => {
      throw new Error("model unavailable");
    });
    const result = await runWithRepair({ prompt: "review this", generate });
    expect(result).toMatchObject({ ok: false, error: "generate_failed" });
    if (!result.ok) expect(result.issues[0]?.message).toContain("model unavailable");
  });
});
