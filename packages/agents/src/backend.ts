import type { z } from "zod";

import type { ReviewBatch } from "@anvia/hammer-core";
import type { SinglePassSuccess, SinglePassUsage } from "./run";
import type { SkillSet } from "./skills";
import type { StreamedTextSink } from "./stream";

export interface ReviewerToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

export interface ReviewConversationOptions {
  instructions: string;
  tools: ReviewerToolDefinition[];
  maxTurns: number;
  maxTokens?: number | undefined;
  reasoningEffort?: string | undefined;
  outputSchema?: z.ZodType<ReviewBatch> | undefined;
  onText?: StreamedTextSink | undefined;
  beginFinalize?: (() => void) | undefined;
  signal?: AbortSignal | undefined;
  startGuard?: (() => void) | undefined;
  onUsage?: ((usage: SinglePassUsage) => void) | undefined;
  skills?: SkillSet | undefined;
}

export interface TurnOutcome {
  text: string;
  usage: SinglePassUsage;
  finishReason?: string;
}

export interface SalvageAttempt {
  text: string;
  usage: SinglePassUsage;
  stop: string;
}

export interface SalvageHooks {
  begin?: () => void;
  accept: (attempt: SalvageAttempt) => SinglePassSuccess | null;
}

export interface ReviewConversation {
  turn(prompt: string): Promise<TurnOutcome | null>;
  salvage(error: unknown, hooks: SalvageHooks): Promise<SinglePassSuccess | null>;
}

export interface ReviewBackend {
  readonly id: string;
  createConversation(options: ReviewConversationOptions): ReviewConversation;
}

export type { SinglePassSuccess, SinglePassUsage };

export const ZERO_USAGE: SinglePassUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

export function toUsage(raw: unknown): SinglePassUsage {
  if (typeof raw !== "object" || raw === null) return { ...ZERO_USAGE };
  const record = raw as Record<string, unknown>;
  const pick = (key: string): number => {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : 0;
  };
  const inputTokens = pick("inputTokens");
  const outputTokens = pick("outputTokens");
  const totalTokens =
    record["totalTokens"] === undefined ? inputTokens + outputTokens : pick("totalTokens");
  return { inputTokens, outputTokens, totalTokens };
}

export function addUsage(left: SinglePassUsage, right: SinglePassUsage): SinglePassUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}
