# Hammer

Read-only AI pull request review that runs in your GitHub Actions, on any runner, with your own model key. Built on [Anvia](https://www.anvia.dev).

Status: pre-release. The review flow has passed live Haiku 5.5 and OpenAI-compatible Muse sandbox reviews with verification and duplicate suppression on GitHub-hosted Linux x64. Full model-quality and runner acceptance remain open. See [sandbox setup](docs/sandbox.md) and [the PRD](docs/PRD.md).

## Workspace

| Path              | Package                | Purpose                                                            |
| ----------------- | ---------------------- | ------------------------------------------------------------------ |
| `action.yml`      | —                      | Action metadata; runs `packages/action/dist`                       |
| `packages/core`   | `@anvia/hammer-core`   | Review engine: config, diff planning, agent, validation, rendering |
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
