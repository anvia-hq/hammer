# Eval harness (PRD §11)

Deterministic offline evaluation for Hammer. The full PRD target is 40
seeded-defect PRs, 20 clean PRs and 10 adversarial PRs; this task ships
31 cases as **small synthetic patches** (not real OSS history):

- `cases/seeded-*`: 20 seeded-defect cases with expected findings
  (path, line range, category, severity).
- `cases/clean-*`: 6 clean cases (refactors, docs, dependency bumps)
  with zero expected findings.
- `cases/adversarial-*`: 5 adversarial cases — prompt injection in the
  PR body, prompt injection in a code comment, a filename injection
  combined with a symlink escape, a huge generated file, and an untrusted-delimiter escape.

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
- `src/judge.ts` — independent model judge for unmatched findings.
- `src/live.ts` — model-backed pipeline runs, scoring, measurements, and reports.
- `src/index.ts` — CLI: offline oracle by default, live evaluation with `--model`.
- `scripts/gen-cases.ts` — regenerates the 31 fixtures.

## Reviewers

The default CLI reviewer is the offline **oracle**: it returns the
expected findings for seeded cases and nothing for clean or adversarial
cases, so the harness itself is checked deterministically. Real model evaluation is available separately:

```sh
# Supply HAMMER_API_KEY and HAMMER_JUDGE_API_KEY through the environment.
pnpm eval --model anthropic/claude-sonnet-4-5 --judge-model gemini/gemini-2.5-flash
```

Use `--no-native-json-schema` when an OpenAI-compatible endpoint does not support native JSON-schema output. Findings still pass local Zod validation and one repair attempt.

Use `--base-url` for an OpenAI-compatible reviewer, `--judge-base-url` for an
OpenAI-compatible judge, `--no-verify` for a verification-off comparison, and
`--reports-dir` to preserve each comparison in its own directory. The judge
must use a different provider/model reference. Without a judge, scoring uses
strict fixture matching and the report says so.

Live reports go to `reports/live/` and identify the reviewer, judge,
verification setting, per-case latency, reviewer tokens/cost, and judgments.
Every fifth judgment is marked for a human spot-check. Judge tokens are
reported separately; judge cost is not included in reviewer cost. Unknown
reviewer prices report null cost. Live reports use an M1 precision gate of
70%, high-severity recall of 60%, run success of 98%, and all adversarial
cases passing; launch precision remains 80% per the PRD.

These are synthetic patch fixtures. Live runs reconstruct only the lines
present in each patch and leave other lines blank; they cannot establish
accuracy on complete real-world repositories. The 70-case launch corpus,
manual judge spot-checks, regression baseline, and launch metrics remain
outstanding. An offline oracle PASS never establishes model quality.
