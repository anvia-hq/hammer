import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { codexMcpTools, createCodexMcpServer } from "../src/codex-mcp";
import { readCodexToolContext, writeCodexToolContext } from "../src/codex-context";

const SKILLS_DIRECTORY = join(import.meta.dirname, "..", "..", "..", "skills");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function roundTrip(input: { skills?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "hammer-codex-mcp-"));
  roots.push(root);
  const checkoutRoot = join(root, "head");
  await mkdir(join(checkoutRoot, "src"), { recursive: true });
  await writeFile(join(checkoutRoot, "src/a.ts"), "export const retry = 1;\n");
  await writeFile(join(checkoutRoot, ".env"), "TOKEN=secret\n");
  const contextPath = await writeCodexToolContext(join(root, "codex"), {
    checkoutRoot,
    files: [
      {
        filename: "src/a.ts",
        sha: "x",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "@@ -0,0 +1 @@\n+export const retry = 1;",
      },
    ],
    fileContents: { "src/a.ts": "1: export const retry = 1;" },
    pr: { title: "Add retry" },
    discussion: { title: "Add retry", body: "PR body", comments: [] },
    ...(input.skills === true ? { skills: { directory: SKILLS_DIRECTORY } } : {}),
  });
  const context = await readCodexToolContext(contextPath);
  const server = createCodexMcpServer(await codexMcpTools(context));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "hammer-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("codex stdio MCP server", () => {
  it("lists exactly Hammer's six read-only tools", async () => {
    const session = await roundTrip();
    try {
      const listed = await session.client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "checkout_pr",
        "get_pr_discussion",
        "list_dir",
        "read_diff",
        "read_file",
        "search",
      ]);
      for (const tool of listed.tools) expect(tool.description ?? "").not.toBe("");
    } finally {
      await session.close();
    }
  });

  it("answers a real initialize, tools/list and tools/call round trip", async () => {
    const session = await roundTrip();
    try {
      const result = await session.client.callTool({
        name: "read_file",
        arguments: { path: "src/a.ts" },
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("export const retry = 1;");
      expect(session.client.getServerVersion()?.name).toBe("hammer");
    } finally {
      await session.close();
    }
  });

  it("keeps the path guard and the secret denylist in front of the checkout", async () => {
    const session = await roundTrip();
    try {
      const traversal = await session.client.callTool({
        name: "read_file",
        arguments: { path: "../../etc/passwd" },
      });
      expect(JSON.stringify(traversal.content)).toContain("outside");
      const secret = await session.client.callTool({
        name: "read_file",
        arguments: { path: ".env" },
      });
      expect(JSON.stringify(secret.content)).not.toContain("TOKEN=secret");
    } finally {
      await session.close();
    }
  });

  it("bridges only the read-only skill tools", async () => {
    const session = await roundTrip({ skills: true });
    try {
      const listed = await session.client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("get_skill_instructions");
      expect(names).toContain("get_skill_reference");
      expect(names).not.toContain("run_skill_script");
      const instructions = await session.client.callTool({
        name: "get_skill_instructions",
        arguments: { skillName: "code-review-and-quality" },
      });
      expect(JSON.stringify(instructions.content)).toContain("Code Review and Quality");
    } finally {
      await session.close();
    }
  });

  it("is bundled as its own entry next to index and post", async () => {
    const config = await import("../tsup.config");
    const options = config.default as { entry: Record<string, string> };
    expect(options.entry["codex-mcp"]).toBe("src/codex-mcp.ts");
  });
});
