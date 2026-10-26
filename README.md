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
          model: anthropic/claude-sonnet-5-5
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

For OpenAI-compatible gateways without native JSON-schema output, add `base-url` and set `native-json-schema: "false"`. Optional team rules live in `.github/hammer.yml` (see [the PRD](docs/PRD.md)).

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

```sh
pnpm install
pnpm check       # format + lint
pnpm typecheck
pnpm test
pnpm build       # bundles packages/action/dist
pnpm eval
```

## License

MIT
