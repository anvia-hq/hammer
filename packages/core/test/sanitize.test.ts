import { describe, expect, it } from "vitest";

import {
  MAX_COMMENT_CHARS,
  redactSecrets,
  sanitizeComment,
  sanitizeForPosting,
} from "../src/index";

const ZWSP = "⁠";

describe("redactSecrets", () => {
  it("redacts an OpenAI-style sk- key", () => {
    const text = redactSecrets("key is sk-abcdefghijklmnopqr done");
    expect(text).not.toContain("sk-abcdefghijklmnopqr");
    expect(text).toContain("[redacted]");
  });

  it("redacts a PEM private key block", () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const text = redactSecrets(`here ${pem} end`);
    expect(text).not.toContain("BEGIN PRIVATE KEY");
    expect(text).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
    expect(text).toContain("[redacted]");
  });

  it("redacts an AWS AKIA key", () => {
    const text = redactSecrets("id AKIAIOSFODNN7EXAMPLE here");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).toContain("[redacted]");
  });

  it("redacts a 40-char hex run", () => {
    const hex = "a".repeat(40);
    const text = redactSecrets(`sha ${hex} end`);
    expect(text).not.toContain(hex);
    expect(text).toContain("[redacted]");
  });

  it("keeps long file paths, identifiers and constants", () => {
    for (const text of [
      "See packages/core/src/github/sanitize.ts for details",
      "Rename getUserAccountSubscriptionBillingStatusFromDatabase soon",
      "const MAX_RETRY_ATTEMPTS_BEFORE_GIVING_UP_ENTIRELY = 3;",
      "handleOAuth2CallbackForTenantMigration2024Job fails",
      "packages/core/src/v2/handlers/user-profile-update-v3/index",
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  it("still redacts random-looking tokens that carry no known prefix", () => {
    for (const token of [
      "q8Zk3TfR9xLw2VbN7mYc4HdJ6pSa1UeG",
      "Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A=",
      "AbCdEf0123456789GhIjKlMnOpQrStUvWxYz+/90",
    ]) {
      const text = redactSecrets(`token ${token} end`);
      expect(text).not.toContain(token);
      expect(text).toContain("[redacted]");
    }
  });

  it("redacts anthropic keys, github tokens and jwt-like strings", () => {
    expect(redactSecrets("k sk-ant-abcdefghijklmnop done")).not.toContain(
      "sk-ant-abcdefghijklmnop",
    );
    expect(redactSecrets("t ghp_abcdefghijklmnopqr done")).not.toContain("ghp_abcdefghijklmnopqr");
    expect(redactSecrets("t github_pat_abcdefghijklmnopqr done")).not.toContain(
      "github_pat_abcdefghijklmnopqr",
    );
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
    expect(redactSecrets(`t ${jwt} done`)).not.toContain(jwt);
  });
});

describe("sanitizeComment", () => {
  it("neutralises @mentions with a zero-width space", () => {
    expect(sanitizeComment("hey @sam look")).toBe(`hey @${ZWSP}sam look`);
    expect(sanitizeComment("@sam start")).toBe(`@${ZWSP}sam start`);
    expect(sanitizeComment("email a@sam stays")).toBe("email a@sam stays");
  });

  it("strips markdown images and raw html", () => {
    const text = sanitizeComment("see ![alt](http://x/y.png) and <b>bold</b> ok");
    expect(text).not.toContain("![alt]");
    expect(text).not.toContain("<b>");
    expect(text).toContain("bold");
  });

  it("keeps structural tags but strips their attributes and dangerous tags", () => {
    const text = sanitizeComment(
      `<details open ontoggle="alert(1)"><summary class="x">Files</summary><sub>Hammer</sub></details><script>alert(1)</script>`,
    );
    expect(text).toContain("<details>");
    expect(text).toContain("<summary>Files</summary>");
    expect(text).toContain("<sub>Hammer</sub>");
    expect(text).toContain("</details>");
    expect(text).not.toContain("ontoggle");
    expect(text).not.toContain("class=");
    expect(text).not.toContain("<script>");
  });

  it("keeps github links for this repo and flattens others", () => {
    const kept = sanitizeComment("[pr](https://github.com/octo/hello/pull/1)", {
      owner: "octo",
      repo: "hello",
    });
    expect(kept).toContain("[pr](https://github.com/octo/hello/pull/1)");
    const flat = sanitizeComment("[evil](https://evil.example/x)", {
      owner: "octo",
      repo: "hello",
    });
    expect(flat).toBe("evil");
    const otherRepo = sanitizeComment("[other](https://github.com/other/repo/pull/2)", {
      owner: "octo",
      repo: "hello",
    });
    expect(otherRepo).toBe("other");
  });

  it("closes a details block that truncation cut open", () => {
    const text = sanitizeComment(
      `<details>\n<summary>More</summary>\n\n${"x ".repeat(3000)}\n\n</details>`,
    );
    expect(text.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(text.match(/<details>/g)).toHaveLength(1);
    expect(text.endsWith("</details>")).toBe(true);
  });

  it("caps length at 4000 chars with an ellipsis", () => {
    const text = sanitizeComment("x".repeat(5000));
    expect(text.length).toBe(MAX_COMMENT_CHARS);
    expect(MAX_COMMENT_CHARS).toBe(4000);
    expect(text.endsWith("…")).toBe(true);
  });

  it("applies redaction before sanitising", () => {
    const text = sanitizeForPosting("hi @sam key sk-abcdefghijklmnopqr <b>x</b>", {
      owner: "octo",
      repo: "hello",
    });
    expect(text).not.toContain("sk-abcdefghijklmnopqr");
    expect(text).not.toContain("@sam");
    expect(text).not.toContain("<b>");
    expect(text).toContain("[redacted]");
  });
});
