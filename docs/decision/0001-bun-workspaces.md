# 0001: Use Bun workspaces for the monorepo

## Status

Accepted. Supersedes the original pnpm choice; see [0009](0009-bun-workspaces.md) for the migration.

## Context

Hammer has a review engine, a GitHub Action entry, and an eval runner. The eval runner and a later CLI need the engine without the Actions runtime.

## Decision

Use Bun workspaces declared in the root [package.json](../../package.json) (`workspaces`):

- `packages/core` (`@anvia/hammer-core`): the review engine. Private, consumed from `src/` with no build step.
- `packages/agents` (`@anvia/hammer-agents`): the reviewer agents, prompts, tools and review pipeline. Same packaging as core. See [0007](0007-extract-agents-package.md).
- `packages/action` (`@anvia/hammer-action`): the Action entry, bundled by tsup into `dist/`. See [0003](0003-bundled-node24-js-action.md).
- `eval` (`@anvia/hammer-eval`): the eval runner from PRD §11.

`action.yml` sits at the repository root so `uses: anvia-hq/hammer@v1` works.

## Consequences

- One lockfile (`bun.lock`) and one `bun install` at the root.
- Workspace packages reference each other with `workspace:*`.
- Workspace names must not match a published npm package. All use the `hammer-` prefix so they cannot shadow `@anvia/*` packages from [0002](0002-consume-published-anvia-packages.md).
