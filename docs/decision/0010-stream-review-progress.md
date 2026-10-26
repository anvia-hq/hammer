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
- Model commentary and reasoning are streamed too, as one-line `says` / `thinking` events (see below). The final JSON answer is never streamed.

## Addendum: streaming model text

- The reviewer runs through `agent.stream()` when the model supports `streamCompletion`, and `agent.generate()` otherwise. The budget wrapper in [pipeline.ts](../../packages/agents/src/pipeline.ts) wraps `streamCompletion` as well as `completion`, so the timeout and token and cost accounting are the same on both paths.
- [stream.ts](../../packages/agents/src/stream.ts) turns deltas into lines. A turn whose text opens with `{` or a code fence is the structured answer and is dropped. Other text is emitted a line at a time, and the unfinished tail only when the turn went on to call a tool. Reasoning is emitted as it arrives.
- Text lines pass `redactSecrets`, are flattened to one `[hammer]`-prefixed line and truncated, like every other event. They are never added to the progress comment.
- If a gateway cannot stream and fails before any output, the batch is retried once without streaming.
