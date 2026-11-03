# 0018: Opt-in automatic review of fork PRs via pull_request_target

## Status

Accepted. Supersedes [0005](0005-fork-prs-by-comment-trigger.md).

## Context

0005 banned `pull_request_target` everywhere: fork PRs are skipped on
`pull_request` (no secrets there, so no model key) and a maintainer runs
`/hammer review` via `issue_comment`, which fetches the fork head read-only
(see [0004](0004-read-only-reviewer.md)). Maintainers asked for automatic fork
reviews anyway, PR-Agent style: an opt-in workflow that runs in base-repo
context with secrets available.

`pull_request_target` is safe only while nobody adds a checkout or build step
that runs PR code. Hammer's review path already satisfies that constraint: the
action never checks out the PR with `actions/checkout`, it fetches the head
SHA read-only (depth 1, no submodules, no LFS, hooks disabled, API-tarball
fallback), reads config and guidance from the base SHA, posts only COMMENT
reviews, and filters every comment (PRD S6/S7). The `issue_comment` trigger
proves the same path against fork code today.

## Decision

- Offer one blessed opt-in workflow, `docs/examples/hammer-fork-review.yml`,
  kept OUTSIDE `.github/workflows`. Copying it into a repo's workflows
  directory is the explicit opt-in.
- Core `decideEvent` accepts `pull_request_target` with the same trigger
  actions (`opened`, `synchronize`, `reopened`, `ready_for_review`) and the
  same payload validation as `pull_request`. The run keeps `kind:
"pull_request"` and records `source: "pull_request" |
"pull_request_target"` so downstream logic (incremental scope, head-SHA
  staleness, merge-from-base, plan, publish) is unchanged.
- The action entry allows `GITHUB_EVENT_NAME=pull_request_target` and reviews
  fork PRs only through that event. `pull_request` + fork still skips with the
  maintainer-command notice (no secrets available there).
- The blessed example pins the reusable shape: `pull_request_target` types
  only, no other trigger, `contents: read` + `pull-requests: write` only,
  concurrency `cancel-in-progress: true`, pinned
  `anvia-hq/hammer@<sha-or-v1>`, no `actions/checkout` of the PR head, and
  cost/abuse controls (`max_cost_usd`, `fail_on_error: "false"`).
- Security tests enforce an allowlist: the blessed example is the only
  permitted `pull_request_target` shape. Any live workflow under
  `.github/workflows` containing `pull_request_target`, any checkout of PR
  head code, or any deviation (extra triggers, wider permissions, missing
  concurrency) fails.

## Threat model

Same attacker as PRD §9: PR content and repo files are attacker-controlled
(forks, compromised contributors). The new exposure is that the workflow runs
with base secrets (model key). Containment:

- No PR code ever executes: single Hammer step, no checkout/build/test step,
  read-only `git fetch` + in-process tarball extraction only.
- Config and guidance stay pinned to the base SHA, so a PR cannot loosen its
  own review.
- Output channel stays COMMENT reviews plus Hammer's own summary comments;
  S5 allowlist, S6 secret redaction and S7 sanitising apply unchanged.
- Blast radius is spend, not exfiltration: `max_cost_usd` and concurrency
  caps bound a fork that pushes repeatedly to burn model budget.

## Abuse controls

- Concurrency group per PR with `cancel-in-progress: true`: overlapping runs
  are cancelled before publishing.
- `max_cost_usd` per run and `fail_on_error: "false"` so a failing review does
  not break the PR's checks.
- First-time contributors still need approval: the repository's "Require
  approval for first-time contributors" setting gates this workflow like any
  other, so a stranger's PR does not run until a maintainer approves it.

## Consequences

- Default stays comment-triggered fork review; automatic fork review is an
  explicit, auditable opt-in.
- 0005's blanket ban is replaced by the allowlist; `pull_request` fork runs
  keep the existing skip notice.
- Revisit if the GitHub App (post-v1) gives short-lived tokens to plain
  `pull_request` runs, which would remove the need for `pull_request_target`.
