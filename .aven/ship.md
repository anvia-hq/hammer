Ship this thread's work as a pull request against `main`.

1. Work in small steps and commit in small atomic commits: one commit per
   logical change with a short descriptive message (the repo keeps
   history as-is, see `git log --oneline`). Never commit `dist/`
   (release commits only), `.env` files, secrets, or trace payloads.
2. Rebase onto the default branch first:
   `git fetch origin main && git rebase origin/main`.
   Resolve conflicts in favour of a clean rebase; stop and tell me if a
   conflict touches code you did not write.
3. Run the checks CI runs, in this order, and fix what you broke:
   `bun run check && bun run typecheck && bun run test && bun run build && node packages/action/scripts/smoke-bundle.mjs && node packages/action/scripts/smoke-review.mjs`.
   If something fails that you cannot fix, stop and tell me.
4. Push the thread's branch with `git push -u origin HEAD`. Never push to
   `main`, never force-push `main`.
5. Open a pull request as ready for review (not draft):
   `gh pr create --base main --title "<type>/<topic>: <summary>"`.
   Keep the thread's branch. If one is already open for this branch, the
   push updates it; adjust its body instead of opening another.
6. The PR body must hold: what changed, why, how it was tested with the
   pasted output of the checks from step 3 as proof, and risks/follow-ups.
7. Add exactly one release label, whichever fits the change:
   `breaking`, `enhancement`, `bug`, `documentation`, or `chore`
   (`gh pr edit --add-label <label>`). CI fails without exactly one.
8. Do not merge. Tell me the pull request's URL.
