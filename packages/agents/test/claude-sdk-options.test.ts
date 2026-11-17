import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ReviewBatchSchema } from "@anvia/hammer-core";
import { describe, expect, it } from "vitest";

import {
  DENIED_BUILT_IN_TOOLS,
  HAMMER_MCP_SERVER,
  SDK_EFFORT_LEVELS,
  buildSdkOptions,
  buildToolDenyHook,
  createClaudeSdkBackend,
  sdkEffort,
} from "../src/index";

function options(toolNames: string[] = ["mcp__hammer__read_file"]) {
  return buildSdkOptions({
    instructions: "You are Hammer.",
    model: "claude-sonnet-4-5",
    cwd: "/tmp/hammer-review-x/head",
    executablePath: "/tmp/hammer-claude/0.3.326/linux-x64/claude",
    configDir: "/tmp/hammer-review-x/claude-config",
    env: { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    maxTurns: 42,
    toolNames,
    partialMessages: true,
  });
}

describe("claude-agent-sdk options", () => {
  it("exposes no built-in tool and denies every write, exec and network tool", () => {
    const built = options();
    expect(built.tools).toEqual([]);
    for (const name of [
      "Bash",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Read",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "Task",
      "Agent",
      "KillShell",
      "TaskOutput",
    ]) {
      expect(built.disallowedTools).toContain(name);
    }
    expect(built.permissionMode).toBe("dontAsk");
  });

  it("runs in the checkout, reads no settings from disk and pins the binary", () => {
    const built = options();
    expect(built.cwd).toBe("/tmp/hammer-review-x/head");
    expect(built.settingSources).toEqual([]);
    expect(built.pathToClaudeCodeExecutable).toBe("/tmp/hammer-claude/0.3.326/linux-x64/claude");
    expect(built.model).toBe("claude-sonnet-4-5");
    expect(built.maxTurns).toBe(42);
  });

  it("isolates the child environment and keeps the token out of memory it does not need", () => {
    const built = options();
    expect(built.env).toMatchObject({
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/tmp/hammer-review-x/claude-config",
    });
    expect(Object.keys(built.env ?? {})).not.toContain("ANTHROPIC_API_KEY");
  });

  it("asks for a JSON schema for the review and nothing for verify or judge", () => {
    const withSchema = buildSdkOptions({
      instructions: "review",
      model: "claude-sonnet-4-5",
      cwd: "/tmp/x",
      executablePath: "/tmp/claude",
      configDir: "/tmp/cfg",
      env: {},
      maxTurns: 10,
      toolNames: [],
      partialMessages: false,
      outputSchema: ReviewBatchSchema,
    });
    expect(withSchema.outputFormat).toMatchObject({ type: "json_schema" });
    expect(options().outputFormat).toBeUndefined();
  });

  it("mounts only Hammer's MCP server", () => {
    const built = options();
    expect(built.mcpServers).toBeUndefined();
    expect(built.strictMcpConfig).toBeUndefined();
    const withServer = buildSdkOptions({
      instructions: "review",
      model: "claude-sonnet-4-5",
      cwd: "/tmp/x",
      executablePath: "/tmp/claude",
      configDir: "/tmp/cfg",
      env: {},
      maxTurns: 10,
      toolNames: ["mcp__hammer__read_file"],
      partialMessages: false,
      mcpServer: { type: "sdk", name: HAMMER_MCP_SERVER, instance: {} as never },
    });
    expect(Object.keys(withServer.mcpServers ?? {})).toEqual([HAMMER_MCP_SERVER]);
    expect(withServer.strictMcpConfig).toBe(true);
    expect(withServer.allowedTools).toEqual(["mcp__hammer__read_file"]);
  });

  it("denies any tool outside Hammer's own with a PreToolUse hook", async () => {
    const matcher = buildToolDenyHook(["mcp__hammer__read_file"]);
    const hook = matcher.hooks[0]!;
    const denied = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
        tool_use_id: "x",
        session_id: "s",
        cwd: "/tmp",
      } as never,
      undefined,
      { signal: new AbortController().signal },
    );
    expect(denied).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", hookEventName: "PreToolUse" },
    });
    const allowed = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__hammer__read_file",
        tool_input: {},
        tool_use_id: "x",
        session_id: "s",
        cwd: "/tmp",
      } as never,
      undefined,
      { signal: new AbortController().signal },
    );
    expect(allowed).toEqual({});
    expect(matcher.onFailure).toBe("block");
  });

  it("lists only real claude tools in the deny list", () => {
    expect(new Set(DENIED_BUILT_IN_TOOLS).size).toBe(DENIED_BUILT_IN_TOOLS.length);
    expect(DENIED_BUILT_IN_TOOLS).not.toContain("mcp__hammer__read_file");
  });

  it("passes one PreToolUse hook and no canUseTool callback", () => {
    const built = options();
    expect(built.hooks?.PreToolUse).toHaveLength(1);
    expect(built.canUseTool).toBeUndefined();
    const message = { type: "system", subtype: "init" } as SDKMessage;
    expect(message.type).toBe("system");
  });
});

describe("claude-agent-sdk reasoning effort", () => {
  it("maps a supported effort and rejects anything the SDK does not know", () => {
    expect(sdkEffort("HIGH")).toBe("high");
    expect(sdkEffort("xhigh")).toBe("xhigh");
    expect(sdkEffort(undefined)).toBeUndefined();
    expect(() => sdkEffort("maximal")).toThrow(/not supported by client claude-agent-sdk/);
    expect(SDK_EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("passes the effort to the CLI and fails before spawning on a bad value", async () => {
    const built = buildSdkOptions({
      instructions: "review",
      model: "claude-sonnet-4-5",
      cwd: "/tmp/x",
      executablePath: "/tmp/claude",
      configDir: "/tmp/cfg",
      env: {},
      maxTurns: 10,
      toolNames: [],
      partialMessages: false,
      effort: sdkEffort("low"),
    });
    expect(built.effort).toBe("low");
    const backend = createClaudeSdkBackend({
      model: "claude-sonnet-4-5",
      executablePath: "/tmp/claude",
      cwd: "/tmp/x",
      configDir: "/tmp/cfg",
      env: {},
      query: () => {
        throw new Error("must not spawn");
      },
    });
    expect(() =>
      backend.createConversation({
        instructions: "review",
        tools: [],
        maxTurns: 5,
        reasoningEffort: "maximal",
      }),
    ).toThrow(/not supported/);
  });
});
