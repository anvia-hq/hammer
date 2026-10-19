# 0006: Use Oxlint and Oxfmt

## Status

Accepted

## Context

The project needs a linter and formatter. The Anvia SDK repo uses Oxlint and Oxfmt, and matching it keeps code style consistent across Anvia repositories.

## Decision

Use Oxlint ([.oxlintrc.json](../../.oxlintrc.json)) and Oxfmt ([.oxfmtrc.json](../../.oxfmtrc.json)) with the SDK's settings: 2 spaces, double quotes, semicolons, trailing commas, 100 columns. Run them through `pnpm check` and `pnpm check:fix`.

## Consequences

- Oxfmt also formats Markdown, so `pnpm format` reflows tables in `docs/`.
- CI fails on unformatted files or lint errors.
