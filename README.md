# Hammer

**Read-only AI pull request review for GitHub Actions.** Bring your own model key, run it on your own runners, and get inline comments you can trust enough to read.

Hammer reads the diff and the PR-head checkout with a small set of read-only tools, checks its own findings before posting, and leaves one review with inline comments plus a summary. It never edits files, runs your code, pushes, approves or merges. Built on [Anvia](https://www.anvia.dev).

## Why Hammer

- **Read-only by design.** The agent can read files, list directories, search and see the diff. It has no tool that writes, executes or reaches the network.
- **Your key, your runner.** Anthropic, OpenAI, Gemini, Azure OpenAI or any OpenAI-compatible gateway. Your code goes only to the model provider you configure, and Hammer collects no telemetry.
- **Few, checked comments.** A verification pass scores each finding against the code and drops weak ones. Low-confidence and out-of-diff findings never become inline noise, and findings you've already seen aren't repeated on the next push.
- **Safe with untrusted PRs.** PR text and file contents are treated as data, config is read from the base branch, and every comment is secret-scanned and sanitized before it is posted.
- **Follow it live.** The job log shows what Hammer is doing as it works.
- **Drop-in.** One workflow file. A bundled JavaScript action: no Docker, no install step, no preinstalled tools.

## Quick start

1. Add your model API key as a repository secret, for example `ANTHROPIC_API_KEY`.
2. Add this workflow:

```yaml
# .github/workflows/hammer-review.yml
name: Hammer Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    concurrency:
      group: hammer-review-${{ github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: true
    if: >
      github.event_name == 'pull_request' ||
      (github.event.issue.pull_request && startsWith(github.event.comment.body, '/hammer'))
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: anvia-hq/hammer@v1
        with:
          client: anthropic
          model: claude-sonnet-5-5
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

3. Open a pull request. Hammer reviews it and, on each push, posts a new summary comment and review covering only what changed since the last review. Threads whose flagged lines were fixed are resolved.

## Commands

Comment on a pull request. Commands need write access to the repository.

| Command                        | What it does                                        |
| ------------------------------ | --------------------------------------------------- |
| `/hammer review`               | Review the whole PR                                 |
| `/hammer review <instruction>` | Review with a focus, e.g. `/hammer review security` |
| `/hammer help`                 | Show the commands                                   |

A review started by a command does not appear in the PR's checks on its own. Add `statuses: write` to the workflow permissions and Hammer sets a `Hammer Review / comment` commit status on the PR head while it runs and when it finishes; see [0019](docs/decision/0019-commit-status-for-comment-reviews.md).

Pull requests from forks are not reviewed automatically by the default
workflow, because it would run with the base repository's secrets. A
maintainer can run `/hammer review` on them instead. To opt in to automatic
fork reviews, copy `docs/examples/hammer-fork-review.yml` (a pinned
`pull_request_target` workflow with abuse controls) into `.github/workflows`;
see [0018](docs/decision/0018-opt-in-fork-auto-review.md).

## Models

`client` is one of `anthropic`, `openai`, `gemini`, `openai-compatible`, `azure`, `claude-agent-sdk` or `codex`. `model` is the model id for that client.

```yaml
# Azure OpenAI
client: azure
model: my-deployment
base-url: https://my-resource.openai.azure.com
api-key: ${{ secrets.AZURE_OPENAI_API_KEY }}

# Any OpenAI-compatible gateway
client: openai-compatible
model: my-model
base-url: https://gateway.example.com/v1
native-json-schema: "false" # only if the endpoint lacks native JSON-schema output
api-key: ${{ secrets.GATEWAY_API_KEY }}
```

### Claude subscription (`claude-agent-sdk`)

`client: claude-agent-sdk` runs every model call of a review through the Claude Agent SDK on your own Claude subscription instead of a metered API key. It needs a token you create for yourself:

```sh
claude setup-token   # prints a token, for a Pro, Max, Team or Enterprise plan
```

Store the token as a repository secret (for example `CLAUDE_CODE_OAUTH_TOKEN`) and drop `api-key`:

```yaml
- uses: anvia-hq/hammer@v1
  with:
    client: claude-agent-sdk
    model: claude-sonnet-4-5
    oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

`oauth-token` falls back to the `CLAUDE_CODE_OAUTH_TOKEN` environment variable. A missing token fails the run with the `claude setup-token` instruction instead of reviewing nothing.

Hammer downloads the `claude` binary itself: one pinned version per platform, checksum-verified before it is unpacked, into `RUNNER_TEMP/hammer-claude/`. The first run on a runner downloads about 350 MiB; later runs reuse it. Where the temp directory is not warm, cache it:

```yaml
- uses: actions/cache@v4
  with:
    path: ${{ runner.temp }}/hammer-claude
    key: hammer-claude-0.3.326-${{ runner.os }}-${{ runner.arch }}
- uses: anvia-hq/hammer@v1
  with:
    client: claude-agent-sdk
    model: claude-sonnet-4-5
    oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Set `claude-path` (or `CLAUDE_CODE_PATH`) to a `claude` binary you installed yourself to skip the download. Supported platforms are Linux x64 and arm64 (glibc and musl), macOS x64 and arm64, and Windows x64 and arm64; anything else fails with a message naming the alternatives.

On this backend the same read-only controls apply as everywhere else, expressed in the SDK's terms: no built-in tool is enabled, every write, exec and network tool is denied, a `PreToolUse` hook refuses anything that is not one of Hammer's six read-only tools, no `~/.claude` settings, hooks or `.mcp.json` are read, the working directory is the PR-head checkout, and the CLI gets an allowlisted environment — `PATH`, `HOME`, temp, locale, proxy and certificate settings, plus your token — so the runner's `GITHUB_TOKEN`, the Action's inputs and any model API key never reach it. See [0022](docs/decision/0022-claude-agent-sdk-backend.md).

**What is billed:** reviews on a subscription draw on that plan's usage limits, not on a per-token API bill, so `cost_usd` is reported as 0 and `max_cost_usd` does not apply. `tokens` is still reported, from the SDK's per-model usage with cached prompt tokens counted as input, and `max_turns`, `max_tokens` and the shard limits still bind. Anthropic's third-party policy does not allow a product to log a user in to their Claude account; Hammer never does. It only uses a token the user generated for themselves with `claude setup-token`, keeps it in their own repository secret, and passes it to the CLI running on their own runner.

On `claude-agent-sdk`, `reasoning-effort` maps to the CLI's effort level (`low`, `medium`, `high`, `xhigh` or `max`); any other value fails the run before the first call.

### ChatGPT subscription (`codex`)

`client: codex` runs every model call of a review through the OpenAI Codex CLI on your own ChatGPT plan instead of a metered API key. It needs the session Codex stores for you, which you create with a device login (it prints a URL and a code, so it works on a server too):

```sh
codex login --device-auth   # writes ~/.codex/auth.json
```

Store that whole file as one repository secret and drop `api-key`. `model` is required on this backend: there is no default.

```yaml
- uses: anvia-hq/hammer@v1
  with:
    client: codex
    model: gpt-5.1-codex
    codex-auth-json: ${{ secrets.CODEX_AUTH_JSON }}
```

Hammer writes the session to a `CODEX_HOME` under `RUNNER_TEMP` with mode 0600 before Codex starts and lets Codex refresh it there; the file is never logged and the post step deletes it. An empty or malformed session fails the run with the `codex login --device-auth` instruction instead of reviewing nothing. Because each run starts from the secret, a session Codex refreshed during a review is not carried into the next one: if OpenAI stops accepting the stored session, run the device login again and update the secret.

Hammer downloads the `codex` binary itself: one pinned version per platform, checksum-verified before it is unpacked, into `RUNNER_TEMP/hammer-codex/`. The first run on a runner downloads about 400 MiB; later runs reuse it. Where the temp directory is not warm, cache it:

```yaml
- uses: actions/cache@v4
  with:
    path: ${{ runner.temp }}/hammer-codex
    key: hammer-codex-0.171.0-${{ runner.os }}-${{ runner.arch }}
- uses: anvia-hq/hammer@v1
  with:
    client: codex
    model: gpt-5.1-codex
    codex-auth-json: ${{ secrets.CODEX_AUTH_JSON }}
```

Set `codex-path` (or `CODEX_PATH`) to a `codex` binary you installed yourself to skip the download. Supported platforms are Linux x64 and arm64 (the static builds, so glibc and musl both work), macOS x64 and arm64, and Windows x64 and arm64; anything else fails with a message naming the alternatives.

The same read-only controls apply, expressed in Codex's terms: it runs `codex exec` with a read-only sandbox, every built-in tool turned off (shell, web search, image viewing and multi-agent), no user or project config read, an `AGENTS.md` in the pull request ignored, and only Hammer's own MCP server mounted — a stdio server bundled with the action that serves Hammer's six read-only tools with the same path guard, secret denylist, output caps and damping, plus the two read-only skill tools. Its child environment is an allowlist, with `CODEX_HOME` and `HOME` both pointing at the seeded directory, so the runner's `GITHUB_TOKEN`, the Action's inputs and any model API key never reach it. See [0023](docs/decision/0023-codex-cli-backend.md).

**What is billed:** reviews draw on the plan's usage limits, so `cost_usd` is 0 and `max_cost_usd` does not apply. `tokens` is still reported, from the CLI's per-turn usage with cached input counted as input, and `max_tokens`, `max_turns` and the shard limits still bind: the CLI has no turn limit of its own, so Hammer counts a turn's tool calls against `max_turns` and stops it there. A turn is also bounded by a 10-minute timeout. Hammer never logs a user in to a ChatGPT account; it only uses the session the user generated for themselves with `codex login --device-auth`, kept in their own repository secret and passed to the CLI on their own runner. On `codex`, `reasoning-effort` maps to the CLI's effort level (`low`, `medium`, `high`, `xhigh`, `max` or `ultra`); any other value fails the run before the first call.

Models that support it accept `reasoning-effort`, with the values the provider documents for that model (for example `low`, `medium`, `high`, and on some models `none`, `minimal`, `xhigh` or `max`). For a model Hammer's client does not list yet, the value is passed to the provider, which rejects it if the model does not support it. For a listed model the run fails with a clear error before any call.

## Configuration

Set options as action inputs, or commit a `.github/hammer.yml` for team-wide rules. Inputs override the file. The file is read from the **base branch**, so a pull request can't change its own review rules.

```yaml
# .github/hammer.yml
min_severity: medium # high | medium | low
max_comments: 10
fail_on: none # none | high | medium: fail the job on posted findings
review_drafts: false
ignore:
  - "**/*.snap"
  - "docs/generated/**"
ignore_authors:
  - dependabot[bot]
  - renovate[bot]
review_bot_pushes: false # true: also review pushes made by bots (remove them from ignore_authors for bot-authored PRs)
rules:
  - id: no-raw-sql
    text: Queries must go through the db helper, never string-built SQL.
path_instructions:
  - path: "src/api/**"
    text: Check that every handler validates input and returns typed errors.
verify: true
verify_threshold: 6 # 0-10
```

Hammer also reads `AGENTS.md`, `CLAUDE.md` and `CONTRIBUTING.md` from the base branch as review guidance (turn off with `use_repo_guidelines: false`).

### Repository review skills

Add your own review guidance as skills in your repository. Each skill is a folder with a `SKILL.md` (and optional `references/*.md`):

```
.hammer/skills/billing/SKILL.md
.hammer/skills/billing/references/rules.md
```

```md
---
name: billing
description: What to check in billing code
---

Focus on rounding, currency and idempotency in `src/billing/`. Ignore generated clients.
```

- `name` is required and becomes the skill's name. A skill cannot replace the bundled `code-review-and-quality`.
- Skills are read from the **base branch**, never the PR head, so a change to a skill takes effect after it is merged.
- They are read-only guidance: they can change what Hammer focuses on or ignores, but not the output format, the posting rules or the secret scan.
- Limits: 5 skills, 20 reference files each, 100,000 characters per file.
- Turn off with `use_repo_skills: false`.

### Limits

Each run is bounded by 50 files, 3,000 diff lines and 100 agent turns; change them with `max_files`, `max_diff_lines` and `max_turns` in `.github/hammer.yml`. A value passed in the workflow `with:` block is a ceiling the repository config cannot raise, so leave the input empty if you want the config file to decide. There is no token or cost limit unless you set `max_tokens` or `max_cost_usd` in `.github/hammer.yml`. If a turn, token or cost limit (or the model's context window) stops the review before it finishes, Hammer asks the model for its findings so far and publishes them as a partial review; only if that fails does the summary say the PR was not reviewed. `max_cost_usd` is enforced when Hammer knows the model's price: from the `pricing` input, from an openai-compatible gateway's `/models` endpoint (when `base-url` is set and lists prices), or from the bundled list. Supply `pricing` for models none of these cover.

Large PRs: the diff the model sees is measured in estimated tokens. Above `max_diff_tokens` (default 120,000) Hammer drops extra context, then deletion-only hunks, then whole low-priority files, and names everything it left out under "Not reviewed". Above `shard_tokens` (default 20,000) the files are split into at most `max_shards` (default 5, `1` turns it off) shards reviewed in parallel by separate read-only agents; if a shard fails, the others' findings are kept and its files are listed as not reviewed. See [0021](docs/decision/0021-large-pr-sharding-and-partial-results.md).

### Inputs

| Input                                      | Description                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `client`, `model`, `api-key`               | Required, except for `claude-agent-sdk` and `codex`. Client, model id and API key.                        |
| `oauth-token`                              | Claude subscription token for `claude-agent-sdk`. Falls back to `CLAUDE_CODE_OAUTH_TOKEN`.                |
| `claude-path`                              | Your own `claude` binary for `claude-agent-sdk`, skipping the download. Falls back to `CLAUDE_CODE_PATH`. |
| `codex-auth-json`                          | Contents of `~/.codex/auth.json` for `codex`, from `codex login --device-auth`. Never logged.             |
| `codex-path`                               | Your own `codex` binary for `codex`, skipping the download. Falls back to `CODEX_PATH`.                   |
| `base-url`                                 | Gateway URL (`openai-compatible`) or endpoint (`azure`).                                                  |
| `native-json-schema`                       | Set `"false"` for endpoints without native JSON-schema output.                                            |
| `reasoning-effort`                         | Reasoning effort, for models that support it.                                                             |
| `pricing`                                  | JSON of per-million-token USD prices, to enforce `max_cost_usd`.                                          |
| `github-token`                             | Defaults to the workflow token.                                                                           |
| `hammer-api-key`                           | Repository key from hammer.anvia.dev, so Hammer posts as the bot.                                         |
| `platform-url`                             | Token broker that lets Hammer post as the bot. Empty disables it.                                         |
| `bot-login`                                | Login of your own GitHub App behind `github-token`.                                                       |
| `config-path`                              | Config file path. Default `.github/hammer.yml`.                                                           |
| `min_severity`, `max_comments`, `fail_on`  | Override the matching config keys.                                                                        |
| `review_drafts`, `ignore`, `include`       | Override the matching config keys. Lists are newline-separated.                                           |
| `max_files`, `max_diff_lines`, `max_turns` | Review limits. Empty means use `.github/hammer.yml`.                                                      |
| `max_diff_tokens`                          | Token budget for the rendered diff. Default 120000.                                                       |
| `shard_tokens`, `max_shards`               | Shard a diff above this size (default 20000) into up to 5 shards.                                         |
| `max_tokens`, `max_cost_usd`               | Token and cost limits.                                                                                    |
| `verify`, `verify_threshold`               | Verification pass on or off, and the minimum score to keep a finding.                                     |
| `fail_on_error`                            | Fail the job if Hammer itself errors. Default `false`.                                                    |

### Outputs

`findings_count`, `high_count`, `review_url`, `result_path` (full result JSON), `tokens` and `cost_usd`. `cost_usd` is 0 for `claude-agent-sdk` and `codex`, which bill to a subscription.

## Live progress

Hammer streams its work into the job log, so you can follow a run instead of waiting for the final comment:

```text
[hammer] reviewing 12 files
[hammer] checkout_pr
[hammer] read_diff 1-400
[hammer] says: Checking how verifyToken is called before reading it.
[hammer] read_file src/auth.ts:1-80
[hammer] search /verifyToken/ in src/**
[hammer] model call done: 18432 tokens used so far, $0.0412
[hammer] review done, 2 findings
[hammer] verifying 4 findings
[hammer] verification kept 3, dropped 1
[hammer] review ready: 3 inline comments, 0 general notes
```

Commentary the model writes between tool calls (`says`) and, for models that expose it, its reasoning (`thinking`) stream in as they are produced; the final JSON answer is never printed. Every line is prefixed with `[hammer]`, redacted for secrets and flattened to one line, so PR content can't forge a workflow command. Secrets stay masked by the runner.

## Security and privacy

- The agent is read-only: no writes, no command execution, no network tools.
- Hammer checks out the PR head without running hooks, installs or builds, and file tools stay inside the checkout.
- PR title, body, comments, filenames and file contents are untrusted data. Config and guidance come from the base branch.
- Every comment is secret-scanned and sanitized before it is posted. Posting is limited to creating a review, creating or editing Hammer's own comments, and a reaction. The only other calls are one read-only GraphQL query that lists review threads and one mutation that resolves a Hammer thread after its flagged code was fixed, see [0020](docs/decision/0020-comment-per-run-and-resolve-fixed-threads.md).
- Your code is sent only to the model provider you configure. There is no telemetry.

See [docs/security-coverage.md](docs/security-coverage.md) for how each control is tested.

## Runners

Hammer is a pure-JavaScript Node 24 action with no preinstalled tools, so it runs on GitHub-hosted, Blacksmith and self-hosted Linux runners, x64 and arm64. Verified runners and open items are listed in [docs/runners.md](docs/runners.md). The exceptions are `client: claude-agent-sdk` and `client: codex`, which download a checksum-verified `claude` or `codex` binary into `RUNNER_TEMP`; see [0022](docs/decision/0022-claude-agent-sdk-backend.md) and [0023](docs/decision/0023-codex-cli-backend.md).

## Status

Hammer is v1. It is dogfooded on this repository and has been validated in live sandbox reviews, with verification and duplicate suppression, on GitHub-hosted Linux x64. A first 31-case synthetic evaluation passed its automated metric gate. Human review of review quality, the full evaluation corpus and wider runner acceptance are still open. See [sandbox setup](docs/sandbox.md) and [the product spec](docs/PRD.md).

## Development

The workspace uses [Bun](https://bun.sh) 1.4+ for installs and scripts. The bundled Action still runs on the runner's `node24`.

```sh
bun install
bun run check       # format + lint
bun run typecheck
bun run test
bun run build       # bundles packages/action/dist
bun run eval
```

| Path              | Package                | Purpose                                                            |
| ----------------- | ---------------------- | ------------------------------------------------------------------ |
| `action.yml`      | n/a                    | Action metadata; runs `packages/action/dist`                       |
| `packages/core`   | `@anvia/hammer-core`   | Review engine: config, diff planning, validation, rendering        |
| `packages/agents` | `@anvia/hammer-agents` | Reviewer agents: model factory, prompts, read-only tools, pipeline |
| `packages/action` | `@anvia/hammer-action` | Action entry (inputs, event, outputs), bundled with tsup           |
| `eval`            | `@anvia/hammer-eval`   | Eval runner and cases                                              |

Architecture decisions are in [docs/decision](docs/decision), repository rules in [docs/rules](docs/rules), and the release process in [docs/releasing.md](docs/releasing.md).

## License

Hammer is free software under the [GNU Affero General Public License v3.0](LICENSE). The hosted platform that issues the Hammer bot token is a separate, private service.
