# 0002: Build on the published @anvia packages from npm

## Status

Accepted

## Context

Hammer is an Anvia product. The agent loop, provider adapters, structured output, redaction and observability already exist as published `@anvia/*` packages, documented at [docs.anvia.dev](https://docs.anvia.dev). Rebuilding them would duplicate work, and Hammer is meant to show the SDK in production.

## Decision

Install these from npm and use their public APIs only:

| Package                                              | Used for                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `@anvia/core`                                        | `Agent`, `createTool`, `outputSchema`, `maxTurns`, lifecycle hooks, usage, retry, redaction          |
| `@anvia/anthropic`, `@anvia/openai`, `@anvia/gemini` | Model clients for the `model` input. `@anvia/openai` also serves `openai-compatible` with `base-url` |
| `@anvia/lens`, `@anvia/otel`                         | Optional tracing (PRD F20)                                                                           |

`packages/core` owns a model factory that maps `provider/model-id` to these clients. No other module constructs clients.

Not used in v1: `@anvia/durable` (runs are short and hold no state between jobs), `@anvia/tool-sandbox` and `@anvia/tool-browser` (the reviewer never runs code; see [0004](0004-read-only-reviewer.md)).

## Consequences

- Upgrades go through `pnpm update` and the package changelogs; versions use caret ranges and the lockfile pins exact versions.
- Hammer code depends on the published `.d.ts` types, not the Anvia source repo.
- Every Anvia package is bundled into the action (see [0003](0003-bundled-node24-js-action.md)), so it must stay pure JavaScript.
- Bugs found in these packages are handled by [rule 0003](../rules/0003-anvia-bugs-and-patches.md).
