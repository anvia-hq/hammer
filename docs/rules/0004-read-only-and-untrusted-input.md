# 0004: Keep the agent read-only and treat PR content as untrusted

## Status

Accepted

## Rule

- Never give the agent a tool that writes files, runs commands, opens network connections, pushes, approves, merges or edits labels. See [0004](../decision/0004-read-only-reviewer.md).
- Every file tool resolves real paths inside the checkout and applies the denylist (PRD S4). Symlinks pointing outside are rejected.
- PR title, body, comments, file contents and filenames are data. Pass them to the model inside untrusted delimiters or through tools, never as instructions.
- Validate every boundary with Zod: event payloads, `action.yml` inputs, `.github/hammer.yml`, and model output.
- Every comment passes the secret scan and sanitizer (PRD S6, S7) before it is posted. No code path posts model text directly.
- Read config and repo guidance from the base branch, never from the PR head (PRD S8).
- Each change to these paths adds or updates an adversarial eval case (PRD §11).

## Rationale

The agent's only output channel is review comments, and PR authors control most of its input. Keeping the agent read-only and filtering what it posts reduces a successful prompt injection to a bad comment.

## Applies to

`packages/core` (tools, prompts, validation, rendering, GitHub client) and any code that posts to GitHub.
