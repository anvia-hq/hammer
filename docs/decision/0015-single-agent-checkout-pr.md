# 0015: Review the whole PR with one agent that reads the diff through tools

## Status

Accepted. Replaces the batching design in PRD F12.

## Context

Hammer used to split a large diff into batches of at most 40k tokens, grouped by directory, and review them as independent agent runs. A batch could not see files in other batches, so a change in one directory that depends on another was easy to miss. A failed batch also meant a partly reviewed PR. Pullfrog does not batch: its agent calls `checkout_pr`, gets a table of contents of the diff, and reads the whole diff itself.

## Decision

- One agent reviews every file in the plan. There is no planner, no concurrency and no merge step.
- The prompt carries the PR title, body, repo guidance and instructions, not the diff. Two read-only tools deliver the diff:
  - `checkout_pr` returns PR metadata and a table of contents: each file with its status, additions, deletions and its line range in the diff.
  - `read_diff(startLine?, endLine?)` returns up to 400 diff lines per call and says where to continue.
- The diff is rendered in memory from the files the Action already fetched, with the same widened hunks and explicit new-file line numbers as before, so findings still anchor to real lines. No file is written, no git or network call is made, and every output is wrapped as untrusted.
- `get_file_diff` is removed; two tools that return the same diff in different formats would confuse the model.
- `max_files` and `max_diff_lines` stay as the bound on how large a review can get.
- Near 85% of `max_tokens` or `max_cost_usd` the tools are taken away from the model request, so it has to finish with the review it has instead of losing it to a budget error.
- The reviewer's output limit rises from 8,192 to 16,384 tokens because one run now reports on every file.

## Consequences

- No blind spot between directories, and one failure no longer leaves part of a PR unreviewed; a failure now fails the whole review, which `fail_on_error` can turn into a failed check.
- Each turn resends a growing context, so cost on large PRs is higher than the old per-batch cap implied. The budget caps and the wind-down are the control.
- A repair after invalid output re-runs the agent; with one large run that costs more than it did per batch.
- The agent reads the diff only if it chooses to. The prompt says to read all of it; reads are not yet enforced.
