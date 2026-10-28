# 0001: Anthropic requests cannot carry prompt cache breakpoints

## Status

Open

## Package

`@anvia/anthropic@1.1.9`

## Reproduce

Build a request whose system instructions and last message should be cached, then inspect the body sent to the Messages API:

- `request.instructions` and any system messages are joined into one string (`systemFromMessages`), so no `cache_control` can be attached to a system block.
- `request.providerOptions` is spread into the params, but `system`, `messages` and `tools` are assigned after the spread, so a breakpoint passed through `providerOptions` is overwritten.

Neither path lets a caller mark a prefix as cacheable.

## Actual

No request sends `cache_control`, so Anthropic caches nothing. Every turn of an agent loop resends the whole conversation at full input price. Cache usage fields are read from responses, but they are always zero.

## Expected

System instructions are sent as text blocks, the last one carrying `cache_control: { type: "ephemeral" }`. The last content block of the final message carries it too, so each turn of a loop reads the previous turn's prefix from cache.

## Workaround

`patches/@anvia%2Fanthropic@1.1.9.patch` adds both breakpoints in `toAnthropicMessagesParams`. Covered by the adversarial and cache tests in `packages/agents/test/`.
