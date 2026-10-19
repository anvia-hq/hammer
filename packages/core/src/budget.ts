import { DEFAULT_CAPS } from "./config";

export const DEFAULT_MAX_TURNS = DEFAULT_CAPS.max_turns;

export type BudgetCapReason = "max_tokens" | "max_cost_usd";

export interface BudgetUsageInput {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  model?: string;
}

export type PricingFn = (model: string, usage: BudgetUsageInput) => number | null | undefined;

export interface CreateBudgetInput {
  maxTurns?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  pricing?: PricingFn;
}

export type BatchGate =
  | { ok: true; status: "ok" }
  | { ok: false; status: "partial"; reason: BudgetCapReason };

export interface BudgetSummary {
  partial: boolean;
  partialReason?: string;
  tokens: number;
  costUsd: number | null;
}

export interface Budget {
  readonly maxTurns: number;
  readonly maxTokens: number;
  readonly maxCostUsd: number;
  recordUsage(usage: BudgetUsageInput): void;
  recordCost(usd?: number): void;
  tokensUsed(): number;
  costUsd(): number | null;
  canStartBatch(): BatchGate;
  partialReason(): BudgetCapReason | undefined;
  summary(): BudgetSummary;
}

export function clampTurns(maxTurns?: number): number {
  if (maxTurns === undefined || !Number.isFinite(maxTurns)) return DEFAULT_MAX_TURNS;
  return Math.max(1, Math.floor(maxTurns));
}

function cleanCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function cleanCost(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function usageTokens(usage: BudgetUsageInput): number {
  if (usage.totalTokens !== undefined) return cleanCount(usage.totalTokens);
  return cleanCount(usage.inputTokens) + cleanCount(usage.outputTokens);
}

export function createBudget(input: CreateBudgetInput = {}): Budget {
  const maxTokens =
    input.maxTokens !== undefined &&
    Number.isFinite(input.maxTokens) &&
    (input.maxTokens as number) >= 0
      ? Math.floor(input.maxTokens as number)
      : DEFAULT_CAPS.max_tokens;
  const maxCostUsd =
    input.maxCostUsd !== undefined &&
    Number.isFinite(input.maxCostUsd) &&
    (input.maxCostUsd as number) >= 0
      ? (input.maxCostUsd as number)
      : DEFAULT_CAPS.max_cost_usd;
  const pricing = input.pricing;

  let tokens = 0;
  let pricedCost = 0;
  let directCost: number | null = null;
  let stopped: BudgetCapReason | undefined;

  const currentCost = (): number | null => {
    if (pricing === undefined && directCost === null) return null;
    return pricedCost + (directCost ?? 0);
  };

  const currentReason = (): BudgetCapReason | undefined => {
    if (tokens >= maxTokens) return "max_tokens";
    const cost = currentCost();
    if (cost !== null && cost >= maxCostUsd) return "max_cost_usd";
    return undefined;
  };

  const latchStopped = (): BudgetCapReason | undefined => {
    if (stopped === undefined) stopped = currentReason();
    return stopped;
  };

  return {
    maxTurns: clampTurns(input.maxTurns),
    maxTokens,
    maxCostUsd,
    recordUsage(usage: BudgetUsageInput): void {
      tokens += usageTokens(usage);
      if (pricing !== undefined) {
        const quoted = cleanCost(pricing(usage.model ?? "", usage));
        if (quoted !== null) pricedCost += quoted;
      }
      latchStopped();
    },
    recordCost(usd?: number): void {
      const amount = cleanCost(usd);
      if (amount === null) return;
      directCost = (directCost ?? 0) + amount;
      latchStopped();
    },
    tokensUsed(): number {
      return tokens;
    },
    costUsd(): number | null {
      return currentCost();
    },
    canStartBatch(): BatchGate {
      const reason = latchStopped() ?? currentReason();
      if (reason === undefined) return { ok: true, status: "ok" };
      return { ok: false, status: "partial", reason };
    },
    partialReason(): BudgetCapReason | undefined {
      return latchStopped() ?? currentReason();
    },
    summary(): BudgetSummary {
      const reason = latchStopped() ?? currentReason();
      const result: BudgetSummary = {
        partial: reason !== undefined,
        tokens,
        costUsd: currentCost(),
      };
      if (reason !== undefined) result.partialReason = reason;
      return result;
    },
  };
}
