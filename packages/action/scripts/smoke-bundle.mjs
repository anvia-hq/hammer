import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dist = join(import.meta.dirname, "..", "dist");
const bundle = join(dist, "index.js");
const mcpBundle = join(dist, "codex-mcp.js");

for (const path of [bundle, mcpBundle]) {
  if (!existsSync(path)) {
    console.error(`missing bundle: ${path} (run bun run build first)`);
    process.exit(1);
  }
}

const offenders = ["node_modules", "node_modules/", "__dirname"];
for (const path of [bundle, mcpBundle]) {
  const text = readFileSync(path, "utf8");
  for (const needle of offenders) {
    if (text.includes(`require("${needle}`) || text.includes(`from "${needle}`)) {
      console.error(`${path} loads ${needle} at runtime`);
      process.exit(1);
    }
  }
}

// The Codex backend spawns dist/codex-mcp.js as its MCP server, and that server asks the run's tool
// host for the tools of the conversation it serves, so the shipped artifact has to answer an MCP
// handshake, list the tools the host reports and forward a call back to it.
const toolNames = [
  "checkout_pr",
  "get_pr_discussion",
  "list_dir",
  "read_diff",
  "read_file",
  "search",
];
const toolHost = createServer((request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (request.headers.authorization !== "Bearer smoke-token") return send(401, { error: "x" });
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/tools")
    return send(200, {
      tools: toolNames.map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object" },
      })),
    });
  if (request.method === "POST" && url.pathname === "/call") {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const { name } = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      send(200, { text: name === "read_file" ? "1: export const retry = 1;" : `called ${name}` });
    });
    return;
  }
  send(404, { error: "not found" });
});
await new Promise((resolve) => toolHost.listen(0, "127.0.0.1", resolve));
const toolHostPort = toolHost.address().port;
const handshake = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "read_file", arguments: { path: "src/a.ts" } },
  },
]
  .map((message) => `${JSON.stringify(message)}\n`)
  .join("");
const mcpOut = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [mcpBundle], {
    env: {
      ...process.env,
      HAMMER_CODEX_TOOL_URL: `http://127.0.0.1:${toolHostPort}`,
      HAMMER_CODEX_TOOL_TOKEN: "smoke-token",
      HAMMER_CODEX_TOOL_SESSION: "s1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error("codex-mcp did not exit after the handshake"));
  }, 30_000);
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", () => {
    clearTimeout(timer);
    resolve(out);
  });
  child.stdin.end(handshake);
});
toolHost.close();
const replies = mcpOut
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const listed = replies.find((reply) => reply.id === 2)?.result?.tools ?? [];
const called = replies.find((reply) => reply.id === 3)?.result?.content?.[0]?.text ?? "";
if (listed.length !== 6 || !listed.some((tool) => tool.name === "read_file")) {
  console.error(`codex-mcp listed ${listed.length} tools instead of Hammer's six`);
  process.exit(1);
}
if (!called.includes("export const retry = 1;")) {
  console.error("codex-mcp did not answer a read_file call");
  process.exit(1);
}

const directory = mkdtempSync(join(tmpdir(), "hammer-bundle-smoke-"));
const summary = join(directory, "summary.md");
writeFileSync(summary, "");
const env = {
  ...process.env,
  GITHUB_ACTIONS: "false",
  GITHUB_STEP_SUMMARY: summary,
  GITHUB_EVENT_NAME: "push",
  GITHUB_EVENT_PATH: join(tmpdir(), "hammer-smoke-event.json"),
  INPUT_CLIENT: "anthropic",
  INPUT_MODEL: "claude-sonnet-5-5",
};

const out = execFileSync(process.execPath, [bundle], {
  encoding: "utf8",
  env,
  timeout: 30_000,
});
if (!out.includes("[hammer]")) {
  console.error("bundle did not print the expected no-op line");
  process.exit(1);
}
rmSync(directory, { recursive: true, force: true });
console.log("smoke ok: no-op exit 0, no node_modules require, codex MCP server handshake");
