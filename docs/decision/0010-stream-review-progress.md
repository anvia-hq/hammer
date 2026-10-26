# 0010: Stream review progress to the job log

## Status

Accepted

## Context

A review can run for minutes and the job log was silent until the final comment. Pullfrog streams agent events into the Action log; users want the same visibility.

## Decision

- `packages/core` defines a typed `ReviewEvent` and a pure `formatReviewEvent` ([progress.ts](../../packages/core/src/progress.ts)). `packages/agents` emits events from the pipeline through an optional `onEvent` sink: plan, batch start/end, each read-only tool call, each model call with running tokens and cost, verification, and the final tally. `packages/action` prints each formatted line with `runtime.info`.
- Events are emitted at seams Hammer owns (the model wrapper and tool `execute` functions), not from the Anvia streaming API, so structured output, repair and budgets are unchanged.
- Every line starts with `[hammer]` and is flattened to one line and truncated, so model or PR-controlled text cannot start a `::` workflow command ([rule 0004](../rules/0004-read-only-and-untrusted-input.md)). A failing sink never fails the review.

## Consequences

- Core stays free of the Actions runtime; `eval` can pass its own sink.
- Model text and reasoning are not streamed, only actions and totals.
