# 0009: Migrate the toolchain from pnpm to Bun

## Status

Accepted

## Context

The repo used pnpm workspaces with `tsx` to run the eval runner. Bun covers installs, workspaces, script running and TypeScript execution in one tool.

## Decision

- Workspaces move to the root `package.json`; `pnpm-workspace.yaml` and `pnpm-lock.yaml` are replaced by `bun.lock`. `bunfig.toml` keeps the minimum release age and its Anvia exclusions. `trustedDependencies` allows `esbuild`; the other build scripts stay blocked.
- Scripts use `bun run --filter`. The eval runner runs directly with `bun` and `tsx` is removed.
- CI installs Bun with `oven-sh/setup-bun` from `.bun-version`. `actions/setup-node` stays, because Vitest and tsup run on Node and the Action targets `node24`.
- Dependency patches use `bun patch` ([rule 0003](../rules/0003-anvia-bugs-and-patches.md)).

## Not changed

- The Action runtime stays `node24` with a tsup bundle ([0003](0003-bundled-node24-js-action.md)). Running the Action on Bun would need Bun preinstalled on every runner and break [rule 0005](../rules/0005-runner-portability.md).
- Vitest stays the test runner; `bun test` is not used.

## Consequences

- Contributors need Bun 1.4+ and Node 24.
- A pnpm-only feature (`allowBuilds`, pinned-age exclusions by version) maps to `trustedDependencies` and name-level `minimumReleaseAgeExcludes`.
