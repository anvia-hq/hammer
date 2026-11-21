# 0023: Run reviews on the Codex CLI with a ChatGPT device login

## Status

Accepted. Adds a third review backend next to the `@anvia/*` model clients and
`claude-agent-sdk`, and amends [0005](../rules/0005-runner-portability.md) with a second narrow
exception.

## Context

[0022](0022-claude-agent-sdk-backend.md) let teams review pull requests on a Claude subscription
instead of a metered API key. The same request came for ChatGPT: teams already paying for a ChatGPT
plan want those reviews to draw on that plan.

OpenAI ships that path as the Codex CLI (`@openai/codex`). For a headless machine the login is
`codex login --device-auth`, which prints a URL and a code, and caches the session in
`$CODEX_HOME/auth.json`. Codex then refreshes the session itself, in place, while it runs.

Like the Claude CLI, Codex is not an HTTP client. It is a Rust binary, published per platform in
its own npm package (~400–540 MiB unpacked, pinned to the CLI version), it reads its credentials
from `CODEX_HOME`, and it brings its own tools, sandbox and config. Hammer has to state its
read-only guarantees in Codex's terms.

## Decision

- **One seam, three backends.** `createCodexBackend` implements the same `ReviewBackend` interface
  as `createAnviaBackend` and `createClaudeSdkBackend`
  ([0022](0022-claude-agent-sdk-backend.md)). The review pass, the repair turn, the
  finalize/salvage turn, the verification pass and the thread-resolution judge all go through it, so
  a ChatGPT-only setup needs no API key at all. Sharding needs nothing new: each shard is another
  conversation.
- **Auth is the user's own device login.** The user runs `codex login --device-auth` on their own
  machine and stores the resulting `~/.codex/auth.json` as one repository secret, passed as the
  `codex-auth-json` input. Hammer parses it, requires `tokens.access_token`,
  `tokens.refresh_token` and `tokens.id_token`, and writes `auth.json` with `auth_mode: "chatgpt"`
  into `<RUNNER_TEMP>/hammer-review-*/codex-home` at mode 0600 (directory 0700). Codex refreshes the
  tokens in place while the review runs; every run starts again from the secret, so a rotated
  refresh token is never read back. The file is never logged, and it lives inside the per-run
  directory the post step deletes. There is no access-token or API-key input for this backend.
  - **Caveat: refreshes are thrown away.** Because `CODEX_HOME` is fresh per run, a session that
    Codex refreshed mid-run is not carried into the next review. A refresh token is single-use, and
    a plan may cap how many times a session can be minted; if OpenAI starts rejecting the stored
    session, the user runs `codex login --device-auth` again and updates the secret. Hammer cannot
    rotate a repository secret on the user's behalf.
- **Hammer's own tools, over MCP.** Codex reaches tools through MCP servers, so Hammer ships a
  second bundle, `dist/codex-mcp.js`, a stdio MCP server that Codex starts as a child process. The
  reviewer's tool context (checkout root, reviewed files and their contents, the PR, the discussion,
  the skills directory) is written as JSON into the run directory and its path is passed through
  the server's `env`. The server rebuilds `buildReviewerToolDefinitions`, so the six read-only tools
  keep the same path guard, secret denylist, output caps and repeated-call damping, and bridges only
  the two read-only skill tools: the script-running skill tool is never built (rule 0004). Tools run
  in that child process, not in Codex's sandbox.
- **Read-only controls, asserted in tests.** Every turn runs
  `codex exec --json --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules
  --sandbox read-only`, with these config overrides on the command line so no user or project config
  is needed:
  - `features.shell_tool=false`, `features.view_image=false`, `features.multi_agent=false`,
    `features.multi_agent_v2=false` and `web_search="disabled"`, so no built-in tool can read the
    checkout, run a command or reach the network;
  - `project_doc_max_bytes=0`, so an `AGENTS.md` in the PR head never becomes model-level
    instructions; the base branch's guidance still reaches the reviewer as prompt data;
  - `cli_auth_credentials_store="file"`, so the session stays in the `CODEX_HOME` Hammer seeded
    instead of a runner keyring or a home directory;
  - only Hammer's MCP server mounted (`mcp_servers.hammer.*`, `required = true`), with the review
    checkout as `cwd`;
  - an allowlisted child environment: `PATH`, temp, locale, proxy and certificate settings, the
    Windows essentials, and `CODEX_HOME` plus `HOME`, both pointing at the seeded directory under
    `RUNNER_TEMP`. The runner's `GITHUB_TOKEN`, the Action's own inputs and any model API key stay
    out, and `HOME` never resolves to the runner's own `~/.codex`.
- **Instructions and prompts.** Hammer's review instructions go through the CLI's
  `developer_instructions` override, the equivalent of the Claude backend's system prompt, and the
  turn prompt goes over stdin (`codex exec … -`) because a review prompt with an inline diff is past
  the command-line limit on Windows. A repair or finalize turn renders the earlier turns as a
  `<transcript>` block (the shared limits in `src/transcript.ts`) and starts a new process, exactly
  as on the Claude backend; the finalize turn mounts no MCP server.
- **Structured output.** The review turn passes `--output-schema` a file with
  `ReviewBatchSchema` converted for OpenAI's strict structured-output validator: object
  constraints and length limits are dropped, every object gets `additionalProperties: false` and a
  `required` list of all its properties, and optional fields become nullable. A `null` optional is
  removed from the answer before Hammer validates it, so an optional field is never the reason a
  review is rejected. The answer is still validated by `validateBatchOutput` and salvaged when
  truncated.
- **Usage and cost.** `turn.completed` carries per-turn usage; Codex reports cached input inside
  `input_tokens` and reasoning tokens inside `output_tokens`, so `SinglePassUsage` maps them
  straight across and cached input counts as input beside fresh input tokens. A subscription has no
  per-token price, so `cost_usd` is 0, `max_cost_usd` does not bind, and `tokens`, `max_tokens` and
  the shard limits still do. The CLI has no turn limit of its own, so Hammer counts the tool calls
  of a turn against `max_turns` and stops the process when they pass it; the salvage turn then writes
  up what the review found. A turn is also bounded by a 10-minute timeout, and the run budget's
  `startGuard` still stops work between turns.
- **The binary is downloaded at runtime.** `packages/action/src/codex-binary.ts` pins one CLI
  version and, per platform, the npm tarball, its sha512 integrity, unpacked size and the vendored
  path of the binary (`vendor/<target triple>/bin/codex`). It streams the tarball into
  `RUNNER_TEMP`, verifies the sha512 before extracting anything, extracts only that file, sets mode
  0755 and renames it into place atomically; a reuse is checked by hashing the file against the
  digest written next to it. The Linux packages are the static musl builds, so one row covers glibc
  and musl runners. `codex-path` (or `CODEX_PATH`) skips provisioning entirely. The download and
  verify logic is one shared helper (`src/npm-binary.ts`) that both backends use.
- **OpenAI's policy.** Hammer never logs a user in to a ChatGPT account. It uses only the
  `auth.json` the user generated for themselves with `codex login --device-auth`, keeps it in their
  own repository secret, and passes it to the CLI running on their own runner.

## Consequences

- A team on a ChatGPT plan can turn on Hammer without an API key: `client: codex`,
  `model: <codex model id>` (required; there is no default), `codex-auth-json: ${{
  secrets.CODEX_AUTH_JSON }}`.
- The first run downloads ~400–540 MiB into `RUNNER_TEMP`; later runs reuse it, and the README shows
  the `actions/cache` recipe next to the Claude one.
- This is the second documented exception to rule 0005: a native binary, downloaded at runtime,
  pinned with a checksum, opt-in, writing only under `RUNNER_TEMP`, skipped when `codex-path` is
  set.
- Every call is one `codex` process, and each one also starts Hammer's MCP server; a turn is
  bounded by a 10-minute timeout.
- Failures map to distinct messages: an authentication failure (which names
  `codex login --device-auth` and the `codex-auth-json` secret), a turn that ended without a result,
  a non-zero exit with the tail of stderr, a turn timeout, and an error event from the stream.
- An answer can arrive without the CLI reporting a finish reason, so a review that was cut off is
  detected from the JSON it did not finish, as before.
- The MCP server's tool context is written once per run, so a sharded review serves the whole pull
  request's diff to every shard rather than only that shard's files. The shard prompt still frames
  the work, and findings a shard repeats are deduplicated as before; it only means a shard may read
  slightly more than the `@anvia/*` and Claude paths hand it.
