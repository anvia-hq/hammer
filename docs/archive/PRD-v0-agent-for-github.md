# Anvia Agent for GitHub — PRD

Oct 19, 2026 · @Indra Zulfi · Status: Draft

## Summary

Anvia Agent for GitHub lets teams run their **own** Anvia agents inside GitHub Actions — triggered by `@anvia` mentions, PR and issue events, CI failures, or a schedule — with the tools, memory and approvals they define in code.

Existing products ship one fixed bot (CodeRabbit reviews, Pullfrog and Claude Code Action code). Anvia's angle: GitHub becomes another Channel for agents built with `@anvia/core`, so a team's support agent, release agent or migration agent can live where their code lives. The MVP is an open-source GitHub Action (`anvia-dev/agent-action`) with a default coding agent; a GitHub App and hosted console follow.

## Problem and opportunity

AI-in-GitHub tools are fixed products: you get the vendor's agent, prompts and tool set, and customising beyond a prompt or config file is hard.

| Product                                                     | Type                                                  | Runs on             | Customisable agent?         |
| ----------------------------------------------------------- | ----------------------------------------------------- | ------------------- | --------------------------- |
| [Pullfrog](https://www.everydev.ai/tools/pullfrog/llms.txt) | Coding agent (review, CI fix, PRs), open source, BYOK | Your GitHub Actions | Prompts, hooks, MCP servers |
| CodeRabbit                                                  | PR reviewer, closed source, per-seat                  | Vendor cloud        | Review rules only           |
| Claude Code Action                                          | Coding agent, Anthropic models                        | Your GitHub Actions | Prompts, MCP servers        |
| Copilot coding agent                                        | Coding agent, GitHub-native                           | GitHub cloud        | Limited                     |

**The gap:** no product lets a team define an agent in code — typed tools, their own databases and vector stores, approval gates, durable runs, tracing — and deploy it to GitHub as easily as to Slack. Anvia already has every one of those pieces; GitHub is the missing Channel.

CodeRabbit and Copilot details are from general knowledge, not checked for this draft.

## Goals, non-goals and success metrics

**Goals**

1. A developer goes from zero to a working `@anvia` agent in their repo in under 10 minutes.
2. Any agent built with `@anvia/core` runs in GitHub Actions without code changes.
3. Safe by default: the agent cannot push to protected branches, read secrets from the shell, or act for users without write access.
4. Drive adoption of the Anvia SDK, Lens and future paid offerings.

**Non-goals (v1)**

- Competing as a best-in-class generic PR reviewer.
- Hosting our own runners or model inference.
- GitLab, Bitbucket or other platforms.

**Success metrics** (targets are placeholders to set)

| Metric                                                     | Target at 90 days |
| ---------------------------------------------------------- | ----------------- |
| Repos with the action installed                            | TBD               |
| Weekly agent runs                                          | TBD               |
| Run success rate (task completed, no error)                | TBD               |
| Share of runs using a custom Anvia agent (not the default) | TBD               |
| Time to first successful run                               | < 10 min          |

## Target users

| Persona                | Who                                                | What they want                                                                         |
| ---------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Anvia builder          | Developer already using `@anvia/core`              | Ship the agent they built into GitHub with one workflow file                           |
| Platform / DevEx lead  | Owns CI and tooling for a team of 10–200 engineers | Custom repo agents (release notes, migrations, triage) with guardrails and cost limits |
| Open-source maintainer | Runs a busy public repo                            | Issue triage and first-pass fixes, free, BYOK                                          |
| Security-conscious org | Can't send code to a vendor cloud                  | Runs on their own runners and model keys, with audit traces                            |

## Use cases and user stories

1. **Ad-hoc task by mention.** As a maintainer, I comment `@anvia add retries to the webhook client` on an issue, and the agent opens a PR linked to it.
2. **PR review.** As a reviewer, every new PR gets a summary and inline comments from our agent, following our own rules file.
3. **CI autofix.** As a developer, when CI fails on my agent-created PR, the agent reads the logs, pushes a fix, and reports what changed.
4. **Issue triage.** As a maintainer, new issues are labelled, de-duplicated and answered from our docs index (Anvia RAG).
5. **Custom agent.** As a platform lead, I point the action at `agents/release.ts`, an Anvia agent with our own tools, and it drafts release notes on every tag.
6. **Approval gate.** As a lead, risky tool calls (e.g. editing `migrations/`) pause until a maintainer replies `/approve`, then resume from a durable checkpoint.
7. **Scheduled job.** As a team, a nightly cron run updates dependencies and opens one grouped PR.

## Functional requirements

| ID  | Requirement                                                                                                                                      | Phase |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| F1  | Action `anvia-dev/agent-action` runs on `issue_comment`, `issues`, `pull_request`, `workflow_dispatch` and `schedule` events                     | MVP   |
| F2  | Trigger filter: `@anvia` mention, author must be OWNER / MEMBER / COLLABORATOR (configurable)                                                    | MVP   |
| F3  | Context builder: issue/PR body, comment thread, diff, changed files, failing check logs                                                          | MVP   |
| F4  | Default coding agent with tools: read/search/edit files, sandboxed `bash`, git commit/push to `anvia/*` branches, GitHub comment/PR/review/label | MVP   |
| F5  | Model selection by input (`provider/model`), keys from GitHub secrets, any Anvia provider adapter                                                | MVP   |
| F6  | Single progress comment, updated live; final status in post step even on failure                                                                 | MVP   |
| F7  | `agent:` input loads a custom Anvia agent file from the repo                                                                                     | MVP   |
| F8  | Config file `.github/anvia.yml`: modes, prompts per trigger, allowed paths, budgets                                                              | v1    |
| F9  | PR review mode with inline comments via the review API                                                                                           | v1    |
| F10 | CI autofix mode on `workflow_run` failure for agent PRs (opt-in for human PRs)                                                                   | v1    |
| F11 | Approval gates: tool call pauses, resumes on `/approve` comment using `@anvia/durable`                                                           | v1    |
| F12 | Structured output: JSON-schema `output_schema` input, `result` action output                                                                     | v1    |
| F13 | Traces to Lens / OpenTelemetry, linked from the progress comment                                                                                 | v1    |
| F14 | GitHub App: `anvia[bot]` identity, short-lived installation tokens, webhook dispatcher                                                           | v2    |
| F15 | Console: run history, usage and cost per repo, org-wide config, budgets                                                                          | v2    |
| F16 | Headless browser tool for UI checks and screenshots                                                                                              | v2    |

## Architecture

&#91;embedded content: architecture · event to runner to GitHub\]

Everything runs on the customer's own runner and model keys; the agent never touches git or GitHub except through guarded tools.

| Component                                | Build or reuse                |
| ---------------------------------------- | ----------------------------- |
| Workflow template + `action.yml`         | Build (small)                 |
| Context builder                          | Build                         |
| Agent loop, provider adapters, memory    | Reuse `@anvia/core`           |
| Guarded tools (files, bash, git, GitHub) | Build on Anvia governed tools |
| Approvals and resume                     | Reuse `@anvia/durable`        |
| Tracing                                  | Reuse Lens / OpenTelemetry    |
| GitHub App + dispatcher, console         | Build (v2)                    |

## Security and trust

Limits are enforced in the tool layer, never only in the prompt: issue and PR text is untrusted input and may contain prompt injection.

| ID  | Requirement                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Only users with write access can trigger runs; fork PRs never run with secrets (no `pull_request_target` on fork code)             |
| S2  | `bash` runs in a child process with a scrubbed environment: no `GITHUB_TOKEN`, model keys or other secrets; time and output limits |
| S3  | Git tools push only to `anvia/*` branches; protected and default branches are refused in code                                      |
| S4  | File tools are limited to the workspace; denylist for `.github/workflows/**` unless explicitly allowed                             |
| S5  | Secrets masked in logs (`::add-mask::`); prompts and tool output scanned for leaked key patterns before posting                    |
| S6  | Least-privilege `permissions:` in the template workflow; App tokens scoped to one repo and revoked in the post step                |
| S7  | Per-run caps: max turns, max tokens, max cost, job `timeout-minutes`                                                               |
| S8  | Every tool call traced and attributed to the triggering user for audit                                                             |

## Pricing and business model

Proposed: the action stays free and MIT-licensed; revenue comes from the hosted layer, not the agent.

| Tier        | Includes                                                                     | Price                    |
| ----------- | ---------------------------------------------------------------------------- | ------------------------ |
| Open source | Action, default agent, custom agents, BYOK, self-hosted Lens                 | Free                     |
| Team        | GitHub App (`anvia[bot]`), console, run history, budgets, hosted Lens traces | TBD per repo or per seat |
| Enterprise  | Org-wide config, SSO, audit export, self-hosted console, support             | Contact                  |

Optional later: a model router billed at provider cost plus a small fee. Pullfrog charges no markup on its router, so pricing here needs a competitive check.

## Roadmap

&#91;embedded content: roadmap · 3 phases, 2 gates\]

Durations and gate thresholds are proposals to confirm; each phase starts only once the gate before it is met.

## Risks and open questions

| Risk                                                          | Mitigation                                                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Crowded market; seen as a Pullfrog clone                      | Lead with custom agents, not the default bot; ship examples Pullfrog can't do (RAG triage, approval gates) |
| Prompt injection leads to a bad push or leak                  | S1–S8 enforced in code; agent branches only; human merges                                                  |
| Model cost surprises for users                                | Per-run caps, cost in the final comment, budgets in console                                                |
| GitHub Actions limits (6 h job cap, cold start, minutes cost) | Durable checkpoints to resume; Docker image cached for fast start                                          |
| Small team spread across SDK and new product                  | Keep MVP to the action only; App and console after traction                                                |

**Open questions**

- [ ] Ship as a Node action (fast) or Docker action (isolation, browser support)?
- [ ] Default model and whether to offer a hosted router at launch
- [ ] Should custom agents be TypeScript files only, or also a YAML spec?
- [ ] Pricing unit for Team tier: per repo, per seat, or per run?
- [ ] Name: "Anvia Agent for GitHub", "Anvia Actions", or a separate brand?

## Sources

- [Pullfrog on EveryDev](https://www.everydev.ai/tools/pullfrog/llms.txt)
- [Let's Data Science: Pullfrog launch coverage](https://letsdatascience.com/news/pullfrog-delivers-open-source-github-actions-automation-97cebaa1)
- [Pullfrog docs](https://docs.pullfrog.com)
- [anvia.dev](https://www.anvia.dev)
