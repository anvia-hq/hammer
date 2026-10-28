import { describe, expect, it, vi } from "vitest";

import { AnthropicClient } from "@anvia/anthropic";
import { promptCacheProviderOptions } from "../src/model";

describe("promptCacheProviderOptions", () => {
  it("enables top-level cache control only for Anthropic", () => {
    expect(promptCacheProviderOptions("anthropic")).toEqual({
      cache_control: { type: "ephemeral" },
    });
    expect(promptCacheProviderOptions("openai")).toBeUndefined();
    expect(promptCacheProviderOptions("openai-compatible")).toBeUndefined();
  });

  it("sends the top-level cache_control field in the Messages request", async () => {
    const create = vi.fn(async (_params: unknown) => ({
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
    const client = new AnthropicClient({ client: { messages: { create } } as never });
    const model = client.completionModel({ modelId: "claude-sonnet-5-5", controls: {} });
    await model.completion({
      instructions: "You review pull requests.",
      chatHistory: [{ role: "user", content: "Review this." }],
      documents: [],
      tools: [],
      providerOptions: promptCacheProviderOptions("anthropic"),
    } as never);
    expect((create.mock.calls[0]?.[0] as { cache_control?: unknown }).cache_control).toEqual({
      type: "ephemeral",
    });
  });
});
