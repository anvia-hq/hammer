import { ZERO_USAGE, type SinglePassUsage, type TurnOutcome } from "../backend";
import { createTextStreamer } from "../stream";
import type { TranscriptEntry } from "../transcript";
import { CodexError, describeCodexFailure } from "./errors";

interface CodexUsage {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_write_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
}

interface CodexItem {
  type?: string;
  text?: unknown;
  server?: unknown;
  tool?: unknown;
  arguments?: unknown;
  result?: { content?: unknown } | null | undefined;
  error?: { message?: unknown } | null | undefined;
  status?: unknown;
  command?: unknown;
}

interface CodexEvent {
  type?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  error?: { message?: unknown } | null | undefined;
  message?: unknown;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

// Codex reports `cached_input_tokens` inside `input_tokens` and reasoning tokens inside
// `output_tokens`, so both already count toward the run budget and the shard limits.
export function codexUsage(raw: CodexUsage | undefined): SinglePassUsage {
  if (raw === undefined) return { ...ZERO_USAGE };
  const inputTokens = tokenCount(raw.input_tokens);
  const outputTokens = tokenCount(raw.output_tokens);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function itemText(item: CodexItem | undefined): string {
  if (item === undefined) return "";
  if (item.type === "agent_message" && typeof item.text === "string") return item.text;
  return "";
}

function toolCallLine(item: CodexItem): string {
  const name =
    typeof item.tool === "string"
      ? typeof item.server === "string"
        ? `${item.server}/${item.tool}`
        : item.tool
      : typeof item.command === "string"
        ? item.command
        : (item.type ?? "tool");
  const args = item.arguments === undefined ? "" : ` ${JSON.stringify(item.arguments)}`;
  return `Tool call: ${name}${args}`;
}

function toolResultText(item: CodexItem): string {
  const content = item.result?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    return item.error?.message !== undefined && typeof item.error.message === "string"
      ? item.error.message
      : "";
  }
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry === "object" && entry !== null) {
      const text = (entry as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

export interface CodexTurnCollector {
  push(line: string): void;
  outcome(): TurnOutcome;
  failure(): CodexError | undefined;
  transcript(): TranscriptEntry[];
  toolCalls(): number;
}

export function createCodexCollector(options: {
  onText?: ((kind: "text" | "reasoning", text: string) => void) | undefined;
  transcript: TranscriptEntry[];
}): CodexTurnCollector {
  const streamer = options.onText === undefined ? undefined : createTextStreamer(options.onText);
  let turn = 0;
  let started = false;
  let text = "";
  let usage: SinglePassUsage = { ...ZERO_USAGE };
  let completed = false;
  let toolCalls = 0;
  let failure: CodexError | undefined;

  const emit = (kind: "text" | "reasoning", value: string): void => {
    if (value === "") return;
    options.transcript.push({ role: "assistant", text: value });
    streamer?.delta(kind, turn, value);
    streamer?.turnEnd(turn);
  };

  const handleCompleted = (item: CodexItem): void => {
    if (item.type === "agent_message") {
      const value = itemText(item);
      if (value !== "") {
        text = value;
        emit("text", value);
      }
      return;
    }
    if (item.type === "reasoning") {
      const value = typeof item.text === "string" ? item.text : "";
      if (value !== "") emit("reasoning", value);
      return;
    }
    if (item.type === "mcp_tool_call" || item.type === "command_execution") {
      const result = toolResultText(item);
      if (result !== "") options.transcript.push({ role: "tool", text: result });
    }
  };

  const handleStarted = (item: CodexItem): void => {
    if (item.type === "mcp_tool_call" || item.type === "command_execution") {
      toolCalls += 1;
      options.transcript.push({ role: "assistant", text: toolCallLine(item) });
      streamer?.toolCall(turn);
    }
  };

  return {
    push(line) {
      const trimmed = line.trim();
      if (trimmed === "") return;
      let event: CodexEvent;
      try {
        event = JSON.parse(trimmed) as CodexEvent;
      } catch {
        return;
      }
      if (typeof event !== "object" || event === null) return;
      if (event.type === "thread.started" || event.type === "turn.started") {
        if (started) streamer?.turnEnd(turn);
        turn += 1;
        started = true;
        return;
      }
      if (event.type === "item.started") {
        if (event.item !== undefined) handleStarted(event.item);
        return;
      }
      if (event.type === "item.completed") {
        if (event.item !== undefined) handleCompleted(event.item);
        return;
      }
      if (event.type === "turn.completed") {
        usage = codexUsage(event.usage);
        completed = true;
        // An `error` event is not always terminal: Codex can report a stream problem and then
        // finish the turn, and a completed turn carries its own text and usage.
        failure = undefined;
        streamer?.end();
        return;
      }
      if (event.type === "turn.failed") {
        const message =
          typeof event.error?.message === "string" ? event.error.message : "Codex turn failed.";
        failure = describeCodexFailure(message);
        return;
      }
      if (event.type === "error") {
        const message =
          typeof event.message === "string" ? event.message : "Codex reported an error.";
        failure = describeCodexFailure(message);
      }
    },
    outcome() {
      if (failure !== undefined) throw failure;
      if (!completed)
        throw new CodexError("missing_result", "Codex ended without a result for this turn.");
      return { text, usage };
    },
    failure() {
      return failure;
    },
    transcript() {
      return options.transcript;
    },
    toolCalls() {
      return toolCalls;
    },
  };
}
