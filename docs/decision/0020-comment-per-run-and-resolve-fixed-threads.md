# 0020: Post a comment per run and resolve threads whose flagged code was fixed

## Status

Accepted. Replaces the single sticky summary comment from PRD §6.2 and changes the progress comment in [0013](0013-progress-comment.md) to one comment per run.

## Context

Hammer kept one summary comment per PR and rewrote it on every push. A push looked like an edit to old news, nothing marked the new review, and earlier inline threads stayed open after the author fixed the code. A human reviewer posts a new review for each round and closes the threads that were addressed.

## Decision

- Each run creates its own summary comment as its progress comment ([0013](0013-progress-comment.md)), then rewrites that same comment as the final summary. A later run never edits an earlier run's comment.
- The last reviewed commit is the `hammer:last-sha` marker on the newest Hammer comment that has one. Progress, error and interrupted comments carry none, so a run that did not finish does not move it.
- When a run starts, any earlier Hammer comment still showing "Review in progress" is rewritten to an interrupted note ("superseded by a newer run"). A run that is still going rewrites its own comment when it finishes.
- After posting the review, Hammer resolves an open review thread only when all of these hold:
  - the thread's first comment is Hammer's and carries a `hammer:fp` marker;
  - GitHub reports the thread outdated, meaning the flagged lines changed;
  - the thread's file was reviewed in this run;
  - the run finished: no review error, not partial, not cut short by the file or diff caps;
  - no finding from this run, including ones filtered out by severity or confidence, matches the thread's fingerprints.
- A thread whose flagged lines did not change is never resolved, even if the reviewer no longer reports it. The same goes for threads a person already resolved.
- The summary footer says how many earlier threads were resolved.
- The resolve step is best-effort. A failure warns once, stops resolving and never fails the review.
- The Octokit allowlist admits exactly one GraphQL mutation: `resolveReviewThread` with a `threadId` variable and nothing else. Any other mutation is still refused.

## Consequences

- Every push that reaches the model adds a comment to the PR. Pushes skipped before the review starts add none.
- A fix that adds code after the flagged line, or somewhere else, leaves the thread open, because the flagged lines did not change.
- A reviewer that rewords a still-valid finding gets a new comment and the old thread is resolved. The finding stays visible in the new thread.
- Resolving needs `pull-requests: write`, which Hammer already requires. The agent still has no write tool; the Action performs the resolve after validation ([0004](0004-read-only-reviewer.md)).
- Comments from before this change keep their marker. The newest one with a sha still seeds the incremental review, and a leftover progress comment is rewritten to an interrupted note.

## Amendment: judge open threads against the current code

The outdated rule alone missed fixes made away from the flagged lines. When the review finished without being partial, the pipeline now asks the model (read-only tools, same limits as the verifier) whether each open Hammer thread, up to 20, is fixed in the current code (`packages/agents/src/judge.ts`). A thread is resolved when it is outdated in a reviewed file, or the judge answers `fixed`, and in both cases only if this run's findings do not match its fingerprints. A missing or invalid verdict means open. A judge failure resolves nothing extra.
