import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultError,
  SDKResultMessage,
  SDKResultSuccess,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { toUsage, ZERO_USAGE, type SinglePassUsage, type TurnOutcome } from "../backend";
import { createTextStreamer } from "../stream";

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

const AUTH_PATTERN = /authenticat|unauthor|api key|oauth|credential|401|403|login|invalid token/i;

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

export function resultUsage(result: SDKResultMessage): SinglePassUsage {
  const usage = { ...ZERO_USAGE };
  const modelUsage = result.modelUsage;
  const entries =
    typeof modelUsage === "object" && modelUsage !== null ? Object.values(modelUsage) : [];
  if (entries.length > 0) {
    for (const entry of entries) {
      usage.inputTokens += Number.isFinite(entry.inputTokens) ? entry.inputTokens : 0;
      usage.outputTokens += Number.isFinite(entry.outputTokens) ? entry.outputTokens : 0;
    }
  } else {
    const fallback = toUsage(result.usage);
    usage.inputTokens = fallback.inputTokens;
    usage.outputTokens = fallback.outputTokens;
  }
  usage.inputTokens = Math.floor(usage.inputTokens);
  usage.outputTokens = Math.floor(usage.outputTokens);
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

export interface TranscriptEntry {
  role: "assistant" | "tool";
  text: string;
}

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

export function renderTranscript(entries: readonly TranscriptEntry[], limit: number): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const text =
      entry.text.length <= limit ? entry.text : `${entry.text.slice(0, limit)}\n[truncated]`;
    lines.push(entry.role === "assistant" ? `Assistant: ${text}` : `Tool result: ${text}`);
  }
  return lines.join("\n\n");
}
