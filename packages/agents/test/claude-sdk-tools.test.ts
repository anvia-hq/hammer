import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  HAMMER_MCP_SERVER,
  MCP_TOOL_PREFIX,
  buildReviewerToolDefinitions,
  buildSdkMcpServer,
  mcpToolName,
  sdkToolNames,
  skillToolDefinitions,
} from "../src/index";

describe("claude-agent-sdk tool bridge", () => {
  it("mounts Hammer's six tools under one MCP server", () => {
    const definitions = buildReviewerToolDefinitions({
      checkoutRoot: "/tmp/x",
      files: [],
      discussion: {},
    });
    expect(definitions.map((entry) => entry.name)).toEqual([
      "checkout_pr",
      "read_diff",
      "read_file",
      "list_dir",
      "search",
      "get_pr_discussion",
    ]);
    expect(sdkToolNames(definitions)).toEqual([
      "mcp__hammer__checkout_pr",
      "mcp__hammer__read_diff",
      "mcp__hammer__read_file",
      "mcp__hammer__list_dir",
      "mcp__hammer__search",
      "mcp__hammer__get_pr_discussion",
    ]);
    expect(mcpToolName("read_file")).toBe(`${MCP_TOOL_PREFIX}read_file`);
    const server = buildSdkMcpServer(definitions);
    expect(server.type).toBe("sdk");
    expect(server.name).toBe(HAMMER_MCP_SERVER);
    expect(server.instance).toBeDefined();
  });

  it("reads a checkout file through the tool definition and reports it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hammer-sdk-tools-"));
    await writeFile(join(root, "auth.ts"), "const token = 1;\nreturn token;\n");
    const onToolCall = vi.fn();
    const definitions = buildReviewerToolDefinitions({
      checkoutRoot: root,
      files: [],
      discussion: {},
      onToolCall,
    });
    const readFile = definitions.find((entry) => entry.name === "read_file")!;
    const result = await readFile.execute({ path: "auth.ts", startLine: 1, endLine: 2 });
    expect(result).toMatchObject({ ok: true, startLine: 1, endLine: 2 });
    expect(JSON.stringify(result)).toContain("1: const token = 1;");
    expect(onToolCall).toHaveBeenCalledWith("read_file", "auth.ts:1-2");
  });

  it("rejects a path outside the checkout before reading it", async () => {
    const definitions = buildReviewerToolDefinitions({
      checkoutRoot: "/tmp/hammer-sdk-empty",
      files: [],
      discussion: {},
    });
    const readFile = definitions.find((entry) => entry.name === "read_file")!;
    expect(await readFile.execute({ path: "../../etc/passwd" })).toMatchObject({ ok: false });
  });

  it("bridges only the two read-only skill tools", async () => {
    const call = vi.fn(async () => "# Skill");
    const definitions = skillToolDefinitions([
      { name: "get_skill_instructions", call },
      { name: "get_skill_reference", call },
      { name: "run_skill_script", call },
    ]);
    expect(definitions.map((entry) => entry.name)).toEqual([
      "get_skill_instructions",
      "get_skill_reference",
    ]);
    await definitions[0]!.execute({ skillName: "code-review-and-quality" });
    expect(call).toHaveBeenCalledWith({ skillName: "code-review-and-quality" });
  });
});
