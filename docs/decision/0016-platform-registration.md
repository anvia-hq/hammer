# 0016: Register repositories with the Hammer platform through GitHub sign-in

## Status

Accepted. Amends [0014](0014-platform-token-broker.md): the token broker's mechanics stay as they are, and it now mints only for repositories a user has registered. Amended again 2026-10-28: the admin check uses the App's own installation token instead of the user's OAuth token (see below), so sign-in needs no repository scope and the user's OAuth token is never used for anything beyond identifying them.

## Context

0014 let the platform mint an installation token for any repository where the Hammer App is installed. That is enough for a branded bot, but it leaves no record of who asked for the bot on a repository and no way to stop it except uninstalling the App.

Users need a way to register a repository, so the platform can tell which repositories it serves and who approved them. Two rules from earlier decisions still hold: the reviewer runs on the user's runner with the user's model key, and the platform never receives code, diffs or model keys.

## Decision

- **Sign-in is GitHub only.** The platform uses better-auth with its GitHub OAuth provider, requesting no scopes beyond identity (`read:user`). There is no email or password login.
- **Registration checks rights on GitHub, not in the platform's own records.** When a user registers `owner/repo`, the platform confirms, in this order:
  1. the Hammer App is installed on the repository (the installation lookup from [0014](0014-platform-token-broker.md) succeeds), and
  2. the signed-in user has admin permission on it, checked with the App's own installation token (`GET /repos/{owner}/{repo}/collaborators/{username}/permission`), not the user's OAuth token.
     If either check fails, nothing is stored.
- **Stored per registration:** the registering user's GitHub id and login, the repository id and full name, the installation id, and the time of registration. Nothing else about the user is kept.
- **The user's OAuth access token is discarded right after sign-in and never used for anything else**, including the admin check above. Better-auth's own account table is configured not to retain it. The platform holds no long-lived user credential.
- **The Action refuses unregistered repositories.** The Action does not fall back to the workflow token. A run without a platform token fails with the reason and the install link. This is what makes registration a gate rather than an option.
- **Token minting requires a registration.** The OIDC flow from 0014 is unchanged, except that the platform also requires an active registration for the repository named in the verified claims. An unregistered repository gets no token.
- **Users never give the platform a model key or a secret.** Model keys stay in the repository's GitHub secrets, which is how the workflow already works.
- **Unregistering** deletes the registration, so minting stops immediately. Uninstalling the App also stops minting.
- **Scope of a sign-in** is the user's own admin rights. A user can register only repositories they administer, and the platform never grants more than the App's installation already does.

## Consequences

- The platform now has user accounts, sessions and an OAuth client secret. Those are new things to protect, and the session store and the secret must be treated as security-critical, as 0014 already requires for the App key.
- Admin rights are checked when a repository is registered. If someone loses admin rights later, their registration stays active until they or another admin unregister it. We accept that for now; a periodic recheck is a possible later step.
- A repository gets its branded identity only after an admin registers it. Repositories that were already using the App through 0014 need one registration to keep working.
- GitHub Enterprise Server users need the platform to be configured with their instance's OAuth endpoints. This ADR covers github.com only.
- The GitHub user token is held only for the duration of sign-in, never for a registration request, which keeps the platform's stored data limited to ids and timestamps.
- Registrations are keyed by the repository's numeric id, not its owner/name, so a rename does not silently drop or transfer a registration, and a deleted-then-recreated repository with the same name does not inherit one.
