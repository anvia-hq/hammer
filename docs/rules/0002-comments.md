# 0002: Comment only what the code cannot say

## Status

Accepted

## Rule

Do not write comments or JSDoc by default. Add one only when the code is complex and a reader needs an explanation the code itself cannot give.

- No comments that restate what the code does, or what a name already says.
- No JSDoc on functions, types, or parameters whose names and types explain them.
- No commented-out code or commented-out sample config. Delete it.
- When a comment is needed, explain why: a non-obvious constraint, a workaround, or a surprising GitHub API behavior.

## Rationale

Comments that repeat the code add noise and go stale when the code changes. Clear names, small functions, and types carry the meaning. A rare comment then signals that something truly needs attention.

## Applies to

All code and configuration in the repository.
