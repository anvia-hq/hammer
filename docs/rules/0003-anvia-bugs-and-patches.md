# 0003: Record every Anvia bug, and patch it in `patches/`

## Status

Accepted

## Rule

When a bug turns out to be in a published `@anvia/*` package, not in this repository, record it in `docs/anvia-bug/` before working around it.

- **One record per bug.** Name it `docs/anvia-bug/NNNN-short-name.md`, numbered in order, and follow [the template](../anvia-bug/0000-template.md). State the package and exact version, how to reproduce it, what happens, what should happen, and the workaround.
- **Confirm it is Anvia's bug first.** Reproduce it against the package itself, not only through our code. If the cause is in our code or another library, fix it there and do not file it here.
- **Patch, don't fork.** When the fix belongs inside the package, patch it with pnpm:
  1. `pnpm patch @anvia/<package>@<version>` prepares the package for editing and prints its path.
  2. Edit the files at that path.
  3. `pnpm patch-commit <path>` writes the patch file to `patches/` and records it under `patchedDependencies`.
- **Link both ways.** The bug record names its patch file. Mention the record's number when you report the patch.
- **Keep records current.** When a new Anvia release fixes the bug, upgrade, delete the patch and its `patchedDependencies` entry, and set the record's status to `Fixed in <version>`. Do not delete the record.
- **Keep workarounds small.** A workaround outside `patches/` must name its bug record, in a comment if needed (this is a case [0002](0002-comments.md) allows).

## Rationale

Anvia packages are dependencies of a separate release train. Recording each bug keeps the reason for every patch visible, gives the Anvia maintainers a ready report, and tells us what to remove when a fixed version ships. Patches are bundled into the action like any other code, so they must be reviewable and tied to an exact version. See [0002](../decision/0002-consume-published-anvia-packages.md).

## Applies to

Every `@anvia/*` package used anywhere in the repository.
