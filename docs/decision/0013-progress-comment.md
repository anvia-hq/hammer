# 0013: Post a progress comment first and replace it with the final summary

## Status

Accepted

## Context

A review can run for minutes. The job log streams progress ([0010](0010-stream-review-progress.md)), but people watching the PR saw nothing until the final review appeared.

## Decision

- Once Hammer decides to review, it posts the sticky summary comment immediately as a todo list: check out the PR head, review the files, verify findings if enabled, post the review.
- Review events tick items off. Updates are throttled to one edit every 8 seconds and serialized, so rapid events collapse into one write. The pure state, reducer and renderer live in [progress.ts](../../packages/core/src/progress.ts); the throttled writer is [progress.ts](../../packages/action/src/progress.ts).
- When the pipeline returns, the reporter is settled first, so no late progress edit can overwrite the final result. Then the review with its inline comments is posted and the same sticky comment is rewritten as the final summary. The error path rewrites it too.
- The progress comment shows only step names and counts, never findings or model text, because findings are not validated yet.
- It keeps the previous review's `hammer:last-sha` marker, so a run that is cancelled or fails does not make the next push skip a commit as already reviewed. Only a completed review writes the new sha.
- Progress updates are best-effort: a failed edit warns once, stops further edits and never fails the review.

## Consequences

- One extra comment write at start and a few edits per run. A cancelled run leaves "Review in progress" until the next run rewrites it. If that next run skips the push (a bot sender, a merge from base, `hammer:skip`, a draft), it rewrites the stale comment to an "interrupted" note that keeps the last-sha marker.
- The sticky comment is created earlier, so it is added to the in-memory comment list to prevent a second one from being created at the end.
