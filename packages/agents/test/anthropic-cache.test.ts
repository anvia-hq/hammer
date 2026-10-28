import { describe, expect, it, vi } from "vitest";

import { AnthropicClient } from "@anvia/anthropic";
import { withPromptCache } from "../src/anthropic-cache";

function fakeSdk() {
  const create = vi.fn(async (_params: unknown, _options?: unknown) => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  }));
  return { create, sdk: { messages: { create } } as never };
}

async function sentParams(chatHistory: unknown[], instructions?: string) {
  const { create, sdk } = fakeSdk();
  const client = new AnthropicClient({ client: withPromptCache(sdk) });
  const model = client.completionModel({ modelId: "claude-sonnet-5-5", controls: {} });
  await model.completion({ instructions, chatHistory, documents: [], tools: [] } as never);
  return create.mock.calls[0]?.[0] as unknown as {
    system: Array<{ text: string; cache_control?: unknown }>;
    messages: Array<{ content: Array<Record<string, unknown>> }>;
  };
}

describe("withPromptCache (cache breakpoints for Anthropic requests)", () => {
  it("marks the system text and a string last message as cacheable", async () => {
    const params = await sentParams(
      [{ role: "user", content: "Review this." }],
      "You review pull requests.",
    );
    expect(params.system).toEqual([
      { type: "text", text: "You review pull requests.", cache_control: { type: "ephemeral" } },
    ]);
    expect(params.messages.at(-1)?.content).toEqual([
      { type: "text", text: "Review this.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("marks only the last block of a multi-block final message", async () => {
    const params = await sentParams([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ]);
    expect(params.messages[0]?.content[0]?.cache_control).toBeUndefined();
    expect(params.messages.at(-1)?.content.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
  });
});
