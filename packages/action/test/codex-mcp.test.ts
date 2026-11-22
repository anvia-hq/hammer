import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildReviewerToolDefinitions,
  loadReviewSkills,
  skillToolDefinitions,
  type ReviewerToolDefinition,
} from "@anvia/hammer-agents";
import { createProxyMcpServer, httpToolProxy } from "../src/codex-mcp";
import { startCodexToolHost } from "../src/codex-tool-host";

const SKILLS_DIRECTORY = join(import.meta.dirname, "..", "..", "..", "skills");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function definitionsFor(input: { skills?: boolean } = {}): Promise<{
  definitions: ReviewerToolDefinition[];
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "hammer-codex-mcp-"));
  roots.push(root);
  const checkoutRoot = join(root, "head");
  await mkdir(join(checkoutRoot, "src"), { recursive: true });
  await writeFile(join(checkoutRoot, "src/a.ts"), "export const retry = 1;\n");
  await writeFile(join(checkoutRoot, ".env"), "TOKEN=secret\n");
  const reviewer = buildReviewerToolDefinitions({
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
  });
  if (input.skills !== true) return { definitions: reviewer, close: async () => {} };
  const skills = await loadReviewSkills(SKILLS_DIRECTORY);
  return {
    definitions: [
      ...reviewer,
      ...skillToolDefinitions(
        skills.tools as unknown as Array<{ name: string; call(input: unknown): Promise<unknown> }>,
      ),
    ],
    close: async () => {},
  };
}

async function roundTrip(input: { skills?: boolean } = {}) {
  const { definitions } = await definitionsFor(input);
  const host = await startCodexToolHost();
  const env = host.session(definitions) as NodeJS.ProcessEnv;
  const server = createProxyMcpServer(httpToolProxy(env));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "hammer-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
      await host.close();
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
      const readFile = listed.tools.find((tool) => tool.name === "read_file");
      expect(readFile?.inputSchema).toMatchObject({ type: "object" });
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

  it("serves only the tools of the session it was given", async () => {
    const first = await definitionsFor();
    const host = await startCodexToolHost();
    try {
      const firstEnv = host.session(first.definitions) as NodeJS.ProcessEnv;
      const proxy = httpToolProxy(firstEnv);
      expect((await proxy.list()).map((tool) => tool.name)).toContain("read_file");
      const other = await definitionsFor();
      const otherEnv = host.session(other.definitions) as NodeJS.ProcessEnv;
      const otherProxy = httpToolProxy(otherEnv);
      expect((await otherProxy.list()).map((tool) => tool.name)).toEqual(
        (await proxy.list()).map((tool) => tool.name),
      );
      const rejected = httpToolProxy({ ...firstEnv, HAMMER_CODEX_TOOL_SESSION: "missing" });
      await expect(rejected.list()).rejects.toThrow(/refused the tool list/);
    } finally {
      await host.close();
    }
  });

  it("refuses to start without the Action's tool host settings", () => {
    expect(() => httpToolProxy({})).toThrow(/must all be set/);
  });

  it("is bundled as its own entry next to index and post", async () => {
    const config = await import("../tsup.config");
    const options = config.default as { entry: Record<string, string> };
    expect(options.entry["codex-mcp"]).toBe("src/codex-mcp.ts");
  });
});
