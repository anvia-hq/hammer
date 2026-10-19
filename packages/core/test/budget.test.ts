import { describe, expect, it } from "vitest";

import { clampTurns, createBudget } from "../src/budget";

describe("createBudget tokens", () => {
  it("sums input and output tokens across recordUsage calls", () => {
    const budget = createBudget({ maxTokens: 400000, maxCostUsd: 1 });
    budget.recordUsage({ inputTokens: 100, outputTokens: 50 });
    budget.recordUsage({ inputTokens: 200, outputTokens: 25 });
    expect(budget.tokensUsed()).toBe(375);
    expect(budget.canStartBatch()).toEqual({ ok: true, status: "ok" });
  });

  it("uses totalTokens when given", () => {
    const budget = createBudget({});
    budget.recordUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 120 });
    expect(budget.tokensUsed()).toBe(120);
  });

  it("returns not ok with max_tokens once tokensUsed reaches maxTokens", () => {
    const budget = createBudget({ maxTokens: 100 });
    budget.recordUsage({ inputTokens: 60, outputTokens: 40 });
    expect(budget.tokensUsed()).toBe(100);
    expect(budget.canStartBatch()).toEqual({
      ok: false,
      status: "partial",
      reason: "max_tokens",
    });
  });

  it("keeps earlier usage counted after the cap is hit", () => {
    const budget = createBudget({ maxTokens: 100 });
    budget.recordUsage({ inputTokens: 90, outputTokens: 0 });
    budget.recordUsage({ inputTokens: 50, outputTokens: 0 });
    expect(budget.tokensUsed()).toBe(140);
    expect(budget.canStartBatch().ok).toBe(false);
    expect(budget.partialReason()).toBe("max_tokens");
  });
});

describe("createBudget cost", () => {
  it("returns max_cost_usd with injected pricing", () => {
    const budget = createBudget({ maxCostUsd: 1, pricing: () => 0.6 });
    budget.recordUsage({ inputTokens: 10, outputTokens: 5, model: "anthropic/x" });
    expect(budget.costUsd()).toBeCloseTo(0.6, 9);
    expect(budget.canStartBatch()).toEqual({ ok: true, status: "ok" });
    budget.recordUsage({ inputTokens: 10, outputTokens: 5, model: "anthropic/x" });
    expect(budget.costUsd()).toBeCloseTo(1.2, 9);
    expect(budget.canStartBatch()).toEqual({
      ok: false,
      status: "partial",
      reason: "max_cost_usd",
    });
  });

  it("accumulates direct cost from recordCost", () => {
    const budget = createBudget({ maxCostUsd: 1, pricing: () => null });
    budget.recordCost(0.4);
    budget.recordCost(0.7);
    expect(budget.costUsd()).toBeCloseTo(1.1, 9);
    expect(budget.partialReason()).toBe("max_cost_usd");
  });

  it("never triggers the cost cap without pricing", () => {
    const budget = createBudget({ maxCostUsd: 1 });
    budget.recordUsage({ inputTokens: 100000, outputTokens: 50000 });
    expect(budget.costUsd()).toBeNull();
    expect(budget.canStartBatch()).toEqual({ ok: true, status: "ok" });
  });
});

describe("maxTurns", () => {
  it("defaults to 12 and clamps 0 or negative to 1", () => {
    expect(clampTurns()).toBe(12);
    expect(clampTurns(undefined)).toBe(12);
    expect(clampTurns(0)).toBe(1);
    expect(clampTurns(-3)).toBe(1);
    expect(clampTurns(12)).toBe(12);
    expect(createBudget({}).maxTurns).toBe(12);
    expect(createBudget({ maxTurns: 0 }).maxTurns).toBe(1);
  });
});

describe("partial reason and summary", () => {
  it("returns the first reason that stopped the run", () => {
    const budget = createBudget({ maxTokens: 100, maxCostUsd: 10, pricing: () => 0 });
    expect(budget.partialReason()).toBeUndefined();
    budget.recordUsage({ inputTokens: 100, outputTokens: 0 });
    expect(budget.partialReason()).toBe("max_tokens");
    budget.recordCost(50);
    expect(budget.partialReason()).toBe("max_tokens");
  });

  it("produces summary fields matching renderJobSummaryMarkdown", () => {
    const budget = createBudget({ maxTokens: 100, maxCostUsd: 1 });
    const clean = budget.summary();
    expect(clean).toEqual({ partial: false, tokens: 0, costUsd: null });
    expect(clean.partialReason).toBeUndefined();
    budget.recordUsage({ inputTokens: 60, outputTokens: 40 });
    const capped = budget.summary();
    expect(capped.partial).toBe(true);
    expect(capped.partialReason).toBe("max_tokens");
    expect(capped.tokens).toBe(100);
    expect(capped.costUsd).toBeNull();
  });
});
