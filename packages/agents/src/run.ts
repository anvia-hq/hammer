import { AgentStructuredOutputError } from "@anvia/core/agent";
import type { CompletionModel, Message } from "@anvia/core/completion";

import {
  buildRepairPrompt,
  DEFAULT_MAX_TURNS,
  ReviewBatchSchema,
  runWithRepair,
  salvageTruncatedReview,
  validateBatchOutput,
  type PullFileEntry,
  type ReviewBatch,
} from "@anvia/hammer-core";
import { toAnviaTools, createAnviaBackend } from "./anvia-backend";
import type {
  ReviewBackend,
  ReviewConversation,
  ReviewConversationOptions,
  TurnOutcome,
} from "./backend";
import { addUsage, ZERO_USAGE } from "./backend";
import type { PrDiff, PrMeta } from "./diff";
import { parseModelRefWithBase } from "./model";
import type { BuildReviewPromptInput } from "./prompt";
import { buildReviewPrompt, REVIEW_INSTRUCTIONS } from "./prompt";
import {
  buildReviewerToolDefinitions,
  type DiscussionSource,
  type ReviewerToolOptions,
} from "./reviewer-tools";
import { SKILL_REVIEW_INSTRUCTIONS, type SkillSet } from "./skills";
import type { StreamedTextSink } from "./stream";
import type { PrDiscussionInput } from "./tools";

export type SinglePassErrorCode =
  | "invalid_model"
  | "unsupported_provider"
  | "missing_base_url"
  | "schema_violation"
  | "generate_failed"
  | "unexpected_outcome";

export interface SinglePassUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SinglePassFailure {
  ok: false;
  error: SinglePassErrorCode;
  issues: Array<{ path: string; message: string }>;
  finishReason?: string;
  outputChars?: number;
  repairAttempted?: boolean;
}

export interface SinglePassSuccess {
  ok: true;
  batch: ReviewBatch;
  usage: SinglePassUsage;
  partial?: boolean;
  note?: string;
  finishReason?: string;
  outputChars?: number;
}

export type SinglePassResult = SinglePassSuccess | SinglePassFailure;

export interface SinglePassRunInput extends BuildReviewPromptInput {
  model: string;
  baseUrl?: string;
}

export interface SinglePassRunOptions {
  pr?: Omit<PrMeta, "title">;
  diff?: PrDiff;
  checkoutRoot?: string;
  files?: PullFileEntry[];
  discussion?: PrDiscussionInput | DiscussionSource;
  generate?: (prompt: string) => unknown | Promise<unknown>;
  model?: CompletionModel;
  backend?: ReviewBackend;
  maxTurns?: number;
  reasoningEffort?: string;
  onToolCall?: (name: string, detail: string) => void;
  skills?: SkillSet;
  onText?: StreamedTextSink;
  isNearBudget?: () => boolean;
  startGuard?: () => void;
  onUsage?: (usage: SinglePassUsage) => void;
  getHistory?: () => Message[];
  beginFinalize?: () => void;
}

const REVIEW_MAX_TOKENS = 16384;

function failure(error: SinglePassErrorCode, message: string, path = "(run)"): SinglePassFailure {
  return { ok: false, error, issues: [{ path, message }] };
}

function structuredFailure(error: unknown): SinglePassFailure {
  const structured =
    error instanceof AgentStructuredOutputError
      ? error
      : error instanceof Error && error.cause instanceof AgentStructuredOutputError
        ? error.cause
        : null;
  const message = error instanceof Error ? error.message : String(error);
  const finish =
    structured !== null ? (structured.finishReason ?? structured.providerFinishReason) : undefined;
  const chars = structured !== null ? structured.outputLength : undefined;
  return {
    ok: false,
    error: structured !== null ? "schema_violation" : "generate_failed",
    issues: [{ path: "(generate)", message }],
    ...(finish !== undefined ? { finishReason: finish } : {}),
    ...(chars !== undefined ? { outputChars: chars } : {}),
  };
}

export function buildReviewerTools(options: ReviewerToolOptions) {
  return toAnviaTools(buildReviewerToolDefinitions(options));
}

function acceptedSalvage(attempt: {
  text: string;
  usage: SinglePassUsage;
  stop: string;
}): SinglePassSuccess | null {
  const valid = validateBatchOutput(attempt.text);
  if (valid.ok)
    return {
      ok: true,
      batch: valid.value,
      usage: attempt.usage,
      partial: true,
      note: `${attempt.stop}; review is partial`,
    };
  const salvaged = salvageTruncatedReview(attempt.text);
  if (salvaged !== null)
    return {
      ok: true,
      batch: salvaged.batch,
      usage: attempt.usage,
      partial: true,
      note: `${attempt.stop}; review is partial (${salvaged.salvagedCount} findings salvaged)`,
    };
  return null;
}

export async function runSinglePassReview(
  input: SinglePassRunInput,
  options: SinglePassRunOptions = {},
): Promise<SinglePassResult> {
  if (options.backend === undefined) {
    const parsed = parseModelRefWithBase(input.model, input.baseUrl);
    if (!parsed.ok) {
      const issue = parsed.issues[0];
      const code =
        issue?.code === "unsupported_provider"
          ? "unsupported_provider"
          : issue?.code === "missing_base_url"
            ? "missing_base_url"
            : "invalid_model";
      return {
        ok: false,
        error: code,
        issues: parsed.issues.map((entry) => ({ path: "(model)", message: entry.message })),
      };
    }
  }
  const reviewed = buildReviewPrompt(input);
  if (options.generate !== undefined) {
    const seen: string[] = [];
    const generate = async (prompt: string): Promise<unknown> => {
      const raw = await options.generate!(prompt);
      if (typeof raw === "string") seen.push(raw);
      return raw;
    };
    const repaired = await runWithRepair({ prompt: reviewed.prompt, generate });
    if (!repaired.ok) {
      const last = seen.at(-1);
      if (last !== undefined && !last.trim().endsWith("}")) {
        const salvaged = salvageTruncatedReview(last);
        if (salvaged !== null) {
          return {
            ok: true,
            batch: salvaged.batch,
            usage: { ...ZERO_USAGE },
            partial: true,
            note: `truncated_output salvaged ${salvaged.salvagedCount} findings (${salvaged.droppedCount} dropped)`,
            outputChars: last.length,
          };
        }
      }
      return {
        ok: false,
        error: repaired.error === "generate_failed" ? "generate_failed" : "schema_violation",
        issues: repaired.issues,
        ...(last !== undefined ? { outputChars: last.length } : {}),
      };
    }
    return { ok: true, batch: repaired.value, usage: { ...ZERO_USAGE } };
  }
  const backend =
    options.backend ??
    (options.model === undefined
      ? undefined
      : createAnviaBackend({
          model: options.model,
          ...(options.getHistory !== undefined ? { getHistory: options.getHistory } : {}),
        }));
  if (backend === undefined) {
    return failure("generate_failed", "No model adapter provided for the single-pass run.");
  }
  const definitions = buildReviewerToolDefinitions({
    checkoutRoot: options.checkoutRoot ?? "",
    files: options.files ?? input.files,
    fileContents: input.fileContents ?? {},
    pr: { title: input.title, ...options.pr },
    ...(options.diff ? { diff: options.diff } : {}),
    discussion: options.discussion,
    ...(options.onToolCall ? { onToolCall: options.onToolCall } : {}),
    ...(options.isNearBudget ? { isNearBudget: options.isNearBudget } : {}),
  });
  const conversationOptions: ReviewConversationOptions = {
    instructions: options.skills
      ? `${REVIEW_INSTRUCTIONS}\n${SKILL_REVIEW_INSTRUCTIONS}`
      : REVIEW_INSTRUCTIONS,
    tools: definitions,
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    maxTokens: REVIEW_MAX_TOKENS,
    outputSchema: ReviewBatchSchema,
    ...(options.onText ? { onText: options.onText } : {}),
    ...(options.beginFinalize ? { beginFinalize: options.beginFinalize } : {}),
    ...(options.startGuard ? { startGuard: options.startGuard } : {}),
    ...(options.onUsage ? { onUsage: options.onUsage } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.skills ? { skills: options.skills } : {}),
  };
  let conversation: ReviewConversation;
  try {
    conversation = backend.createConversation(conversationOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure("generate_failed", message, "(model)");
  }
  let outcome: TurnOutcome | null;
  try {
    outcome = await conversation.turn(reviewed.prompt);
  } catch (error) {
    const failed = structuredFailure(error);
    if (failed.error !== "generate_failed") return failed;
    const salvaged = await conversation.salvage(error, {
      ...(options.beginFinalize ? { begin: options.beginFinalize } : {}),
      accept: acceptedSalvage,
    });
    return salvaged ?? failed;
  }
  if (outcome === null) {
    return failure("unexpected_outcome", "Agent run ended without a response.");
  }
  let usage = outcome.usage;
  const finishReason = outcome.finishReason;
  const outputChars = outcome.text.length;
  const first = validateBatchOutput(outcome.text);
  if (first.ok) {
    return { ok: true, batch: first.value, usage };
  }
  const truncatedLike = finishReason === "length" || !outcome.text.trim().endsWith("}");
  if (truncatedLike) {
    const salvaged = salvageTruncatedReview(outcome.text);
    if (salvaged !== null) {
      return {
        ok: true,
        batch: salvaged.batch,
        usage,
        partial: true,
        note: `truncated_output salvaged ${salvaged.salvagedCount} findings (${salvaged.droppedCount} dropped)`,
        ...(finishReason !== undefined ? { finishReason } : {}),
        outputChars,
      };
    }
  }
  let repairAttempted = false;
  let repairedOutcome: TurnOutcome | null;
  try {
    repairAttempted = true;
    repairedOutcome = await conversation.turn(buildRepairPrompt(reviewed.prompt, first.issues));
  } catch (error) {
    return structuredFailure(error);
  }
  if (repairedOutcome === null) {
    return failure(
      "unexpected_outcome",
      'Agent repair run ended with "no response" instead of a response.',
    );
  }
  usage = addUsage(usage, repairedOutcome.usage);
  const second = validateBatchOutput(repairedOutcome.text);
  if (!second.ok) {
    const repairReason = repairedOutcome.finishReason;
    const repairChars = repairedOutcome.text.length;
    const repairTruncatedLike =
      repairReason === "length" || !repairedOutcome.text.trim().endsWith("}");
    if (repairTruncatedLike) {
      const salvaged = salvageTruncatedReview(repairedOutcome.text);
      if (salvaged !== null) {
        return {
          ok: true,
          batch: salvaged.batch,
          usage,
          partial: true,
          note: `truncated_output salvaged ${salvaged.salvagedCount} findings (${salvaged.droppedCount} dropped)`,
          ...(repairReason !== undefined ? { finishReason: repairReason } : {}),
          outputChars: repairChars,
        };
      }
    }
    return {
      ok: false,
      error: "schema_violation",
      issues: second.issues,
      ...(repairReason !== undefined ? { finishReason: repairReason } : {}),
      outputChars: repairChars,
      ...(repairAttempted ? { repairAttempted: true as const } : {}),
    };
  }
  return { ok: true, batch: second.value, usage };
}
