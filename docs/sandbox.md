# Sandbox review

The Action run flow is implemented on the source branch. Live GitHub/model acceptance remains pending until a sandbox run succeeds. Use a private repository for initial testing; public repositories work too.

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

Runner acceptance, the full 70-case evaluation corpus, verification's precision/cost benefit, and launch gates remain outstanding. Local tests use injected GitHub APIs and model adapters and do not prove live provider compatibility.

The selected live sandbox target is `anvia-hq/aven-harness`, using `anthropic/claude-haiku-5-5`. Its `HAMMER_API_KEY` Actions secret is present. The prepared fixture and workflow remain local until Git publication is authorized under that repository's AGENTS.md. Both repositories are private; using Hammer as an Action there also requires organization access for the private Action.
