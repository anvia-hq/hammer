# 0003: Ship a bundled node24 JavaScript action

## Status

Accepted

## Context

The action must start fast and run on GitHub-hosted, Blacksmith and self-hosted runners, on x64 and arm64 (PRD §8.9). PR-Agent ships a Docker action; Pullfrog ships a `node24` JavaScript action.

## Decision

`action.yml` uses `runs.using: node24` with `main: packages/action/dist/index.js` and `post: packages/action/dist/post.js` (`post-if: always()`). tsup bundles each entry and all dependencies into one ESM file ([tsup.config.ts](../../packages/action/tsup.config.ts)).

`dist/` is git-ignored on `main` and committed only on release branches, from which the `v1` tag is cut.

## Consequences

- No install step or container pull at runtime; the runner's Node is the only host requirement.
- Dependencies must be pure JavaScript: no native modules and no downloaded binaries.
- Release CI must check that the committed `dist/` matches a fresh build.
