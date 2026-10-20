# Sandbox review

The Action run flow is implemented on the source branch. The live sandbox is [aven-harness PR #3](https://github.com/anvia-hq/aven-harness/pull/3), using `anthropic/claude-haiku-5-5`. Both repositories are private, and Hammer is available to repositories in the `anvia-hq` organization. The sandbox workflow pins the generated Action bundle on `release/sandbox-haiku-5-5`; generated bundles remain off the source branch.

## Local acceptance without credentials

Run `pnpm build` and `node packages/action/scripts/smoke-review.mjs`. This executes the built main and post bundles against local HTTP GitHub/model fixtures. It uses the published OpenAI-compatible adapter, disables git to exercise archive fallback, and checks the pinned review, sticky summary, outputs, usage and cleanup. It uses no real keys and does not contact GitHub or a model service.

## Run from Hammer's workflow

1. Create a same-repository PR in a sandbox repository with a small, known defect. The PR must be open and non-draft, with no skip label or ignored bot author.
2. In the Hammer repository's Actions secrets, set `HAMMER_API_KEY` to the reviewer's model key and `HAMMER_SANDBOX_TOKEN` to a fine-grained GitHub token scoped to the sandbox repository with contents read and pull requests write. The workflow's ordinary token remains read-only.
3. Run **Runner matrix** with `run_e2e: true`, `sandbox_repository: owner/repo`, `sandbox_pr: number`, and `model: provider/model-id`, using the branch containing the implementation.

The job builds the Action and runs its bundled main step with a sandbox PR event. It checks `result.json`, a sticky summary containing the reviewed head SHA, and a `COMMENT` review when findings exist, then runs the bundled post step. It rejects partial results. This initial smoke run uses a same-repository PR; maintainer-triggered fork behavior is covered locally and needs a separate live check.

The run posts comments to the specified PR and sends the reviewed source to the configured model provider. It does not execute the sandbox repository's code.

## Run locally

Install dependencies and build, then set these environment variables through your shell's secret-management mechanism:

- `HAMMER_SANDBOX_REPOSITORY`, `HAMMER_SANDBOX_PR`, `HAMMER_SANDBOX_MODEL`
- `HAMMER_SANDBOX_TOKEN`, `HAMMER_API_KEY`
- `GITHUB_API_URL`, `GITHUB_SERVER_URL`, `RUNNER_TEMP`
- `GITHUB_STEP_SUMMARY`: path to an existing writable Markdown file

Run `node packages/action/scripts/sandbox.mjs`. Keys are read from the environment and masked by the Action. Do not put keys on the command line or commit them.

## Current limits

The tracing inputs are rejected explicitly until the observer constructors and exporters are connected. Unknown model prices produce a warning and token-only reporting, as specified in PRD §8.3. The `pricing` input accepts a JSON mapping such as `{"openai-compatible/local":{"input":1,"output":4}}`, with USD prices per million tokens. Bundled prices cover Haiku 5.5 (including its tier above 100k input tokens), Sonnet 4.5 and Gemini 2.5 Flash ([Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Google pricing](https://ai.google.dev/gemini-api/docs/pricing)); they use standard uncached rates and therefore estimate rather than reproduce provider invoices.

Budget checks happen before each model request and after each response, including repair and verification requests. Already-running requests can exceed a threshold before their usage is returned; this is not a provider-side billing limit. Each provider request has a 120-second timeout.

Live acceptance currently covers a same-repository Haiku 5.5 review on GitHub-hosted Linux x64. Other provider/runner combinations, maintainer-triggered fork review, the full 70-case evaluation corpus, verification's precision/cost benefit, nightly real-key checks, and launch gates remain outstanding. Local tests use injected GitHub APIs and model adapters and do not prove those live paths.

The sandbox fixture is intentionally defective and must not be merged. Its test establishes the percentage contract: a 10% discount on a 1,000-cent order must return 900 cents; the fixture returns −9,000. The Action reads the repository but never executes this test. The initial run returned no findings. A diagnostic run with an explicit test contract, verification disabled and low-severity findings enabled identified the seeded defect. This is acceptance of the plumbing, not an unbiased model-quality evaluation: the PR description discloses the defect.

## Live evidence (2026-10-20)

[Verified full review](https://github.com/anvia-hq/aven-harness/actions/runs/39356491762/attempts/1): Haiku 5.5 retained the high-severity percentage defect at `scripts/hammer-sandbox/discount.ts:14`, completed verification with no partial result, and suppressed the existing inline duplicate. Usage was 22,573 tokens and an estimated $0.0029889. The post step passed.

The original diagnostic COMMENT review is [anchored to the defect](https://github.com/anvia-hq/aven-harness/pull/3#discussion_r4320718729). The full verified run did not create another review. The sticky summary remained comment `6281509708`.

[Same-head rerun](https://github.com/anvia-hq/aven-harness/actions/runs/39356491762/attempts/2) also passed with verification complete: one finding, one duplicate suppressed, 28,771 tokens, estimated $0.0036707, and a successful post step. Review and inline-comment counts did not increase; the same single sticky summary was updated.
