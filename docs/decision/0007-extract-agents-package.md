# 0007: Extract the reviewer agents into `packages/agents`

## Status

Accepted

## Context

`packages/core` held both the pure review engine (config, planning, validation, dedupe, rendering, the GitHub review client) and everything that talks to a model: the provider factory, prompts, the read-only tools, the review pipeline and the verifier. Prompt and agent work changes often and needs the `@anvia/*` provider packages. The rest of the engine does not.

## Decision

Split the agent code into `packages/agents` (`@anvia/hammer-agents`), consumed from `src/` like core:

- `packages/agents`: model factory, review prompt, read-only tools, single-pass run, verifier and `runReviewPipeline`.
- `packages/core`: everything else, including `schema.ts` (the `Finding` and `ReviewBatch` contract the agents produce and core validates and renders) and `the review caps`.

Dependencies point one way: `action` and `eval` depend on `agents` and `core`, and `agents` depends on `core` through its `src/index.ts`. Core never imports `agents`, and the `@anvia/anthropic`, `@anvia/openai` and `@anvia/gemini` clients are dependencies of `agents` only.

## Consequences

- Prompts, tools and the pipeline change without touching the rendering and GitHub code, and core stays free of model providers.
- `schema.ts` stays in core, so a change to the finding shape is a change to core and is reviewed with its validation and rendering.
- The bundle is unchanged: tsup still bundles every workspace package into `dist/`.
- Updates [0001](0001-bun-workspaces.md) and [0002](0002-consume-published-anvia-packages.md): the model factory lives in `packages/agents`.
