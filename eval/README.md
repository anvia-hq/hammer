# Eval harness (PRD §11)

Deterministic offline evaluation for Hammer. The full PRD target is 40
seeded-defect PRs, 20 clean PRs and 10 adversarial PRs; this task ships
the first 30 cases as **small synthetic patches** (not real OSS history):

- `cases/seeded-*`: 20 seeded-defect cases with expected findings
  (path, line range, category, severity).
- `cases/clean-*`: 6 clean cases (refactors, docs, dependency bumps)
  with zero expected findings.
- `cases/adversarial-*`: 4 adversarial cases — prompt injection in the
  PR body, prompt injection in a code comment, a filename injection
  combined with a symlink escape, and a huge generated file.

## Layout

- `cases/<id>/case.json` — case metadata, expected findings, injection text.
- `cases/<id>/*.patch` — unified diffs loaded as the review input.
- `src/cases.ts` — case schema and loader.
- `src/score.ts` — matching rule (path equal, finding line within ±3
  lines of the expected range, category equal) plus recall on high,
  precision, false positives per clean case, and per-case pass/fail.
- `src/runner.ts` — loads cases, takes an injected reviewer function
  `(c: EvalCase) => Finding[]`, runs core `validateFindings` on the
  findings against the case patch, scores them, and writes
  `reports/report.md` + `reports/report.json` (git-ignored).
- `src/judge.ts` — stub interface for the LLM judge (a different model
  from the reviewer). TODO, not called in the offline run.
- `src/index.ts` — CLI: runs the offline oracle reviewer.
- `scripts/gen-cases.ts` — regenerates the 30 fixtures.

## Reviewers

The default CLI reviewer is the offline **oracle**: it returns the
expected findings for seeded cases and nothing for clean or adversarial
cases, so the harness itself is checked deterministically. The second
reviewer slot — a real model run via core `runSinglePassReview` — is
documented here as the place for live evaluation and is not wired yet.
