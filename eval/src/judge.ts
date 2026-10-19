import type { Finding } from "@anvia/hammer-core";

import type { EvalCase } from "./cases";

export interface JudgeInput {
  finding: Finding;
  case: EvalCase;
}

export type JudgeVerdict = "valid" | "invalid";

export interface JudgeResult {
  verdict: JudgeVerdict;
  reason: string;
}

export interface LlmJudge {
  judge(input: JudgeInput): Promise<JudgeResult>;
}

export function createLlmJudge(): LlmJudge {
  throw new Error("TODO: wire the LLM judge to a different model from the reviewer (PRD §11)");
}
