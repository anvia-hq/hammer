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
    timeout-minutes: 15
    steps:
      - uses: anvia-hq/hammer@v1
        with:
          client: anthropic
          model: claude-sonnet-5-5
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

3. Open a pull request. Hammer reviews it and updates a single summary comment on each push, reviewing only what changed since the last review.

## Commands

Comment on a pull request. Commands need write access to the repository.

| Command                        | What it does                                        |
| ------------------------------ | --------------------------------------------------- |
| `/hammer review`               | Review the whole PR                                 |
| `/hammer review <instruction>` | Review with a focus, e.g. `/hammer review security` |
| `/hammer help`                 | Show the commands                                   |

Pull requests from forks are not reviewed automatically, because the workflow would run with the base repository's secrets. A maintainer can run `/hammer review` on them instead.

## Models

`client` is one of `anthropic`, `openai`, `gemini`, `openai-compatible` or `azure`. `model` is the model id for that client.

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

Models that support it accept `reasoning-effort` (`low`, `medium` or `high`). The run fails with a clear error if the model doesn't support the value.

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

### Limits

Each run is bounded. Defaults: 50 files, 3,000 diff lines, 100 agent turns, 400,000 tokens and $1.00. Raise or lower them with `max_files`, `max_diff_lines`, `max_turns`, `max_tokens` and `max_cost_usd`. When a limit is hit, Hammer posts what it has and says the review was partial. `max_cost_usd` is enforced when Hammer knows the model's price: from the `pricing` input, from an openai-compatible gateway's `/models` endpoint (when `base-url` is set and lists prices), or from the bundled list. Supply `pricing` for models none of these cover.

### Inputs

| Input                                      | Description                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `client`, `model`, `api-key`               | Required. Model client, model id and API key.                                                   |
| `base-url`                                 | Gateway URL (`openai-compatible`) or endpoint (`azure`).                                        |
| `native-json-schema`                       | Set `"false"` for endpoints without native JSON-schema output.                                  |
| `reasoning-effort`                         | `low`, `medium` or `high`, for models that support it.                                          |
| `pricing`                                  | JSON of per-million-token USD prices, to enforce `max_cost_usd`.                                |
| `github-token`                             | Defaults to the workflow token.                                                                 |
| `platform-url`                             | Required. Hammer platform that issues the bot token; only registered repositories are reviewed. |
| `bot-login`                                | Login of your own GitHub App behind `github-token`.                                             |
| `config-path`                              | Config file path. Default `.github/hammer.yml`.                                                 |
| `min_severity`, `max_comments`, `fail_on`  | Override the matching config keys.                                                              |
| `review_drafts`, `ignore`, `include`       | Override the matching config keys. Lists are newline-separated.                                 |
| `max_files`, `max_diff_lines`, `max_turns` | Review limits.                                                                                  |
| `max_tokens`, `max_cost_usd`               | Token and cost limits.                                                                          |
| `verify`, `verify_threshold`               | Verification pass on or off, and the minimum score to keep a finding.                           |
| `fail_on_error`                            | Fail the job if Hammer itself errors. Default `false`.                                          |

### Outputs

`findings_count`, `high_count`, `review_url`, `result_path` (full result JSON), `tokens` and `cost_usd`.

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
- Every comment is secret-scanned and sanitized before it is posted. Posting is limited to creating a review, creating or editing Hammer's own comments, and a reaction. The only other call is one read-only GraphQL query that lists which review threads are resolved, so Hammer does not raise a resolved finding again.
- Your code is sent only to the model provider you configure. There is no telemetry.

See [docs/security-coverage.md](docs/security-coverage.md) for how each control is tested.

## Runners

Hammer is a pure-JavaScript Node 24 action with no preinstalled tools, so it runs on GitHub-hosted, Blacksmith and self-hosted Linux runners, x64 and arm64. Verified runners and open items are listed in [docs/runners.md](docs/runners.md).

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
