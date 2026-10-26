# 0001: Think about modularity and separation of concerns

## Status

Accepted

## Rule

Every change considers how its code is divided. Before adding code, decide which module owns it. Each module does one job, and its dependencies point in one direction.

- `packages/core` owns the review engine and never imports `@actions/*` or reads `process.env`. `packages/action` reads inputs and the event, calls core, and writes outputs. `packages/agents` owns the model-facing code (prompts, tools, pipeline) and depends on core; core never imports it. `eval` calls core and agents. See [0001](../decision/0001-pnpm-workspaces.md) and [0007](../decision/0007-extract-agents-package.md).
- Keep side effects (GitHub API, git, model calls, filesystem, environment) at the edges. Planning, validation, fingerprinting and rendering are pure functions that take their inputs as parameters.
- Pass dependencies in, rather than constructing them deep inside a module. For example, the review run takes an Octokit client and a model instead of creating them.
- Keep a module's public surface small. Export only what other packages need.
- Do not reach into another package's internals. Go through its `src/index.ts`.

## Rationale

Hammer combines GitHub I/O, git, an agent and rendering. Keeping them apart lets the engine run from the action, the eval runner and fixture tests without the Actions runtime, and lets each part be tested without network calls.

## Applies to

All packages in the workspace, and any new package or module.
