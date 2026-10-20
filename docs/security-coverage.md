# Security coverage (PRD §9, S1–S9)

Notice for fork PRs: `pull_request` runs from forks get no secrets, so no
model key is available. The action entry skips automatic fork reviews before requiring a model key.
Action integration tests cover that notice and authorized maintainer commands.

| ID  | Requirement                                          | Test file                      | Test name(s)                                                                                                         |
| --- | ---------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| S1  | Comment triggers need write+ via permission API      | `security/s1.test.ts`          | allows write/maintain/admin; denies read/none/triage; permission check failed; bots denied; fork boundary documented |
| S2  | No `pull_request_target` in templates/docs           | `security/s2.test.ts`          | action.yml/README/ci.yml clean; docs only as prohibition                                                             |
| S3  | No code execution; read-only checkout and tools      | `security/s3.test.ts`          | no install/build/npm/pnpm/lfs; hooksPath /dev/null; exact tool names                                                 |
| S4  | Path guard and denylist                              | `security/s4.test.ts`          | .env/.pem/.key/id_rsa/.git rejected; symlink/traversal/absolute/>1MB; search hides denylisted                        |
| S5  | Review POST allowlist (COMMENT only)                 | `security/s5.test.ts`          | event COMMENT; assertCommentEvent throws; no approve/merge/label/push                                                |
| S6  | Secret redaction before posting                      | `security/s6.test.ts`          | sk-/sk-ant-/AKIA/ghp_/pat/JWT/PEM/hex redacted; applied in postPullReview                                            |
| S7  | Comment sanitising                                   | `security/s7.test.ts`          | @mentions neutralised; HTML/images stripped; repo-only links; 4000 cap                                               |
| S8  | Base-branch config; host keys rejected; caps clamped | `security/s8.test.ts`          | host-level keys rejected; caps clamped; base content only                                                            |
| S9  | No telemetry; README statement                       | `security/s9.test.ts`          | no fetch/http in core+action src; README model-provider-only                                                         |
| Adv | Adversarial fixtures (PRD §11)                       | `security/adversarial.test.ts` | untrusted wrapper; prompt excludes body; injected filename; symlink rejected                                         |

Action boundary coverage lives in `packages/action/test/run.test.ts`,
`github.test.ts`, and `checkout.test.ts`: permission rejection precedes PR
reads, config/guidance refs are pinned to the base SHA, stale results are
discarded, spoofed sticky markers are ignored, mutations are allowlisted,
archive traversal and links are rejected, and post cleanup stays under
RUNNER_TEMP. A same-repository Haiku 5.5 review passed on GitHub-hosted
Linux x64; see [sandbox evidence](sandbox.md). Fork commands, the complete
adversarial corpus, other live providers and runner network configurations
still need live acceptance.
