# 0016: Register repositories with the Hammer platform through GitHub sign-in

## Status

Accepted. Amends [0014](0014-platform-token-broker.md): the token broker's mechanics stay as they are, and it now mints only for repositories a user has registered.

## Context

0014 let the platform mint an installation token for any repository where the Hammer App is installed. That is enough for a branded bot, but it leaves no record of who asked for the bot on a repository and no way to stop it except uninstalling the App.

Users need a way to register a repository, so the platform can tell which repositories it serves and who approved them. Two rules from earlier decisions still hold: the reviewer runs on the user's runner with the user's model key, and the platform never receives code, diffs or model keys.

## Decision

- **Sign-in is GitHub only.** The platform uses better-auth with its GitHub OAuth provider. There is no email or password login.
- **Registration checks rights on GitHub, not in the platform's own records.** When a user registers `owner/repo`, the platform, using the user's OAuth token, confirms that:
  - the user has admin permission on the repository (`GET /repos/{owner}/{repo}`, `permissions.admin`), and
  - the Hammer App is installed on it (the installation lookup succeeds for that repository).
    If either check fails, nothing is stored.
- **Stored per registration:** the registering user's GitHub id and login, the repository id and full name, the installation id, and the time of registration. Nothing else about the user is kept.
- **The user's OAuth access token is used for the checks and then discarded.** It is not stored, so the platform holds no long-lived user credential.
- **Token minting requires a registration.** The OIDC flow from 0014 is unchanged, except that the platform also requires an active registration for the repository named in the verified claims. An unregistered repository gets no token.
- **Users never give the platform a model key or a secret.** Model keys stay in the repository's GitHub secrets, which is how the workflow already works.
- **Unregistering** deletes the registration, so minting stops immediately. Uninstalling the App also stops minting.
- **Scope of a sign-in** is the user's own admin rights. A user can register only repositories they administer, and the platform never grants more than the App's installation already does.

## Consequences

- The platform now has user accounts, sessions and an OAuth client secret. Those are new things to protect, and the session store and the secret must be treated as security-critical, as 0014 already requires for the App key.
- Admin rights are checked when a repository is registered. If someone loses admin rights later, their registration stays active until they or another admin unregister it. We accept that for now; a periodic recheck is a possible later step.
- A repository gets its branded identity only after an admin registers it. Repositories that were already using the App through 0014 need one registration to keep working.
- GitHub Enterprise Server users need the platform to be configured with their instance's OAuth endpoints. This ADR covers github.com only.
- The GitHub user token is held only for the duration of the registration request, which keeps the platform's stored data limited to ids and timestamps.
