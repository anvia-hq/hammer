import type Anthropic from "@anthropic-ai/sdk";

type Params = Anthropic.MessageCreateParams;

const CACHE = { type: "ephemeral" } as const;

function cacheLastBlock(content: Params["messages"][number]["content"]) {
  if (typeof content === "string")
    return [{ type: "text" as const, text: content, cache_control: CACHE }];
  const last = content[content.length - 1];
  if (last === undefined) return content;
  return [...content.slice(0, -1), { ...last, cache_control: CACHE }];
}

// The system text and the last message become prompt cache breakpoints, so each turn of an agent loop
// reads the earlier turns from cache. Passed as the injected client, so no SDK code is patched.
export function withPromptCache(sdk: Anthropic): Anthropic {
  const create = (params: Params, options?: unknown) => {
    const system =
      typeof params.system === "string"
        ? [{ type: "text" as const, text: params.system, cache_control: CACHE }]
        : params.system;
    const messages = params.messages.map((message, index) =>
      index === params.messages.length - 1
        ? { ...message, content: cacheLastBlock(message.content) }
        : message,
    );
    return sdk.messages.create({ ...params, system, messages } as Params, options as never);
  };
  const messages = Object.assign(Object.create(sdk.messages), { create });
  return Object.assign(Object.create(sdk), { messages }) as Anthropic;
}
