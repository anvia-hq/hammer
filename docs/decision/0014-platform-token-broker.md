# 0014: Post as the Hammer GitHub App through a token broker

## Status

Accepted

## Context

Comments posted with the workflow token appear as `github-actions[bot]`, because GitHub names the author after the token's owner. A branded `hammer[bot]` needs a GitHub App token. Users should not have to create an App or hold its private key; they should only supply their model key. The PRD listed App identity as out of scope ([PRD §3](../PRD.md)) and rule [0005](../rules/0005-runner-portability.md) limits outbound calls.

## Decision

- A small service, `hammer-platform` (a separate repository, a Cloudflare Worker), holds the Hammer App's private key. The Action sends it a GitHub OIDC token (audience `hammer-platform`) at `POST /api/token`.
- The service verifies the token against GitHub's keys, takes the repository from the verified claims only, finds the App installation for that repository, and returns a short-lived installation token limited to that repository (contents read, pull requests write, issues write) plus the bot login.
- The review still runs on the user's runner with the user's model key. The service never receives code, diffs or model keys; it receives only the OIDC token.
- The Action uses the returned token for all GitHub calls and the returned login as its identity. It masks both tokens.
- Fallback: if the workflow lacks `id-token: write`, the App is not installed, or the service fails or times out (10s per request), the Action logs why and uses `github-token`. Branding never fails a review.
- `bot-login` set means the caller brought their own App token; the broker is skipped. `platform-url` set to an empty string disables the broker. The URL must be https.
- The host is an input (`platform-url`) with the Hammer service as default, so a team can run its own broker.

## Consequences

- A new outbound call to a host that is neither the model provider nor GitHub, made only with the id-token permission, carrying only a short-lived OIDC token audience-bound to the platform.
- The service is security-critical: it holds the App key and decides who gets a token. Its blast radius is bounded by the token scope: one repository, three permissions, about an hour.
- A repository's own workflow can obtain a token only for itself, so a malicious repository gains nothing against another one.
- Users get the bot name by installing the App and adding `id-token: write`; nothing else changes. Fork PRs never receive `id-token` for automatic runs, so they use the workflow token as before.
- The service needs rate limiting and an uptime story before wide use; until then the fallback keeps reviews working.
