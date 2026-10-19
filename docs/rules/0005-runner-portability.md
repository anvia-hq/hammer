# 0005: Keep the action portable across runners

## Status

Accepted

## Rule

Hammer must run unchanged on GitHub-hosted, Blacksmith and self-hosted Linux runners, on x64 and arm64 (PRD §8.9).

- Add only pure-JavaScript dependencies. No native modules, `postinstall` binaries, or tools downloaded at runtime.
- Do not rely on tools preinstalled on GitHub-hosted images. `git` is optional and has the API tarball fallback.
- Write only under `RUNNER_TEMP`, and clean up in the post step.
- Read GitHub hosts from `GITHUB_API_URL` and `GITHUB_SERVER_URL`. Never hard-code `api.github.com`.
- Honour `HTTPS_PROXY`, `NO_PROXY` and `NODE_EXTRA_CA_CERTS` for every outbound call.
- Do not use the Actions cache or artifacts.

## Rationale

Teams move to Blacksmith or self-hosted runners for speed, cost or network control. Each of these rules covers a way an action breaks on a runner that is not GitHub-hosted. See [0003](../decision/0003-bundled-node24-js-action.md).

## Applies to

All code bundled into `packages/action/dist`, and every new dependency.
