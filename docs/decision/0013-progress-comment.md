# 0013: Post a progress comment first and replace it with the final summary

## Status

Accepted. The comment is created per run, not shared across runs: see [0020](0020-comment-per-run-and-resolve-fixed-threads.md).

## Context

A review can run for minutes. The job log streams progress ([0010](0010-stream-review-progress.md)), but people watching the PR saw nothing until the final review appeared.

## Decision

- Once Hammer decides to review, it posts the run's summary comment immediately as a todo list: check out the PR head, review the files, verify findings if enabled, post the review.
- Review events tick items off. Updates are throttled to one edit every 8 seconds and serialized, so rapid events collapse into one write. The pure state, reducer and renderer live in [progress.ts](../../packages/core/src/progress.ts); the throttled writer is [progress.ts](../../packages/action/src/progress.ts).
- When the pipeline returns, the reporter is settled first, so no late progress edit can overwrite the final result. Then the review with its inline comments is posted and the same comment is rewritten as the final summary. The error path rewrites it too.
- The progress comment shows only step names and counts, never findings or model text, because findings are not validated yet.
- It carries no `hammer:last-sha` marker. The last reviewed commit comes from the newest Hammer comment that has one, so a run that is cancelled or fails does not make the next push skip a commit as already reviewed. Only a completed review writes the new sha.
- Progress updates are best-effort: a failed edit warns once, stops further edits and never fails the review.

## Consequences

- One extra comment write at start and a few edits per run. A cancelled run leaves "Review in progress" until the next run starts, which rewrites it to an "interrupted" note. A next run that skips the push (a bot sender, a merge from base, `hammer:skip`, a draft) does the same.
- The run keeps the id of the comment it created and rewrites it by id, so it never creates a second one at the end.
