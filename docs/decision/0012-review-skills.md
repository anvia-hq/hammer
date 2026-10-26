# 0012: Load review skills through `@anvia/core/skills`, read-only

## Status

Accepted

## Context

The reviewer's guidance lived only in one prompt. Anvia's Agent Skills (`@anvia/core/skills`) package guidance as `SKILL.md` files the agent loads on demand. [addyosmani/agent-skills `code-review-and-quality`](https://github.com/addyosmani/agent-skills/blob/main/skills/code-review-and-quality/SKILL.md) (MIT) is a well-structured review method: five axes, structural remedies, severity labels, honesty rules.

Two things don't fit Hammer as written. The SDK's skill tools include `run_skill_script`, which executes files, and [rule 0004](../rules/0004-read-only-and-untrusted-input.md) forbids any tool that runs commands. And the skill assumes a reviewer that can run tests, mutate files, approve and write checklists, while Hammer posts only findings that clear a high precision bar.

## Decision

- Vendor the skill unmodified under [skills/](../../skills/), with the upstream license and a pinned source commit. Hammer's adaptations live in the reviewer prompt ([skills.ts](../../packages/agents/src/skills.ts)), not in the vendored file.
- `loadReviewSkills` loads skills with `loadSkills(skill.local(dir))` and keeps only `get_skill_instructions` and `get_skill_reference`. `run_skill_script` and `get_skill_script` are never given to the agent. A test enforces this.
- The reviewer is told to load the skill once, use it as a lens, skip what needs execution, and map its labels: Critical is high, an unprefixed Required change is medium, Optional, Nit and FYI are never findings. Hammer's posting rules still decide what is posted, so "no style nits" stands.
- The Action loads skills from the `skills/` directory next to the bundle (the tagged release commit carries the full tree). If they can't be loaded, the run warns and continues without them. The eval runner loads them too, with `--no-skills` to compare.
- Only skills shipped in this repository are loaded. Skills from a PR head are untrusted and are not read.

## Consequences

- Each batch costs one extra turn and a few thousand tokens to load the skill.
- Review quality changes with this decision. Run the evals with and without `--no-skills` before relying on it.
- Adding a skill is a directory under `skills/`, a source and license note, and an eval run.
