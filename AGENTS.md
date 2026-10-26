# AGENTS.md

Guidance for coding agents working in this repository.

## Project shape

Hammer is a PR review agent shipped as a GitHub Action. The spec is `docs/PRD.md`; read the relevant section before building a component, and its §16 reference implementations.

- `packages/core` (`@anvia/hammer-core`): the review engine (config, planning, validation, dedupe, rendering, GitHub review client). Private, consumed from source (`exports` points at `src/`), no build step.
- `packages/agents` (`@anvia/hammer-agents`): the reviewer agents (model factory, prompts, read-only tools, review pipeline, verifier). Depends on core; core never imports it.
- `packages/action` (`@anvia/hammer-action`): thin Action entry (the Action runs on `node24`; Bun is only the dev and CI toolchain, see [0009](docs/decision/0009-bun-workspaces.md)). `tsup` bundles it and every dependency into `dist/index.js` and `dist/post.js`, which `action.yml` runs.
- `skills/`: Agent Skills loaded read-only by the reviewer; see [0012](docs/decision/0012-review-skills.md). Vendored skills stay unmodified.
- `eval` (`@anvia/hammer-eval`): eval runner, run with `bun run eval`.

## Commands

```sh
bun install
bun run check / bun run check:fix
bun run typecheck
bun run test
bun run build
```

## Docs

- `docs/PRD.md`: the product spec.
- `docs/decision/`: architecture decision records. Read these before changing a documented choice.
- `docs/rules/`: repository rules. Follow them in every change.
- `docs/anvia-bug/`: bugs found in the published `@anvia/*` packages, one record per bug.
- `patches/`: `bun patch` files for dependencies, each linked to its bug record.

## Conventions

- Follow [docs/rules/0001-modularity-and-separation-of-concerns.md](docs/rules/0001-modularity-and-separation-of-concerns.md). Core never touches the Actions runtime; side effects stay at the edges; pass dependencies in.
- Follow [docs/rules/0002-comments.md](docs/rules/0002-comments.md). No comments or JSDoc unless the code is complex and needs an explanation.
- Follow [docs/rules/0003-anvia-bugs-and-patches.md](docs/rules/0003-anvia-bugs-and-patches.md). Record every `@anvia/*` bug in `docs/anvia-bug/`, and fix it with `bun patch`, not by forking.
- Follow [docs/rules/0004-read-only-and-untrusted-input.md](docs/rules/0004-read-only-and-untrusted-input.md). The agent stays read-only; PR content is untrusted; every comment is filtered before posting.
- Follow [docs/rules/0005-runner-portability.md](docs/rules/0005-runner-portability.md). Pure JS dependencies, no preinstalled tools, no hard-coded GitHub hosts.
- Build on the published `@anvia/*` packages ([docs.anvia.dev](https://docs.anvia.dev)); see [0002](docs/decision/0002-consume-published-anvia-packages.md).
- Check `docs/decision/` before choosing a library, package layout or GitHub trigger.
- A workspace package must not share a name with a published npm package. See [0001](docs/decision/0001-bun-workspaces.md).
- TypeScript strict, ESM, ES2022, `moduleResolution: "Bundler"`. Run `bun run check` before reporting work as done.
- `dist/` is committed only on release branches; never edit it by hand. Releases come from the manual `Release` workflow on `main` (inputs: `bump` auto/patch/minor, `dry_run`); see [docs/releasing.md](docs/releasing.md). Every PR needs exactly one release label (`breaking`, `enhancement`, `bug`, `documentation`, `chore`).
- Never commit secrets, API keys or trace payloads.
