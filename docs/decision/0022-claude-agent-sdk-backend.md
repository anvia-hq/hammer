# 0022: Run reviews on the Claude Agent SDK with a Claude subscription token

## Status

Accepted. Adds a second review backend next to the `@anvia/*` model clients, and amends
[0005](../rules/0005-runner-portability.md) with a narrow exception.

## Context

Hammer reviews pull requests with a model API key. Teams that already pay for Claude Pro, Max,
Team or Enterprise asked to review PRs on that subscription instead of buying a second, metered
API key. Anthropic ships that path as the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`),
which runs the `claude` CLI as a subprocess and authenticates with a token the user creates with
`claude setup-token` and passes as `CLAUDE_CODE_OAUTH_TOKEN`.

The SDK is not an HTTP client. It spawns a native CLI binary, which ships as a separate
platform package (~350 MiB unpacked) pinned to the SDK version, and it takes its credentials from
the subprocess environment. Its tools, permission modes and settings loading are its own, so
Hammer has to state its read-only guarantees in the SDK's terms rather than in `@anvia/core`'s.

## Decision

- **One review backend seam.** `packages/agents/src/backend.ts` defines a `ReviewBackend` that
  creates a conversation of turns; a turn returns text, usage and a finish reason. The existing
  `@anvia/*` path moves behind `createAnviaBackend`, unchanged in behaviour, and the new
  `createClaudeSdkBackend` sits beside it. `runSinglePassReview`, the repair turn, the
  finalize/salvage turn and the verify and judge passes all go through the seam, so a
  subscription-only setup needs no API key at all. Sharding needs nothing new: each shard is
  another conversation.
- **Full coverage, not just the main pass.** The SDK backend runs the review pass, the repair
  pass, the finalize/salvage pass, the verification pass and the thread-resolution judge.
  `max_turns` becomes the SDK's `maxTurns`, `reasoning-effort` becomes the CLI's effort level
  (`low`, `medium`, `high`, `xhigh`, `max`; anything else fails before the first call), and the
  run budget still stops work between turns (the `startGuard` the pipeline hands to the backend).
- **No history replay.** The SDK cannot be handed an assistant/tool history. A repair turn or a
  finalize turn renders the earlier turns as a `<transcript>` block in the prompt (tool results
  clipped to the same limits the `@anvia/*` path uses) and starts a new query. The finalize turn
  runs with no MCP server mounted, so it cannot spend the run on more tools.
- **Hammer's own tools only.** The six read-only tools in `src/tools.ts` are bridged to an
  in-process MCP server (`hammer`), so the model sees `mcp__hammer__read_file` and friends, with
  the same path guard, secret denylist, output caps and repeated-call damping. The read-only
  skill tools are bridged the same way; the script-running skill tool is never exposed.
- **Read-only controls, asserted in tests.** Every SDK query is built with:
  - `tools: []` — no built-in tool is available at all;
  - an explicit `disallowedTools` list covering every built-in write, exec and network tool
    (Bash, Write, Edit, MultiEdit, NotebookEdit, WebFetch, WebSearch, Task/Agent, KillShell,
    TaskOutput), plus Read, Glob and Grep, which would otherwise read the checkout around
    Hammer's path guard and secret denylist;
  - `permissionMode: "dontAsk"`, so nothing is ever prompted for, and a `PreToolUse` hook that
    denies any tool that is not one of Hammer's own (a bare `allowedTools` entry would shadow
    `canUseTool`, a hook does not);
  - `settingSources: []` and `strictMcpConfig`, so no user, project or local settings, hooks or
    `.mcp.json` are read;
  - `cwd` set to the PR-head checkout, and only Hammer's MCP server mounted;
  - an allowlisted child environment: only what the CLI needs to start and reach the network
    (`PATH`, `HOME`, temp, locale, proxy and CA settings, the Windows essentials) plus
    `CLAUDE_CODE_OAUTH_TOKEN` and a `CLAUDE_CONFIG_DIR` under `RUNNER_TEMP`. The runner's
    `GITHUB_TOKEN`, the Action's own inputs and any model API key stay out, so no other credential
    reaches the CLI; the config dir under `RUNNER_TEMP` keeps the CLI from writing sessions into
    the runner's home directory.
- **Structured output.** The review turn asks for JSON matching `ReviewBatchSchema`, converted
  with `z.toJSONSchema` (the draft declaration is dropped: the CLI's validator has no
  2020-12 meta schema). The answer is still validated by `validateBatchOutput` and salvaged when
  truncated, exactly as on the API-key path.
- **The binary is downloaded at runtime.** `packages/action/src/claude-binary.ts` pins one
  version and, per platform, the npm tarball URL, its sha512 integrity and unpacked size. It
  streams the tarball into `RUNNER_TEMP`, verifies the sha512 before extracting anything,
  extracts only `package/claude` (`claude.exe` on Windows), sets mode 0755 and renames it into
  place atomically. A reuse is checked by hashing the file against the digest written next to it.
  A checksum mismatch deletes the download and fails with the expected and actual digests; an
  unsupported platform fails with the supported list and the two ways out (`claude-path`, or an
  API-key client). `claude-path` (or `CLAUDE_CODE_PATH`) skips provisioning entirely.
- **Cost reporting.** A subscription has no per-token price, so `cost_usd` is 0 and the run says
  so; tokens are summed from the SDK's `modelUsage`, with cache reads and cache writes counted as
  input beside fresh input tokens, so `tokens` and the `max_tokens` budget match what the
  subscription actually consumed. `max_cost_usd` therefore does not bind on this backend, while
  `max_turns`, `max_tokens` and the shard limits still do. The CLI has no per-answer output cap, so
  the 16384-token `maxTokens` the API path puts on a single answer has no equivalent here.
- **Anthropic's policy.** Anthropic's third-party policy does not let a third-party product log
  a user in to a Claude account. Hammer never does: it uses only a token that the user generated
  for themselves with `claude setup-token` and stored as their own repository secret, and it never
  sees, stores or logs the user's Claude credentials beyond passing that token to the CLI it
  runs on the user's own runner. The README says so next to the setup steps.

## Consequences

- A team on a Claude subscription can turn on Hammer without an API key: `client:
claude-agent-sdk`, `model: <claude model id>`, `oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`.
- The first run downloads ~350 MiB into `RUNNER_TEMP` (~7 s on a fast runner); later runs reuse
  it, and the README shows an `actions/cache` recipe for runners without a warm temp directory.
- This is the documented exception to rule 0005: a native binary, downloaded at runtime, pinned
  with a checksum. It is opt-in, it touches only `RUNNER_TEMP`, and it is skipped when
  `claude-path` is set.
- Verify and judge runs open one `claude` process per call instead of one HTTP request. A turn
  is bounded by a 10-minute timeout.
- The finalize turn re-reads findings from a rendered transcript rather than the live
  conversation, so a salvage can miss a detail the model did not write down.
- Error result subtypes map to distinct failures: `error_max_turns`, `error_max_budget_usd`,
  `error_max_structured_output_retries`, `error_during_execution`, an authentication failure
  (which names `claude setup-token`), a missing result, and a turn timeout.
