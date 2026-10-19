# 0005: Review fork PRs only on a maintainer's comment

## Status

Accepted

## Context

`pull_request` runs from forks get no secrets, so no model key. PR-Agent's answer is `pull_request_target`, which has secrets but is only safe while nobody adds a checkout or build step. Pullfrog uses a GitHub App with OIDC, which needs hosted infrastructure.

## Decision

Templates and docs never use `pull_request_target`. Fork PRs are skipped on `pull_request` with a notice. A user with write access comments `/hammer review`, and the `issue_comment` run fetches the fork head read-only (see [0004](0004-read-only-reviewer.md)).

## Consequences

- No automatic review of fork PRs in v1; maintainers trigger it.
- Trigger authorization is checked through the collaborator permission API, not `author_association` (PRD F2, S1).
- Revisit when the GitHub App (post-v1) can provide short-lived tokens.
