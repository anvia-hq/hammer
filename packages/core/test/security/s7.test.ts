import { describe, expect, it } from "vitest";

import { MAX_COMMENT_CHARS, sanitizeComment } from "../../src/github/sanitize";

describe("S7 comment sanitising", () => {
  it("neutralises @mentions", () => {
    const out = sanitizeComment("hey @sam look");
    expect(out).not.toBe("hey @sam look");
    expect(out).toContain("@");
    expect(out).toContain("sam");
  });

  it("strips raw HTML and images", () => {
    const out = sanitizeComment("see ![alt](http://x/y.png) and <b>bold</b> ok");
    expect(out).not.toContain("![alt]");
    expect(out).not.toContain("<b>");
    expect(out).toContain("bold");
  });

  it("keeps only github.com/<owner>/<repo> links", () => {
    const kept = sanitizeComment("[pr](https://github.com/octo/hello/pull/1)", {
      owner: "octo",
      repo: "hello",
    });
    expect(kept).toContain("https://github.com/octo/hello/pull/1");
    expect(sanitizeComment("[e](https://evil.example/x)", { owner: "octo", repo: "hello" })).toBe(
      "e",
    );
    expect(
      sanitizeComment("[o](https://github.com/other/repo/pull/2)", {
        owner: "octo",
        repo: "hello",
      }),
    ).toBe("o");
  });

  it("caps length at 4000", () => {
    const out = sanitizeComment("x".repeat(5000));
    expect(out.length).toBe(MAX_COMMENT_CHARS);
    expect(MAX_COMMENT_CHARS).toBe(4000);
  });
});
