# 0011: Release from main through a gated manual workflow, without Changesets

## Status

Accepted

## Context

Hammer ships as one artifact: the Action, tagged `v1.x.y`, with a moving `v1` tag and a `release/v1` branch holding the built `dist/` ([0003](0003-bundled-node24-js-action.md)). All workspace packages are private and nothing is published to npm. Changesets versions and changelogs several npm packages; here it would add a file to every PR and a version PR for versions nobody consumes. The first manual releases also showed gaps: any ref could be released, and CI was not required to be green.

## Decision

Keep the manual `Release` workflow (`workflow_dispatch`) and harden it ([release.yml](../../.github/workflows/release.yml)):

- It runs only on `main` and requires a successful `CI` run for the exact commit.
- It re-runs check, typecheck, test, build and both bundle smoke scripts before publishing.
- `bump` is `auto`, `patch` or `minor`. `auto` reads the labels of PRs merged since the last tag: `enhancement` gives a minor bump, otherwise patch. A `breaking` PR makes `auto` fail, because `v1` is a moving tag that users pin and a breaking change needs a deliberate new major line.
- `dry_run` builds and verifies, prints the next version, and publishes nothing.
- Every PR needs exactly one release label (`breaking`, `enhancement`, `bug`, `documentation`, `chore`), enforced by [pr-labels.yml](../../.github/workflows/pr-labels.yml). [release.yml](../../.github/release.yml) groups GitHub's generated notes by those labels and leaves out `chore`.

Release notes live on GitHub Releases; there is no `CHANGELOG.md`.

## Consequences

- No new dependency and no per-PR changeset files.
- A release is one dispatch of the workflow after CI is green on `main`; see [releasing](../releasing.md).
- Rolling back means re-pointing `v1` at an earlier tag, documented in the runbook.
- If the release process ever needs commit-driven automation, release-please is the next step; it would replace the bump logic, not the `dist/` and `v1` steps.
