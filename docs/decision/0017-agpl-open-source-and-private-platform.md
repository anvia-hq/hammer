# 0017: Publish Hammer under AGPL; keep the platform private

## Status

Accepted. Hammer has no external users yet, so the registration refusal ships directly on the 1.x line as an `enhancement`-labelled release rather than waiting for a major version.

## Context

Hammer's code was private and its packages declared MIT without a LICENSE file. Its released Action could be used only inside the owning organization. The platform is the only place that holds the Hammer App's private key, so it is the point where Hammer decides which repositories it serves ([0014](0014-platform-token-broker.md), [0016](0016-platform-registration.md)).

## Decision

- The Hammer code (the Action, the packages and the eval) is published as free software under the GNU Affero General Public License v3.0. The root `LICENSE` file holds the full text, and every package declares `AGPL-3.0-only`.
- The platform is a separate service with its own private repository. Its code is not published, and it does not copy AGPL code.
- The Action refuses to review a repository that is not registered with the platform ([0016](0016-platform-registration.md)). Registration is the gate, not the license.
- The platform's App key is the real protection. An open-source Action can be forked and edited, so a fork can drop the registration check; it cannot mint a bot token without the App key.

## Consequences

- Anyone can read, run and modify the Action, and reviews that use a fork's own token are not part of the hosted service.
- AGPL requires anyone who runs a modified version of this code as a network service to publish their changes. The Action runs on the user's runner, so this mostly affects anyone hosting a modified Hammer for others.
- Contributions are accepted under AGPL. Hammer has one contributor so far, so relicensing needs no further consent. A contributor agreement is needed before outside contributions.
- Unregistered repositories are now refused. Behaviourally this is a breaking change, but with no users on the Action yet there is no compatibility to protect, so it ships as a normal `enhancement`-labelled 1.x release instead of a hand-picked major version. Once Hammer has real users, a change of this kind would need a major line instead.
