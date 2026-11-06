import type { Message } from "@anvia/core/completion";

export const FINALIZE_PROMPT =
  "The review stopped before you finished: a turn, token or context limit was reached. Do not call any tools. Reply now with the final JSON review of everything you found so far.";

export const SALVAGE_RESULT_LIMITS = [2000, 300] as const;

export function describeStop(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/max.?turns/i.test(message) || (error instanceof Error && error.name === "MaxTurnsError"))
    return "turn limit reached";
  if (/budget/i.test(message)) return "review budget reached";
  if (/context|too long|too many tokens|maximum.*tokens/i.test(message))
    return "model context limit reached";
  if (/time/i.test(message)) return "time limit reached";
  return "run stopped early";
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated]`;
}

export function compactHistory(messages: readonly Message[], limit: number): Message[] {
  return messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return message;
    const content = (message.content as Array<Record<string, unknown>>).map((part) => {
      const output = part["output"] as { type?: string; value?: unknown } | undefined;
      if (output === undefined || typeof output.value !== "string") return part;
      return { ...part, output: { ...output, value: clip(output.value, limit) } };
    });
    return { ...message, content } as unknown as Message;
  });
}

export function hasToolActivity(messages: readonly Message[]): boolean {
  return messages.some((message) => message.role === "tool");
}
