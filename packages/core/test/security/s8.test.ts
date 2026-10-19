import { describe, expect, it } from "vitest";

import { loadConfig, resolveConfig } from "../../src/config";

describe("S8 config from base branch", () => {
  for (const key of [
    "base-url",
    "base_url",
    "lens-endpoint",
    "otel-endpoint",
    "token",
    "api-key",
    "apiKey",
  ]) {
    it(`rejects host-level key "${key}"`, () => {
      expect(() => loadConfig(`${key}: https://example.com\n`)).toThrow(/host-level/);
    });
  }

  it("clamps repo caps to input values", () => {
    const config = loadConfig("max_files: 500\nmax_tokens: 999999\n");
    const resolved = resolveConfig(config, { max_files: 50, max_tokens: 100 });
    expect(resolved.max_files).toBe(50);
    expect(resolved.max_tokens).toBe(100);
  });

  it("uses base branch content only, never the PR head", () => {
    const base = loadConfig("min_severity: high\n");
    expect(base.min_severity).toBe("high");
    expect(loadConfig("").min_severity).toBe("medium");
  });
});
