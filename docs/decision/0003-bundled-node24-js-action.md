# 0003: Ship a bundled node24 JavaScript action

## Status

Accepted

## Context

The action must start fast and run on GitHub-hosted, Blacksmith and self-hosted runners, on x64 and arm64 (PRD §8.9). PR-Agent ships a Docker action; Pullfrog ships a `node24` JavaScript action.

## Decision

`action.yml` uses `runs.using: node24` with `main: packages/action/dist/index.js` and `post: packages/action/dist/post.js` (`post-if: always()`). tsup bundles each entry and all dependencies into one ESM file ([tsup.config.ts](../../packages/action/tsup.config.ts)).

`dist/` is git-ignored on `main`. The release workflow commits it on a detached commit and tags that commit `v1.x.y`, then moves `v1` to it. There is no long-lived release branch: the tags alone keep the commit reachable and are what `uses: anvia-hq/hammer@v1` resolves.

## Consequences

- No install step or container pull at runtime; the runner's Node is the only host requirement.
- Dependencies must be pure JavaScript: no native modules and no downloaded binaries.
- Release CI must check that the committed `dist/` matches a fresh build.
