import { describe, expect, it, vi } from "vitest";

import { AnthropicClient } from "@anvia/anthropic";

function fakeResponse() {
  return {
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
  };
}

describe("Anthropic prompt cache breakpoints (docs/anvia-bug/0001)", () => {
  it("marks the system text and the last message as cacheable", async () => {
    const create = vi.fn(async (_params: unknown) => fakeResponse());
    const client = new AnthropicClient({ client: { messages: { create } } as never });
    const model = client.completionModel({ modelId: "claude-sonnet-5-5", controls: {} });
    await model.completion({
      instructions: "You review pull requests.",
      chatHistory: [{ role: "user", content: "Review this." }],
      documents: [],
      tools: [],
    } as never);
    const params = create.mock.calls[0]?.[0] as unknown as {
      system: Array<{ text: string; cache_control?: unknown }>;
      messages: Array<{ content: Array<{ cache_control?: unknown }> }>;
    };
    expect(params.system).toEqual([
      { type: "text", text: "You review pull requests.", cache_control: { type: "ephemeral" } },
    ]);
    expect(params.messages.at(-1)?.content.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
  });
});
