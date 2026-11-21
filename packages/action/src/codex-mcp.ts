import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";

import {
  CODEX_TOOL_SESSION_ENV,
  CODEX_TOOL_TOKEN_ENV,
  CODEX_TOOL_URL_ENV,
} from "./codex-tool-host";

export const CODEX_MCP_SERVER_NAME = "hammer";
export const CODEX_MCP_SERVER_VERSION = "0.0.0";

export interface CodexToolListing {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CodexToolProxy {
  list(): Promise<CodexToolListing[]>;
  call(name: string, input: Record<string, unknown>): Promise<string>;
}

export function createProxyMcpServer(proxy: CodexToolProxy): Server {
  const server = new Server(
    { name: CODEX_MCP_SERVER_NAME, version: CODEX_MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await proxy.list() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [
      {
        type: "text" as const,
        text: await proxy.call(
          request.params.name,
          (request.params.arguments ?? {}) as Record<string, unknown>,
        ),
      },
    ],
  }));
  return server;
}

interface HostResponse {
  status: number;
  body: string;
}

// The host is on loopback and carries its own token, so this client talks to it directly instead of
// going through the runner's proxy settings.
function ask(
  url: string,
  authorization: string,
  call: { method: "GET" | "POST"; path: string; body?: unknown },
): Promise<HostResponse> {
  return new Promise((resolve, reject) => {
    const payload = call.body === undefined ? undefined : JSON.stringify(call.body);
    const request = httpRequest(
      `${url}${call.path}`,
      {
        method: call.method,
        headers: {
          authorization,
          ...(payload !== undefined
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

export function httpToolProxy(env: NodeJS.ProcessEnv): CodexToolProxy {
  const url = (env[CODEX_TOOL_URL_ENV] ?? "").trim();
  const token = (env[CODEX_TOOL_TOKEN_ENV] ?? "").trim();
  const session = (env[CODEX_TOOL_SESSION_ENV] ?? "").trim();
  if (url === "" || token === "" || session === "")
    throw new Error(
      `${CODEX_TOOL_URL_ENV}, ${CODEX_TOOL_TOKEN_ENV} and ${CODEX_TOOL_SESSION_ENV} must all be set; the codex backend passes them from the Action.`,
    );
  const authorization = `Bearer ${token}`;

  return {
    async list() {
      const response = await ask(url, authorization, {
        method: "GET",
        path: `/tools?session=${encodeURIComponent(session)}`,
      });
      if (response.status !== 200)
        throw new Error(`Hammer's tool host refused the tool list (HTTP ${response.status}).`);
      const parsed = JSON.parse(response.body) as { tools?: CodexToolListing[] };
      return parsed.tools ?? [];
    },
    async call(name, input) {
      const response = await ask(url, authorization, {
        method: "POST",
        path: "/call",
        body: { session, name, input },
      });
      if (response.status !== 200)
        return `Hammer tool failed: the tool host answered HTTP ${response.status}.`;
      const parsed = JSON.parse(response.body) as { text?: string };
      return parsed.text ?? "";
    },
  };
}

export async function startCodexMcpServer(proxy: CodexToolProxy): Promise<Server> {
  const server = createProxyMcpServer(proxy);
  await server.connect(new StdioServerTransport());
  return server;
}

async function main(): Promise<void> {
  let proxy: CodexToolProxy;
  try {
    proxy = httpToolProxy(process.env);
  } catch (error) {
    process.stderr.write(`hammer: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  await startCodexMcpServer(proxy);
}

if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
