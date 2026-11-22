import type {
  ModelUsage,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultError,
  SDKResultMessage,
  SDKResultSuccess,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { ZERO_USAGE, type SinglePassUsage, type TurnOutcome } from "../backend";
import { createTextStreamer } from "../stream";
import type { TranscriptEntry } from "../transcript";

export type ClaudeSdkErrorCode =
  | "authentication"
  | "turn_limit"
  | "budget"
  | "structured_output"
  | "execution"
  | "process";

export class ClaudeSdkError extends Error {
  readonly code: ClaudeSdkErrorCode;

  constructor(code: ClaudeSdkErrorCode, message: string) {
    super(message);
    this.name = "ClaudeSdkError";
    this.code = code;
  }
}

// Only the CLI's own authentication wording counts. A bare "401" or "login" also appears in
// ordinary runtime errors (a stack trace at "a.ts:401"), and those must keep their own message.
const AUTH_PATTERN =
  /failed to authenticate|authentication_failed|oauth_org_not_allowed|invalid api key|invalid bearer token|oauth access token is invalid|oauth token (?:is )?(?:invalid|expired)|not logged in|please run \/login|claude setup-token/i;

export function isClaudeSdkError(error: unknown): error is ClaudeSdkError {
  return error instanceof ClaudeSdkError;
}

function authenticationError(detail: string): ClaudeSdkError {
  const reason = detail.replace(/[.\s]+$/, "");
  return new ClaudeSdkError(
    "authentication",
    `Claude rejected the subscription token${reason === "" ? "" : `: ${reason}`}. Create a new one with "claude setup-token" and pass it as the oauth-token input (or the CLAUDE_CODE_OAUTH_TOKEN secret); it must belong to a Pro, Max, Team or Enterprise plan.`,
  );
}

export function describeResultText(text: string): ClaudeSdkError {
  const detail = text.trim().slice(0, 600);
  if (AUTH_PATTERN.test(detail)) return authenticationError(detail);
  return new ClaudeSdkError("execution", `Claude Code returned an error result: ${detail}`);
}

export function describeResultError(result: SDKResultError, maxTurns: number): ClaudeSdkError {
  const detail = result.errors
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("; ")
    .slice(0, 600);
  if (AUTH_PATTERN.test(detail)) return authenticationError(detail);
  if (result.subtype === "error_max_turns") {
    return new ClaudeSdkError(
      "turn_limit",
      `Claude stopped at the ${maxTurns}-turn limit (error_max_turns). Raise max_turns, lower shard_tokens so each shard is smaller, or narrow the review with the include input.`,
    );
  }
  if (result.subtype === "error_max_budget_usd") {
    return new ClaudeSdkError(
      "budget",
      "Claude stopped at the session budget (error_max_budget_usd).",
    );
  }
  if (result.subtype === "error_max_structured_output_retries") {
    return new ClaudeSdkError(
      "structured_output",
      `Claude could not answer with JSON matching Hammer's review schema (error_max_structured_output_retries)${detail === "" ? "." : `: ${detail}`}`,
    );
  }
  return new ClaudeSdkError(
    "execution",
    `Claude Code reported an error (${result.subtype})${detail === "" ? "." : `: ${detail}`}`,
  );
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

// Cached prompt tokens are input the run paid for too, so the run budget and the tokens
// output count them beside the fresh input tokens.
function addModelUsage(usage: SinglePassUsage, entry: ModelUsage): void {
  usage.inputTokens +=
    tokenCount(entry.inputTokens) +
    tokenCount(entry.cacheReadInputTokens) +
    tokenCount(entry.cacheCreationInputTokens);
  usage.outputTokens += tokenCount(entry.outputTokens);
}

// A result without modelUsage reports the API's own usage, whose fields are snake_case.
function addApiUsage(usage: SinglePassUsage, raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const record = raw as Record<string, unknown>;
  usage.inputTokens +=
    tokenCount(record["input_tokens"]) +
    tokenCount(record["cache_read_input_tokens"]) +
    tokenCount(record["cache_creation_input_tokens"]);
  usage.outputTokens += tokenCount(record["output_tokens"]);
}

export function resultUsage(result: SDKResultMessage): SinglePassUsage {
  const usage = { ...ZERO_USAGE };
  const modelUsage = result.modelUsage;
  const entries =
    typeof modelUsage === "object" && modelUsage !== null ? Object.values(modelUsage) : [];
  if (entries.length > 0) {
    for (const entry of entries) addModelUsage(usage, entry);
  } else {
    addApiUsage(usage, result.usage);
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return usage;
}

export function resultText(result: SDKResultSuccess): string {
  if (result.structured_output !== undefined && result.structured_output !== null) {
    return JSON.stringify(result.structured_output);
  }
  return result.result;
}

function assistantText(message: SDKAssistantMessage): string {
  const parts: string[] = [];
  for (const block of message.message.content) {
    if (typeof block !== "object" || block === null) continue;
    const typed = block as { type?: string; text?: string };
    if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
  }
  return parts.join("\n").trim();
}

function assistantToolCalls(message: SDKAssistantMessage): string[] {
  const calls: string[] = [];
  for (const block of message.message.content) {
    if (typeof block !== "object" || block === null) continue;
    const typed = block as { type?: string; name?: string; input?: unknown };
    if (typed.type === "tool_use" && typeof typed.name === "string")
      calls.push(`${typed.name} ${JSON.stringify(typed.input ?? {})}`);
  }
  return calls;
}

function toolResultText(message: SDKUserMessage): string {
  const content = message.message.content;
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const typed = block as { type?: string; content?: unknown };
    if (typed.type !== "tool_result") continue;
    const inner = typed.content;
    if (typeof inner === "string") parts.push(inner);
    else if (Array.isArray(inner)) {
      for (const entry of inner) {
        if (typeof entry === "object" && entry !== null) {
          const text = (entry as { text?: unknown }).text;
          if (typeof text === "string") parts.push(text);
        }
      }
    }
  }
  return parts.join("\n");
}

export type { TranscriptEntry };

interface StreamEventLike {
  type?: string;
  content_block?: { type?: string };
  delta?: { type?: string; text?: string; thinking?: string };
}

export interface TurnCollector {
  push(message: SDKMessage): void;
  outcome(maxTurns: number): TurnOutcome;
  transcript(): TranscriptEntry[];
}

export function createTurnCollector(options: {
  onText?: ((kind: "text" | "reasoning", text: string) => void) | undefined;
  transcript: TranscriptEntry[];
}): TurnCollector {
  const streamer = options.onText === undefined ? undefined : createTextStreamer(options.onText);
  let turn = 0;
  let result: SDKResultMessage | undefined;
  return {
    push(message) {
      if (message.type === "stream_event" && streamer !== undefined) {
        const event = (message as { event?: StreamEventLike }).event;
        if (event === undefined) return;
        if (event.type === "message_start") {
          if (turn > 0) streamer.turnEnd(turn - 1);
          turn += 1;
          return;
        }
        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          streamer.toolCall(turn);
          return;
        }
        if (event.type === "content_block_delta") {
          if (event.delta?.type === "text_delta" && typeof event.delta.text === "string")
            streamer.delta("text", turn, event.delta.text);
          else if (
            event.delta?.type === "thinking_delta" &&
            typeof event.delta.thinking === "string"
          )
            streamer.delta("reasoning", turn, event.delta.thinking);
        }
        return;
      }
      if (message.type === "assistant") {
        const text = assistantText(message);
        if (text !== "") options.transcript.push({ role: "assistant", text });
        for (const call of assistantToolCalls(message))
          options.transcript.push({ role: "assistant", text: `Tool call: ${call}` });
        return;
      }
      if (message.type === "user") {
        const text = toolResultText(message);
        if (text !== "") options.transcript.push({ role: "tool", text });
        return;
      }
      if (message.type === "result") {
        result = message;
        if (streamer !== undefined) streamer.end();
      }
    },
    outcome(maxTurns) {
      if (result === undefined)
        throw new ClaudeSdkError("process", "Claude Code ended without a result for this turn.");
      if (result.subtype !== "success") throw describeResultError(result, maxTurns);
      if (result.is_error) throw describeResultText(result.result);
      const stopReason = result.stop_reason;
      const finishReason = stopReason === "max_tokens" ? "length" : (stopReason ?? undefined);
      const outcome: TurnOutcome = {
        text: resultText(result),
        usage: resultUsage(result),
        ...(finishReason !== undefined ? { finishReason } : {}),
      };
      return outcome;
    },
    transcript() {
      return options.transcript;
    },
  };
}
