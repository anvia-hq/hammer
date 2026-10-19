# Hammer

Read-only AI pull request review that runs in your GitHub Actions, on any runner, with your own model key. Built on [Anvia](https://www.anvia.dev).

Status: pre-release scaffold. See [docs/PRD.md](docs/PRD.md).

## Workspace

| Path              | Package                | Purpose                                                            |
| ----------------- | ---------------------- | ------------------------------------------------------------------ |
| `action.yml`      | —                      | Action metadata; runs `packages/action/dist`                       |
| `packages/core`   | `@anvia/hammer-core`   | Review engine: config, diff planning, agent, validation, rendering |
| `packages/action` | `@anvia/hammer-action` | Action entry (inputs, event, outputs), bundled with tsup           |
| `eval`            | `@anvia/hammer-eval`   | Eval runner and cases (PRD §11)                                    |

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
