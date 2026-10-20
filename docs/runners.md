# Supported runners

Source: `docs/PRD.md` §8.9 support matrix. Status reflects which jobs are
actually enabled in `.github/workflows/runner-matrix.yml`.

| Runner                                                          | Arch      | Status                       |
| --------------------------------------------------------------- | --------- | ---------------------------- |
| GitHub-hosted `ubuntu-latest`                                   | x64       | CI + live Haiku/Muse sandbox |
| GitHub-hosted `ubuntu-24.04-arm`                                | arm64     | verified in CI matrix        |
| Blacksmith `blacksmith-2vcpu-ubuntu-2404`                       | x64       | CI build/tests passed        |
| Blacksmith `blacksmith-2vcpu-ubuntu-2404-arm`                   | arm64     | CI build/tests passed        |
| Self-hosted Linux (minimal container, no `git`, behind proxy)   | x64       | not yet verified             |
| Other drop-in providers (Depot, Namespace, RunsOn, Ubicloud, …) | x64/arm64 | not yet verified             |
| macOS / Windows runners                                         | —         | not yet verified             |

Blacksmith and self-hosted entries are present in the matrix but marked
`continue-on-error` / `if: false`, so they do not gate releases. The live
end-to-end sandbox job is opt-in; see [sandbox setup](sandbox.md). Build/test
passes do not establish live review acceptance.
