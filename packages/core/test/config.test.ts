import { describe, expect, it } from "vitest";

import {
  ConfigError,
  DEFAULT_CAPS,
  defaultRepoConfig,
  loadConfig,
  resolveConfig,
} from "../src/config";

describe("loadConfig defaults", () => {
  it("returns defaults for missing content", () => {
    for (const content of [null, undefined, "", "   \n  "]) {
      const config = loadConfig(content);
      expect(config).toEqual(defaultRepoConfig());
      expect(config.min_severity).toBe("medium");
      expect(config.max_comments).toBe(10);
      expect(config.review_drafts).toBe(false);
      expect(config.fail_on).toBe("none");
      expect(config.ignore).toEqual([]);
      expect(config.include).toEqual([]);
      expect(config.ignore_authors).toEqual(["dependabot[bot]", "renovate[bot]"]);
      expect(config.use_repo_guidelines).toBe(true);
      expect(config.language).toBe("en");
      expect(config.rules).toEqual([]);
      expect(config.path_instructions).toEqual([]);
    }
  });

  it("returns defaults for a YAML null document", () => {
    expect(loadConfig("null\n")).toEqual(defaultRepoConfig());
  });
});

describe("loadConfig valid files", () => {
  it("parses the full PRD example", () => {
    const config = loadConfig(`min_severity: medium
max_comments: 10
review_drafts: false
fail_on: none
ignore: ["**/*.generated.ts", "docs/**"]
include: []
ignore_authors: ["dependabot[bot]", "renovate[bot]"]
use_repo_guidelines: true
language: en
rules:
  - id: webhooks-idempotent
    text: Outbound webhook POSTs must send an Idempotency-Key.
  - id: no-raw-sql
    text: Use the query builder in src/db; no string-concatenated SQL.
path_instructions:
  - path: "db/migrations/**"
    text: Check migrations are backward compatible and safe on large tables.
  - path: "**/*.test.ts"
    text: Only flag tests that cannot fail or that test the wrong thing.
`);

    expect(config).toEqual({
      min_severity: "medium",
      max_comments: 10,
      review_drafts: false,
      fail_on: "none",
      ignore: ["**/*.generated.ts", "docs/**"],
      include: [],
      ignore_authors: ["dependabot[bot]", "renovate[bot]"],
      use_repo_guidelines: true,
      language: "en",
      rules: [
        {
          id: "webhooks-idempotent",
          text: "Outbound webhook POSTs must send an Idempotency-Key.",
        },
        {
          id: "no-raw-sql",
          text: "Use the query builder in src/db; no string-concatenated SQL.",
        },
      ],
      path_instructions: [
        {
          path: "db/migrations/**",
          text: "Check migrations are backward compatible and safe on large tables.",
        },
        {
          path: "**/*.test.ts",
          text: "Only flag tests that cannot fail or that test the wrong thing.",
        },
      ],
      max_files: undefined,
      max_diff_lines: undefined,
      max_turns: undefined,
      max_tokens: undefined,
      max_cost_usd: undefined,
      verify: true,
      verify_threshold: 6,
    });
  });

  it("fills unset keys with defaults", () => {
    const config = loadConfig("fail_on: high\n");
    expect(config.fail_on).toBe("high");
    expect(config.min_severity).toBe("medium");
    expect(config.ignore_authors).toEqual(["dependabot[bot]", "renovate[bot]"]);
  });

  it("warns on unknown keys and ignores them", () => {
    const warnings: string[] = [];
    const config = loadConfig("min_severity: low\ntypo_key: 42\n", {
      onWarning: (message) => warnings.push(message),
    });
    expect(config.min_severity).toBe("low");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/typo_key/);
  });
});

describe("loadConfig invalid files", () => {
  it("throws a typed readable error listing zod issues", () => {
    let error: unknown;
    try {
      loadConfig("min_severity: extreme\nmax_comments: -5\n");
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toBeInstanceOf(Error);
    const message = (error as ConfigError).message;
    expect(message).toMatch(/\.github\/hammer\.yml/);
    expect(message).toMatch(/min_severity/);
    expect(message).toMatch(/max_comments/);
  });

  it("names the configured source on validation errors", () => {
    expect(() => loadConfig("fail_on: bogus\n", { source: "custom/path.yml" })).toThrowError(
      /custom\/path\.yml/,
    );
  });

  it("rejects non-mapping documents", () => {
    expect(() => loadConfig("- just\n- a\n- list\n")).toThrowError(ConfigError);
    expect(() => loadConfig("42\n")).toThrowError(ConfigError);
  });

  it("rejects malformed YAML", () => {
    expect(() => loadConfig("rules: [unclosed\n  bad: : :\n")).toThrowError(ConfigError);
  });
});

describe("loadConfig host-level keys (S8)", () => {
  it.each([
    "base-url: https://example.com",
    "base_url: https://example.com",
    "lens-endpoint: https://lens.example.com",
    "otel-endpoint: https://otel.example.com",
    "api-key: sk-secret",
    "github-token: ghp_secret",
  ])("rejects %s", (line) => {
    expect(() => loadConfig(`${line}\n`)).toThrowError(ConfigError);
  });
});

describe("resolveConfig", () => {
  it("falls back to config then defaults", () => {
    const effective = resolveConfig(loadConfig(null));
    expect(effective.max_files).toBe(DEFAULT_CAPS.max_files);
    expect(effective.max_diff_lines).toBe(DEFAULT_CAPS.max_diff_lines);
    expect(effective.max_turns).toBe(DEFAULT_CAPS.max_turns);
    expect(effective.max_tokens).toBe(DEFAULT_CAPS.max_tokens);
    expect(effective.max_cost_usd).toBe(DEFAULT_CAPS.max_cost_usd);
  });

  it("lets action inputs override shared config values", () => {
    const effective = resolveConfig(loadConfig("min_severity: low\nmax_comments: 3\n"), {
      min_severity: "high",
      max_comments: 20,
    });
    expect(effective.min_severity).toBe("high");
    expect(effective.max_comments).toBe(20);
  });

  it("clamps repo caps at the action input values", () => {
    const effective = resolveConfig(
      loadConfig(
        "max_files: 500\nmax_diff_lines: 50000\nmax_turns: 100\nmax_tokens: 900000\nmax_cost_usd: 50\nmax_comments: 100\n",
      ),
      {
        max_files: 50,
        max_diff_lines: 3000,
        max_turns: 12,
        max_tokens: 400000,
        max_cost_usd: 1,
        max_comments: 10,
      },
    );
    expect(effective.max_files).toBe(50);
    expect(effective.max_diff_lines).toBe(3000);
    expect(effective.max_turns).toBe(12);
    expect(effective.max_tokens).toBe(400000);
    expect(effective.max_cost_usd).toBe(1);
    expect(effective.max_comments).toBe(10);
  });

  it("keeps repo caps below the inputs", () => {
    const effective = resolveConfig(loadConfig("max_files: 20\n"), { max_files: 50 });
    expect(effective.max_files).toBe(20);
  });

  it("uses repo caps when inputs are absent", () => {
    const effective = resolveConfig(loadConfig("max_files: 25\nmax_cost_usd: 2.5\n"));
    expect(effective.max_files).toBe(25);
    expect(effective.max_cost_usd).toBe(2.5);
  });
});
