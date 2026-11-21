import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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

// The Codex backend spawns dist/codex-mcp.js as its MCP server, so the shipped artifact has to
// answer an MCP handshake and list Hammer's read-only tools from a context file.
const mcpDirectory = mkdtempSync(join(tmpdir(), "hammer-mcp-smoke-"));
const checkout = join(mcpDirectory, "head");
mkdirSync(join(checkout, "src"), { recursive: true });
writeFileSync(join(checkout, "src", "a.ts"), "export const retry = 1;\n");
const contextPath = join(mcpDirectory, "codex-tools.json");
writeFileSync(
  contextPath,
  JSON.stringify({
    checkoutRoot: checkout,
    files: [
      {
        filename: "src/a.ts",
        sha: "0".repeat(40),
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "@@ -0,0 +1 @@\n+export const retry = 1;",
      },
    ],
    fileContents: { "src/a.ts": "1: export const retry = 1;" },
    pr: { title: "smoke" },
    discussion: { title: "smoke", body: "", comments: [] },
  }),
);
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
const mcpOut = execFileSync(process.execPath, [mcpBundle], {
  encoding: "utf8",
  input: handshake,
  timeout: 30_000,
  env: { ...process.env, HAMMER_CODEX_CONTEXT: contextPath },
});
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
rmSync(mcpDirectory, { recursive: true, force: true });

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
