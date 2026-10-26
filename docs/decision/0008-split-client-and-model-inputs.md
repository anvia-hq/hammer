# 0008: Split `model` into `client` + `model`, add `azure` and `reasoning-effort`

## Status

Accepted

## Context

The action's `model` input packed the provider and model id into one string (`provider/model-id`), parsed by splitting on the first `/`. This read awkwardly for providers whose model ids contain no natural separator, gave no separate place to pick a client, and had no way to request a specific reasoning effort. There is no shipped consumer of `anvia-hq/hammer@v1` yet beyond this repo's own dogfood workflow, so the input contract can change without a migration period.

The `@anvia/azure` package (`AzureOpenAIClient`, wrapping `@anvia/openai`'s model ids and controls) is a published Anvia package, so Azure OpenAI gets a first-class client instead of going through `openai-compatible` with a manually supplied base URL.

## Decision

- Replace `model: provider/model-id` with two inputs: `client` (`anthropic` | `openai` | `gemini` | `openai-compatible` | `azure`) and `model` (a bare model id for that client).
- Add `@anvia/azure` as a `packages/agents` dependency and a `createAzureModel` factory in `model.ts`, alongside the existing anthropic/openai/gemini/openai-compatible factories. Azure reuses `base-url` for its endpoint, the same input `openai-compatible` already uses.
- Add an optional `reasoning-effort` input, forwarded as a `reasoningEffort` completion control on every agent call (review batches and the verifier). If the chosen model doesn't support the requested control or value, the Anvia SDK throws `CompletionCapabilityError` before any request is sent; Hammer surfaces that as a run failure rather than silently ignoring the setting.
- Internally, `packages/agents`' `parseModelRefWithBase`/`createCompletionModel` keep taking a combined `provider/model-id` string — `packages/action` builds that string from `client` + `model` before calling in, so pricing lookups (`pricing.json` is keyed `provider/model-id`) and the existing internal provider-parsing tests are unaffected.

## Consequences

- Breaking change to the action's public inputs (`model`'s meaning changes, `client` is newly required). Acceptable because there's no external consumer yet.
- Azure OpenAI users get `client: azure` instead of reverse-engineering `openai-compatible` against an Azure endpoint.
- `reasoning-effort` only takes effect on models that declare a `reasoningEffort` control (model-dependent per the anthropic/openai/gemini/azure SDKs); unsupported requests fail fast and loud instead of being dropped.
- Updates [0002](0002-consume-published-anvia-packages.md): `@anvia/azure` joins the set of published Anvia packages Hammer builds on.
