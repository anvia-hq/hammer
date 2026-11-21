import { describe, expect, it } from "vitest";
import { configOverrides, readInputs } from "../src/inputs";

function read(values: Record<string, string>) {
  return readInputs((name) => values[name] ?? "");
}

describe("readInputs size caps", () => {
  it("leaves caps unset when the workflow does not pass them", () => {
    const inputs = read({});
    expect(inputs.max_files).toBeUndefined();
    expect(inputs.max_diff_lines).toBeUndefined();
    expect(inputs.max_turns).toBeUndefined();
    const overrides = configOverrides(inputs);
    expect(overrides).not.toHaveProperty("max_files");
    expect(overrides).not.toHaveProperty("max_diff_lines");
    expect(overrides).not.toHaveProperty("max_turns");
  });

  it("passes an explicit workflow value through as a ceiling", () => {
    const overrides = configOverrides(read({ max_files: "20", max_turns: "30" }));
    expect(overrides).toMatchObject({ max_files: 20, max_turns: 30 });
  });
});

describe("readInputs claude-agent-sdk inputs", () => {
  it("accepts a subscription token and an explicit claude path without an api key", () => {
    const inputs = read({
      client: "claude-agent-sdk",
      model: "claude-sonnet-4-5",
      "oauth-token": "sk-ant-oat",
      "claude-path": "/opt/claude",
    });
    expect(inputs["api-key"]).toBe("");
    expect(inputs["oauth-token"]).toBe("sk-ant-oat");
    expect(inputs["claude-path"]).toBe("/opt/claude");
  });

  it("leaves both optional so the environment can supply them", () => {
    const inputs = read({ client: "anthropic", model: "claude-sonnet-5-5" });
    expect(inputs["oauth-token"]).toBe("");
    expect(inputs["claude-path"]).toBe("");
  });
});
