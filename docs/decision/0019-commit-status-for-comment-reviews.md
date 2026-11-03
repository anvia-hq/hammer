# 0019: Show comment-triggered reviews in the PR checks with a commit status

## Status

Accepted.

## Context

A review started by `/hammer review` runs on `issue_comment`. GitHub ties that run to the default branch, not to the PR head, so it never appears in the PR's checks. The PR can show "All checks have passed" while the review is still running or after it failed, which invites a merge before the review lands.

PRD S5 limited the workflow token to `contents: read` and `pull-requests: write`. A check run needs a GitHub App token; a commit status needs `statuses: write`.

## Decision

- On comment-triggered runs only, once the review starts, Hammer sets a commit status with context `Hammer Review / comment` on the PR head: `pending` while it runs, then `success` or `failure` from the same gate as the job exit code, `error` when the results are discarded because the PR changed, and `failure` when the run errors. It links to the run.
- `pull_request` and `pull_request_target` runs already show as checks and set no status.
- `statuses: write` is opt-in. Without it the first call fails, Hammer warns once with the permission to add, and the review continues unchanged.
- The Octokit allowlist admits only `POST /repos/{owner}/{repo}/statuses/{40-hex sha}` with that exact context, so the token cannot set or overwrite any other status.

## Consequences

- PRD S5 now lists `statuses: write` as an optional permission.
- A cancelled comment run leaves the status `pending` until the next comment run on the same head sets it.
- When Hammer posts as the Hammer bot, the GitHub App needs the Commit statuses (write) permission; until it has it, the status is skipped with the same warning.
