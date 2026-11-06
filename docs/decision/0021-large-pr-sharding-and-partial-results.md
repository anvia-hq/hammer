# 0021: Fit large diffs to a token budget, shard them, and publish partial results

## Status

Accepted. Amends [0015](0015-single-agent-checkout-pr.md) for large PRs and replaces its rule that a stopped run loses the review.

## Context

Reviews of big PRs sometimes stopped with nothing published. Hitting `max_turns`, a token or cost cap, or the model's context window threw, and every finding gathered so far was lost. One agent read the whole diff, and its `read_diff` and `read_file` output piled up in the conversation. `max_diff_lines` counted GitHub's additions plus deletions, while the rendered diff adds widening context, so the real size could be several times larger. Files whose patch GitHub omitted were called binary and skipped silently, a file above the line cap was never reviewed, and the summary comment was cut at 4,000 characters, which removed the "not reviewed" lists that sit at the end. PR-Agent (token-budgeted fitting, chunk and merge) and Pullfrog (diff table of contents, parallel read-only subagents, bounded change-impact leads) handle the same problem.

## Decision

- **Partial results.** Turn count is part of the wind-down, with a margin before the hard cap. When a run still stops (turn limit, budget, context overflow), Hammer replays the conversation with long tool results shortened, forbids tools and asks for the final JSON. The findings are published as a partial review with the reason. Only when that also fails is the PR reported as not reviewed. More than 25 findings, 5 notes or 6 changes are cut to the limit (highest severity first) instead of re-running the agent.
- **Visible skips.** A text file without a patch is "patch omitted by GitHub", counted as not reviewed. `@generated` counts only near the top of the patch. A file larger than `max_diff_lines` is listed with its size. Files past GitHub's 3,000-file limit are counted. The summary compacts its lists ("... and N more") so the not-reviewed list stays inside the comment limit.
- **Config.** `max_files`, `max_diff_lines` and `max_turns` inputs no longer default in `action.yml`. A workflow value is a ceiling; when it is empty, `.github/hammer.yml` decides.
- **Token budget.** The rendered diff is measured in estimated tokens (`max_diff_tokens`, default 120,000). Over it: drop widening context, then deletion-only hunks, then pack whole files by priority (source before tests, larger first) and skip those that do not fit. Every omission is named in the not-reviewed list.
- **Sharding.** When the rendered diff is above `shard_tokens` (default 20,000), files are grouped by path into at most `max_shards` (default 5) shards. Each shard gets its own read-only agent with a clean context, the same tools and a diff restricted to its files, and they run in parallel. A shard that fails is dropped: findings from the others are kept, the review is marked partial and the failed shard's files are listed as not reviewed. Findings from all shards go through the existing validate, verify and dedupe steps. Small PRs keep the single-agent path. `max_shards: 1` turns sharding off.
- **Change-impact leads.** Before each reviewer starts, a bounded in-process search lists references to names declared or removed in the diff, outside the changed files (24 names, 6 references each, 16 KB, 3 s). It is pure JS, read-only, wrapped as untrusted, and the prompt says it is incomplete.

## Consequences

- A big PR now yields a partial review instead of nothing, and the summary says what was left out and why.
- Sharding costs more calls for large PRs and shards cannot see each other's files except through the checkout tools; cross-shard issues depend on those tools and the leads.
- Token estimates are characters divided by four, so the budgets are approximate.
- The salvage call can exceed `max_tokens` or `max_cost_usd` by one completion.
