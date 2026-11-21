import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { ReviewerToolDefinition } from "../backend";
import { HAMMER_MCP_SERVER, MCP_TOOL_PREFIX } from "./options";

export function toolText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined) return "";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export function mcpToolName(name: string): string {
  return `${MCP_TOOL_PREFIX}${name}`;
}

export function buildSdkMcpServer(definitions: ReviewerToolDefinition[]) {
  return createSdkMcpServer({
    name: HAMMER_MCP_SERVER,
    version: "0.0.0",
    tools: definitions.map((definition) =>
      // The definition re-validates its own input, and the SDK validates the shape first.
      tool(definition.name, definition.description, definition.inputSchema.shape, async (args) => ({
        content: [
          {
            type: "text" as const,
            text: toolText(await definition.execute(args as Record<string, unknown>)),
          },
        ],
      })),
    ),
  });
}

export function sdkToolNames(definitions: ReviewerToolDefinition[]): string[] {
  return definitions.map((definition) => mcpToolName(definition.name));
}

// Anvia builds its skill tools internally; the SDK backend needs the same two read-only skills
// tools as explicit definitions (the script-running skill tool stays out, rule 0004).
export const SKILL_INSTRUCTIONS_TOOL = "get_skill_instructions";
export const SKILL_REFERENCE_TOOL = "get_skill_reference";

export interface AnviaSkillTool {
  name: string;
  call(input: unknown): Promise<unknown>;
}

export function skillToolDefinitions(tools: AnviaSkillTool[]): ReviewerToolDefinition[] {
  const instructions = tools.find((entry) => entry.name === SKILL_INSTRUCTIONS_TOOL);
  const reference = tools.find((entry) => entry.name === SKILL_REFERENCE_TOOL);
  const definitions: ReviewerToolDefinition[] = [];
  if (instructions !== undefined) {
    const schema = z.object({ skillName: z.string() });
    definitions.push({
      name: SKILL_INSTRUCTIONS_TOOL,
      description: "Load the instructions of an available skill.",
      inputSchema: schema,
      execute: async (input) => instructions.call(schema.parse(input)),
    });
  }
  if (reference !== undefined) {
    const schema = z.object({ skillName: z.string(), referencePath: z.string() });
    definitions.push({
      name: SKILL_REFERENCE_TOOL,
      description: "Load one reference file of an available skill.",
      inputSchema: schema,
      execute: async (input) => reference.call(schema.parse(input)),
    });
  }
  return definitions;
}
