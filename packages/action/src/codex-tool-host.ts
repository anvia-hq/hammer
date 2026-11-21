import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";

import { toolText, type ReviewerToolDefinition } from "@anvia/hammer-agents";

export const CODEX_TOOL_URL_ENV = "HAMMER_CODEX_TOOL_URL";
export const CODEX_TOOL_TOKEN_ENV = "HAMMER_CODEX_TOOL_TOKEN";
export const CODEX_TOOL_SESSION_ENV = "HAMMER_CODEX_TOOL_SESSION";

export interface CodexToolHost {
  readonly url: string;
  readonly token: string;
  session(tools: readonly ReviewerToolDefinition[]): Record<string, string>;
  close(): Promise<void>;
}

const callSchema = z.object({
  session: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).default({}),
});

const failureText = (error: unknown): string =>
  `Hammer tool failed: ${error instanceof Error ? error.message : String(error)}`;

// Codex starts the MCP server itself, so the server cannot hold Hammer's live tool definitions: it
// asks this loopback host for the tools of the conversation it serves and sends every call back
// here. That keeps the per-shard files and diff, the budget wind-down and the tool progress events
// exactly as the in-process backends see them.
export async function startCodexToolHost(): Promise<CodexToolHost> {
  const token = randomBytes(24).toString("hex");
  const sessions = new Map<string, Map<string, ReviewerToolDefinition>>();
  const authorized = (header: string | undefined): boolean => {
    if (header === undefined) return false;
    const provided = Buffer.from(header.replace(/^Bearer\s+/i, ""));
    const expected = Buffer.from(token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  };

  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (!authorized(request.headers.authorization)) {
      send(401, { error: "unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/tools") {
        const tools = sessions.get(url.searchParams.get("session") ?? "");
        if (tools === undefined) {
          send(404, { error: "unknown session" });
          return;
        }
        send(200, {
          tools: [...tools.values()].map((definition) => ({
            name: definition.name,
            description: definition.description,
            inputSchema: z.toJSONSchema(definition.inputSchema),
          })),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/call") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
        const parsed = callSchema.safeParse(
          JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
        );
        if (!parsed.success) {
          send(400, { error: "bad request" });
          return;
        }
        const definition = sessions.get(parsed.data.session)?.get(parsed.data.name);
        if (definition === undefined) {
          send(404, { error: "unknown tool" });
          return;
        }
        try {
          send(200, { text: toolText(await definition.execute(parsed.data.input)) });
        } catch (error) {
          send(200, { text: failureText(error) });
        }
        return;
      }
      send(404, { error: "not found" });
    } catch (error) {
      send(500, { error: failureText(error) });
    }
  });
  server.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;
  let counter = 0;

  return {
    url,
    token,
    session(tools) {
      counter += 1;
      const id = `s${counter}`;
      sessions.set(id, new Map(tools.map((definition) => [definition.name, definition])));
      return {
        [CODEX_TOOL_URL_ENV]: url,
        [CODEX_TOOL_TOKEN_ENV]: token,
        [CODEX_TOOL_SESSION_ENV]: id,
      };
    },
    async close() {
      sessions.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
