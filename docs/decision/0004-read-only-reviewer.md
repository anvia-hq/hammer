# 0004: The reviewer agent is read-only

## Status

Accepted

## Context

PR content and repository files are attacker-controlled. Coding agents in GitHub (Pullfrog, Claude Code Action) need shells, environment scrubbing and push guards. A reviewer needs none of that.

## Decision

The agent gets only read tools: `read_file`, `list_dir`, `search`, `get_file_diff` and `get_pr_discussion` (PRD F10). Its only output is a structured result that Hammer validates and posts as one `COMMENT` review and one summary comment. The checkout is fetched, never built or executed, and git hooks, submodules and LFS are disabled.

## Consequences

- Most of the injection surface disappears: the worst outcome is a misleading comment, handled by output filtering (PRD S6, S7).
- Autofix, running tests and approving PRs are out of scope until a separate decision replaces this one.
- `/hammer review` can safely read fork code with base-repo secrets. See [0005](0005-fork-prs-by-comment-trigger.md).
