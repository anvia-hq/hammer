# Eval harness (PRD §11)

Offline and model-backed evaluation for Hammer. The full PRD target is 40
seeded-defect PRs, 20 clean PRs and 10 adversarial PRs; this task ships
31 cases as **synthetic before/after files** (not real OSS history):

- `cases/seeded-*`: 20 seeded-defect cases with expected findings
  (path, line range, category, severity). Each seed has a hidden behavioral witness that passes on the complete before file and fails on the complete after file.
- `cases/clean-*`: 6 clean cases (refactors, docs, dependency bumps)
  with zero expected findings.
- `cases/adversarial-*`: 5 adversarial cases — prompt injection in the
  PR body, prompt injection in a code comment, a filename injection, a 2,000-line generated file, and an untrusted-delimiter escape. Actual symlink escapes remain covered by unit tests, not this live corpus.

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

These are synthetic fixtures. The shipped cases include complete files with correct hunk counts. Seeded behavior is checked by `test/fixtures.test.ts`; the model sees the code and public contract, never the hidden witness or expected labels. Tests execute only curated fixture code, while the reviewer stays read-only. Arbitrary partial patches still reconstruct missing lines as blank and cannot establish accuracy on complete real-world repositories. The 70-case launch corpus,
manual judge spot-checks, regression baseline, and launch metrics remain
outstanding. An offline oracle PASS never establishes model quality.

## Private-repository evaluation action

A release ref also exposes `anvia-hq/hammer/eval@<sha>`. This composite action installs the trusted Hammer workspace, runs the same CLI with separate reviewer/judge secrets, publishes a job summary, and returns `report-path`. It runs Hammer's synthetic fixtures; it does not check out or execute the sandbox PR. This is evaluation tooling, separate from the bundled production review Action's install-free runtime. The caller can retain the reports as private workflow artifacts.

Each unmatched judgment includes its candidate finding so the entries marked `humanSpotCheck` can be checked against the fixture patch. Reports also record whether native JSON schema was enabled. Keep model outputs and reports out of version control.

The earlier corpus contained incomplete functions, pre-existing behavior labeled as newly introduced defects, low-severity seeds hidden by the default policy, and malformed hunk counts. Its interrupted live runs are invalid as quality evidence. The repaired corpus replaces those with executable before/after witnesses and neutral PR descriptions; the full 70-case real-repository corpus remains outstanding.

`--concurrency 1` is the default. Set a value from 1 through 8 to evaluate independent cases concurrently; each case retains its own checkout, agent and budget. Reports preserve case order and record concurrency. Latency measured under parallel load should not be compared directly with a serial run.
