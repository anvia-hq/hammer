import { describe, expect, it } from "vitest";

import { postPullReview, type CreateReviewPayload } from "../../src/github/review";
import { redactSecrets, REDACTED } from "../../src/github/sanitize";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
const PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0",
  "-----END PRIVATE KEY-----",
].join("\n");

describe("S6 secret redaction", () => {
  for (const secret of [
    "sk-abcdefghijklmnopqr",
    "sk-ant-abcdefghijklmnop",
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_abcdefghijklmnopqr",
    "github_pat_abcdefghijklmnopqr",
    JWT,
    PEM,
    "a".repeat(40),
  ]) {
    it(`redacts ${secret.slice(0, 12)}...`, () => {
      const out = redactSecrets(`leak ${secret} end`);
      expect(out).not.toContain(secret);
      expect(out).toContain(REDACTED);
    });
  }

  it("sanitizeForPosting is applied in postPullReview", async () => {
    const seen: CreateReviewPayload[] = [];
    await postPullReview(
      {
        owner: "o",
        repo: "r",
        pullNumber: 1,
        commitId: "abc",
        inline: [{ path: "a.ts", line: 1, body: "key sk-abcdefghijklmnopqr" }],
        body: "token ghp_abcdefghijklmnopqr",
      },
      { createReview: async (p) => void seen.push(p) },
    );
    expect(seen[0]!.body).not.toContain("ghp_abcdefghijklmnopqr");
    expect(seen[0]!.comments[0]!.body).not.toContain("sk-abcdefghijklmnopqr");
    expect(seen[0]!.body).toContain(REDACTED);
  });
});
