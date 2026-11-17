import type { EffortLevel, HookCallbackMatcher, Options } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { ReviewBatch } from "@anvia/hammer-core";
import { z } from "zod";

export const HAMMER_MCP_SERVER = "hammer";
export const MCP_TOOL_PREFIX = `mcp__${HAMMER_MCP_SERVER}__`;

// Every built-in tool is denied. The read-only ones (Read, Grep, Glob) are denied too: they
// reach the checkout without Hammer's path guard and secret denylist (rule 0004).
export const DENIED_BUILT_IN_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "KillBash",
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
  "TaskOutput",
  "TodoWrite",
  "SlashCommand",
  "Skill",
  "ExitPlanMode",
  "StructuredOutput",
  "AskUserQuestion",
  "Workflow",
  "Computer",
] as const;

export const SDK_EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export function sdkEffort(reasoningEffort: string | undefined): EffortLevel | undefined {
  if (reasoningEffort === undefined || reasoningEffort.trim() === "") return undefined;
  const value = reasoningEffort.trim().toLowerCase();
  const match = SDK_EFFORT_LEVELS.find((level) => level === value);
  if (match === undefined)
    throw new Error(
      `reasoning-effort "${reasoningEffort}" is not supported by client claude-agent-sdk: use ${SDK_EFFORT_LEVELS.join(", ")}.`,
    );
  return match;
}

export interface SdkOptionsInput {
  instructions: string;
  model: string;
  cwd: string;
  executablePath: string;
  configDir: string;
  env: Record<string, string | undefined>;
  maxTurns: number;
  toolNames: string[];
  mcpServer?: McpSdkServerConfigWithInstance | undefined;
  outputSchema?: z.ZodType<ReviewBatch> | undefined;
  effort?: EffortLevel | undefined;
  partialMessages: boolean;
  abortController?: AbortController | undefined;
}

export function buildToolDenyHook(allowedToolNames: readonly string[]): HookCallbackMatcher {
  const allowed = new Set(allowedToolNames);
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const name = input.tool_name ?? "";
        if (allowed.has(name)) return {};
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: `Hammer's reviewer may only use its own read-only tools. "${name}" is not available.`,
          },
        };
      },
    ],
    onFailure: "block",
  };
}

// Claude Code's JSON-schema validator has no draft-2020-12 meta schema, so the dialect
// declaration is dropped; the review schema uses only keywords every draft shares.
export function reviewJsonSchema(schema: z.ZodType<ReviewBatch>): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}

export function buildSdkOptions(input: SdkOptionsInput): Options {
  return {
    cwd: input.cwd,
    pathToClaudeCodeExecutable: input.executablePath,
    env: { ...input.env, CLAUDE_CONFIG_DIR: input.configDir },
    systemPrompt: input.instructions,
    settingSources: [],
    tools: [],
    allowedTools: input.toolNames,
    disallowedTools: [...DENIED_BUILT_IN_TOOLS],
    permissionMode: "dontAsk",
    ...(input.mcpServer !== undefined
      ? { mcpServers: { [HAMMER_MCP_SERVER]: input.mcpServer }, strictMcpConfig: true }
      : {}),
    model: input.model,
    maxTurns: input.maxTurns,
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    includePartialMessages: input.partialMessages,
    hooks: { PreToolUse: [buildToolDenyHook(input.toolNames)] },
    ...(input.outputSchema !== undefined
      ? {
          outputFormat: {
            type: "json_schema" as const,
            schema: reviewJsonSchema(input.outputSchema),
          },
        }
      : {}),
    ...(input.abortController !== undefined ? { abortController: input.abortController } : {}),
  };
}
