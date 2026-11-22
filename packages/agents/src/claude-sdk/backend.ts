import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
  ReviewBackend,
  ReviewConversation,
  ReviewConversationOptions,
  ReviewerToolDefinition,
  SalvageHooks,
  TurnOutcome,
} from "../backend";
import { SALVAGE_RESULT_LIMITS, describeStop, FINALIZE_PROMPT } from "../salvage";
import type { SkillSet } from "../skills";
import { withTranscript, type TranscriptEntry } from "../transcript";
import { ClaudeSdkError, describeResultText } from "./messages";
import { createTurnCollector } from "./messages";
import { buildSdkOptions, sdkEffort } from "./options";
import { buildSdkMcpServer, sdkToolNames, skillToolDefinitions } from "./tools";

export type ClaudeQueryFn = (params: {
  prompt: string;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

export interface ClaudeSdkBackendOptions {
  model: string;
  executablePath: string;
  cwd: string;
  configDir: string;
  env: Record<string, string | undefined>;
  query?: ClaudeQueryFn | undefined;
  turnTimeoutMs?: number | undefined;
}

const DEFAULT_TURN_TIMEOUT_MS = 600_000;

function skillDefinitions(skills: SkillSet | undefined): ReviewerToolDefinition[] {
  if (skills === undefined) return [];
  return skillToolDefinitions(
    skills.tools as unknown as Array<{ name: string; call(input: unknown): Promise<unknown> }>,
  );
}

function withSkills(instructions: string, skills: SkillSet | undefined): string {
  if (skills === undefined || skills.instructions.trim() === "") return instructions;
  return `${instructions}\n${skills.instructions}`;
}

// The SDK turns an error result into a thrown Error instead of yielding it, so the result text
// is mapped back onto the same actionable failures.
export function translateQueryError(error: unknown): unknown {
  if (error instanceof ClaudeSdkError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const result = /^Claude Code returned an error result: ([\s\S]*)$/.exec(message);
  if (result !== null) return describeResultText(result[1] ?? "");
  return error;
}

const defaultQuery: ClaudeQueryFn = (params) => claudeQuery(params);

export function createClaudeSdkBackend(options: ClaudeSdkBackendOptions): ReviewBackend {
  return {
    id: "claude-agent-sdk",
    createConversation(conversation: ReviewConversationOptions): ReviewConversation {
      const transcript: TranscriptEntry[] = [];
      const definitions = [...conversation.tools, ...skillDefinitions(conversation.skills)];
      const instructions = withSkills(conversation.instructions, conversation.skills);
      const effort = sdkEffort(conversation.reasoningEffort);
      const timeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

      const runTurn = async (input: {
        prompt: string;
        tools: ReviewerToolDefinition[];
        maxTurns: number;
      }): Promise<TurnOutcome> => {
        const queryFn = options.query ?? defaultQuery;
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        const mcpServer = input.tools.length > 0 ? buildSdkMcpServer(input.tools) : undefined;
        const collector = createTurnCollector({
          ...(conversation.onText !== undefined ? { onText: conversation.onText } : {}),
          transcript,
        });
        try {
          for await (const message of queryFn({
            prompt: input.prompt,
            options: buildSdkOptions({
              instructions,
              model: options.model,
              cwd: options.cwd,
              executablePath: options.executablePath,
              configDir: options.configDir,
              env: options.env,
              maxTurns: input.maxTurns,
              toolNames: input.tools.length > 0 ? sdkToolNames(input.tools) : [],
              ...(mcpServer !== undefined ? { mcpServer } : {}),
              ...(conversation.outputSchema !== undefined
                ? { outputSchema: conversation.outputSchema }
                : {}),
              ...(effort !== undefined ? { effort } : {}),
              partialMessages: conversation.onText !== undefined,
              abortController: controller,
            }),
          }))
            collector.push(message);
        } catch (error) {
          if (timedOut)
            throw new ClaudeSdkError(
              "process",
              `Claude Code did not finish this turn within ${Math.round(timeoutMs / 1000)} seconds and was stopped.`,
            );
          throw translateQueryError(error);
        } finally {
          clearTimeout(timer);
        }
        return collector.outcome(input.maxTurns);
      };

      return {
        async turn(prompt) {
          conversation.startGuard?.();
          const outcome = await runTurn({
            prompt: withTranscript(transcript, prompt),
            tools: definitions,
            maxTurns: conversation.maxTurns,
          });
          conversation.onUsage?.(outcome.usage);
          return {
            text: outcome.text,
            usage: outcome.usage,
            ...(outcome.finishReason !== undefined ? { finishReason: outcome.finishReason } : {}),
          };
        },
        async salvage(error, hooks: SalvageHooks) {
          if (transcript.length === 0) return null;
          hooks.begin?.();
          const stop = describeStop(error);
          for (const limit of SALVAGE_RESULT_LIMITS) {
            try {
              const outcome = await runTurn({
                prompt: `${withTranscript(transcript, "", limit)}\n\n${FINALIZE_PROMPT}`.trim(),
                tools: [],
                maxTurns: 2,
              });
              conversation.onUsage?.(outcome.usage);
              const accepted = hooks.accept({ text: outcome.text, usage: outcome.usage, stop });
              if (accepted !== null) return accepted;
            } catch {}
          }
          return null;
        },
      };
    },
  };
}
