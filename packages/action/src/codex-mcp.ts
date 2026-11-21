import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";

import {
  buildReviewerToolDefinitions,
  loadReviewSkills,
  skillToolDefinitions,
  toolText,
  type ReviewerToolDefinition,
} from "@anvia/hammer-agents";
import { CODEX_CONTEXT_ENV, readCodexToolContext, type CodexToolContext } from "./codex-context";

export const CODEX_MCP_SERVER_NAME = "hammer";
export const CODEX_MCP_SERVER_VERSION = "0.0.0";

// The reviewer's six read-only tools and the two read-only skill tools, rebuilt in this process
// from the context file so the same path guard, secret denylist, output caps and repeated-call
// damping apply. The script-running skill tool is never built (rule 0004).
export async function codexMcpTools(context: CodexToolContext): Promise<ReviewerToolDefinition[]> {
  const reviewer = buildReviewerToolDefinitions({
    checkoutRoot: context.checkoutRoot,
    files: context.files,
    fileContents: context.fileContents,
    pr: context.pr,
    discussion: context.discussion,
  });
  if (context.skills === undefined) return reviewer;
  const repoSkillNames = context.skills.repoSkillNames;
  const skills = await loadReviewSkills(
    context.skills.directory,
    repoSkillNames !== undefined ? { repoSkillNames } : {},
  );
  return [
    ...reviewer,
    ...skillToolDefinitions(
      skills.tools as unknown as Array<{ name: string; call(input: unknown): Promise<unknown> }>,
    ),
  ];
}

export function createCodexMcpServer(definitions: ReviewerToolDefinition[]): McpServer {
  const server = new McpServer({
    name: CODEX_MCP_SERVER_NAME,
    version: CODEX_MCP_SERVER_VERSION,
  });
  for (const definition of definitions) {
    server.registerTool(
      definition.name,
      { description: definition.description, inputSchema: definition.inputSchema.shape },
      async (args) => ({
        content: [{ type: "text" as const, text: toolText(await definition.execute(args)) }],
      }),
    );
  }
  return server;
}

export async function startCodexMcpServer(contextPath: string): Promise<McpServer> {
  const context = await readCodexToolContext(contextPath);
  const server = createCodexMcpServer(await codexMcpTools(context));
  await server.connect(new StdioServerTransport());
  return server;
}

async function main(): Promise<void> {
  const contextPath = process.env[CODEX_CONTEXT_ENV];
  if (contextPath === undefined || contextPath === "") {
    process.stderr.write(
      `hammer: ${CODEX_CONTEXT_ENV} is not set, so there are no tools to serve.\n`,
    );
    process.exit(1);
  }
  await startCodexMcpServer(contextPath);
}

if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
