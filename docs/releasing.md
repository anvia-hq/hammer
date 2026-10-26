# Releasing

Releases are cut from `main` by the manual `Release` workflow. See [0011](decision/0011-release-workflow.md) for why.

## Before you release

1. Every merged PR has one release label: `breaking`, `enhancement`, `bug`, `documentation` or `chore`. The `PR labels` check enforces it.
2. CI is green on the head of `main`. The workflow refuses to run otherwise.

## Release

1. Actions → Release → Run workflow on `main`.
2. Leave `bump` on `auto`, or force `patch` / `minor`. Tick `dry_run` first if you want to see the next version and run all gates without publishing.
3. The workflow gates, builds, commits `packages/action/dist` on a detached commit, tags that commit `v1.x.y`, moves `v1`, and creates the GitHub release with notes grouped by label.

`auto` picks `minor` if any PR since the last tag is labelled `enhancement`, otherwise `patch`. It fails if a `breaking` PR is among them; a breaking change needs a new major line, decided by hand.

## Roll back

Point `v1` back at the last good tag and force-push it:

```sh
git fetch --tags
git tag -f v1 v1.x.y
git push -f origin v1
```

Then mark the bad GitHub release as a pre-release or delete it. Users on `@v1` get the old bundle on their next run.
