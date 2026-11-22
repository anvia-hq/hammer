import type { ReviewBatch } from "@anvia/hammer-core";
import { z } from "zod";

export const CODEX_MCP_SERVER = "hammer";
export const CODEX_MCP_STARTUP_TIMEOUT_SEC = 60;
export const CODEX_MCP_TOOL_TIMEOUT_SEC = 120;

export const CODEX_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type CodexEffort = (typeof CODEX_EFFORT_LEVELS)[number];

export function codexEffort(reasoningEffort: string | undefined): CodexEffort | undefined {
  if (reasoningEffort === undefined || reasoningEffort.trim() === "") return undefined;
  const value = reasoningEffort.trim().toLowerCase();
  const match = CODEX_EFFORT_LEVELS.find((level) => level === value);
  if (match === undefined)
    throw new Error(
      `reasoning-effort "${reasoningEffort}" is not supported by client codex: use ${CODEX_EFFORT_LEVELS.join(", ")}.`,
    );
  return match;
}

export interface CodexMcpServer {
  command: string;
  args?: readonly string[] | undefined;
  env?: Record<string, string> | undefined;
}

export interface CodexArgInput {
  model: string;
  instructions: string;
  outputSchemaPath?: string | undefined;
  effort?: string | undefined;
  mcpServer?: CodexMcpServer | undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlInlineTable(values: Record<string, string>): string {
  const entries = Object.keys(values)
    .sort()
    .map((key) => `${tomlString(key)} = ${tomlString(values[key] as string)}`);
  return `{ ${entries.join(", ")} }`;
}

export function mcpServerOverrides(server: CodexMcpServer): string[] {
  const prefix = `mcp_servers.${CODEX_MCP_SERVER}`;
  return [
    `${prefix}.command=${tomlString(server.command)}`,
    ...(server.args !== undefined ? [`${prefix}.args=${tomlArray(server.args)}`] : []),
    ...(server.env !== undefined ? [`${prefix}.env=${tomlInlineTable(server.env)}`] : []),
    `${prefix}.required=true`,
    `${prefix}.startup_timeout_sec=${CODEX_MCP_STARTUP_TIMEOUT_SEC}`,
    `${prefix}.tool_timeout_sec=${CODEX_MCP_TOOL_TIMEOUT_SEC}`,
  ];
}

// Every built-in tool is turned off in the config the child runs with, so the model reaches the
// checkout only through Hammer's MCP server, which carries the path guard and secret denylist
// (rule 0004). `web_search` and the credential store are pinned for the same reason.
export const CODEX_BASE_OVERRIDES = [
  'cli_auth_credentials_store="file"',
  'web_search="disabled"',
  "project_doc_max_bytes=0",
  "features.shell_tool=false",
  "features.view_image=false",
  "features.multi_agent=false",
  "features.multi_agent_v2=false",
] as const;

// The prompt goes over stdin as `-`: a review prompt with an inline diff is far past the
// command line limit on Windows.
export function buildCodexArgs(input: CodexArgInput): string[] {
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--model",
    input.model,
    ...(input.outputSchemaPath !== undefined ? ["--output-schema", input.outputSchemaPath] : []),
    ...CODEX_BASE_OVERRIDES.flatMap((entry) => ["-c", entry]),
    "-c",
    `developer_instructions=${tomlString(input.instructions)}`,
    ...(input.effort !== undefined ? ["-c", `model_reasoning_effort="${input.effort}"`] : []),
    ...(input.mcpServer !== undefined
      ? mcpServerOverrides(input.mcpServer).flatMap((entry) => ["-c", entry])
      : []),
    "-",
  ];
}

// OpenAI's strict structured-output validator rejects the whole request when a schema carries a
// keyword outside its subset, or an object without `additionalProperties: false` and a `required`
// list of every property. Optional fields become nullable and are dropped from the answer before
// Hammer validates it, so nothing an optional field holds is lost.
const STRICT_DROPPED_KEYWORDS = new Set([
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "default",
  "const",
]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictSchema);
  if (!isObject(value)) return value;
  const source = value;
  const required = Array.isArray(source["required"]) ? source["required"] : [];
  const properties = isObject(source["properties"]) ? source["properties"] : undefined;
  const out: JsonObject = {};
  for (const [key, entry] of Object.entries(source)) {
    if (STRICT_DROPPED_KEYWORDS.has(key)) continue;
    if (key === "required" || key === "additionalProperties") continue;
    if (key === "properties" && properties !== undefined) {
      const strictProperties: JsonObject = {};
      for (const [name, spec] of Object.entries(properties)) {
        const inner = strictSchema(spec);
        strictProperties[name] = required.includes(name)
          ? inner
          : { anyOf: [inner, { type: "null" }] };
      }
      out["properties"] = strictProperties;
      continue;
    }
    out[key] = strictSchema(entry);
  }
  if (properties !== undefined) {
    out["additionalProperties"] = false;
    out["required"] = Object.keys(properties);
  }
  return out;
}

export function codexReviewSchema(schema: z.ZodType<ReviewBatch>): JsonObject {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" });
  return strictSchema(json) as JsonObject;
}

// Strict mode expresses an optional field as `null`; Hammer's schema wants it absent.
export function dropNullOptionals(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return text;
  }
  if (!isObject(parsed)) return text;
  const prune = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(prune);
    if (!isObject(value)) return value;
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === null) continue;
      out[key] = prune(entry);
    }
    return out;
  };
  return JSON.stringify(prune(parsed));
}
