# Hammer

Read-only AI pull request review that runs in your GitHub Actions, on any runner, with your own model key. Built on [Anvia](https://www.anvia.dev).

Status: v1. Dogfooded on this repo and validated in live sandbox reviews (Haiku 5.5 and OpenAI-compatible Muse) with verification and duplicate suppression on GitHub-hosted Linux x64. An initial 31-case synthetic Muse-reviewer/Haiku-judge evaluation passed the automated metric gate. Human review, the full corpus and wider runner acceptance remain open. See [sandbox setup](docs/sandbox.md) and [the PRD](docs/PRD.md).

## Install

Add one model API key as a repository secret (e.g. `ANTHROPIC_API_KEY`) and one workflow file:

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

`client` is one of `anthropic`, `openai`, `gemini`, `openai-compatible` or `azure`. For `openai-compatible` gateways and `azure`, also set `base-url` (the gateway URL, or the Azure OpenAI endpoint); for `openai-compatible` endpoints without native JSON-schema output, also set `native-json-schema: "false"`. Models that support it can take a `reasoning-effort` input (e.g. `low` | `medium` | `high`); the run fails with a clear error if the model doesn't support the requested value. Optional team rules live in `.github/hammer.yml` (see [the PRD](docs/PRD.md)).

## Live progress

Hammer streams what it is doing into the job log while it reviews, so you can follow a run instead of waiting for the final comment:

```text
[hammer] reviewing 12 files in 3 batches
[hammer] batch src: started, 5 files
[hammer] batch src: read_file src/auth.ts:1-80
[hammer] batch src: search /verifyToken/ in src/**
[hammer] model call done: 18432 tokens used so far, $0.0412
[hammer] batch src: done, 2 findings
[hammer] verifying 4 findings
[hammer] verification kept 3, dropped 1
[hammer] review ready: 3 inline comments, 0 general notes
```

Events cover the plan, each batch, every read-only tool call, model calls with running token and cost totals, verification, and the final tally. Every line is prefixed with `[hammer]` and flattened to one line, so PR content can never forge a workflow command. Secrets stay masked by the runner.

## Workspace

| Path              | Package                | Purpose                                                            |
| ----------------- | ---------------------- | ------------------------------------------------------------------ |
| `action.yml`      | —                      | Action metadata; runs `packages/action/dist`                       |
| `packages/core`   | `@anvia/hammer-core`   | Review engine: config, diff planning, validation, rendering        |
| `packages/agents` | `@anvia/hammer-agents` | Reviewer agents: model factory, prompts, read-only tools, pipeline |
| `packages/action` | `@anvia/hammer-action` | Action entry (inputs, event, outputs), bundled with tsup           |
| `eval`            | `@anvia/hammer-eval`   | Eval runner and cases (PRD §11)                                    |

## Privacy

Your code is sent only to the configured model provider. Hammer collects no telemetry.

## Development

The workspace uses [Bun](https://bun.sh) (1.4+) for installs and scripts; the bundled Action itself still runs on the runner's `node24`.

```sh
bun install
bun run check       # format + lint
bun run typecheck
bun run test
bun run build       # bundles packages/action/dist
bun run eval
```

## License

MIT
