import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
import { codexTimeoutError } from "./errors";
import { createCodexCollector } from "./events";
import { spawnCodex, type CodexExecFn } from "./exec";
import {
  buildCodexArgs,
  codexEffort,
  codexReviewSchema,
  dropNullOptionals,
  type CodexMcpServer,
} from "./options";

export interface CodexBackendOptions {
  model: string;
  executablePath: string;
  cwd: string;
  workDirectory: string;
  env: Record<string, string | undefined>;
  mcpServer?: CodexMcpServer | undefined;
  exec?: CodexExecFn | undefined;
  turnTimeoutMs?: number | undefined;
  log?: ((message: string) => void) | undefined;
}

const DEFAULT_TURN_TIMEOUT_MS = 600_000;

function skillInstructions(instructions: string, skills: SkillSet | undefined): string {
  if (skills === undefined || skills.instructions.trim() === "") return instructions;
  return `${instructions}\n${skills.instructions}`;
}

export function createCodexBackend(options: CodexBackendOptions): ReviewBackend {
  let schemaPath: string | undefined;

  const schemaFile = async (
    conversation: ReviewConversationOptions,
  ): Promise<string | undefined> => {
    if (conversation.outputSchema === undefined) return undefined;
    if (schemaPath !== undefined) return schemaPath;
    await mkdir(options.workDirectory, { recursive: true });
    const path = join(options.workDirectory, "review-schema.json");
    await writeFile(path, `${JSON.stringify(codexReviewSchema(conversation.outputSchema))}\n`, {
      mode: 0o600,
    });
    schemaPath = path;
    return path;
  };

  return {
    id: "codex",
    createConversation(conversation: ReviewConversationOptions): ReviewConversation {
      const transcript: TranscriptEntry[] = [];
      const instructions = skillInstructions(conversation.instructions, conversation.skills);
      const effort = codexEffort(conversation.reasoningEffort);
      const timeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
      const exec = options.exec ?? spawnCodex;

      const runTurn = async (input: {
        prompt: string;
        tools: ReviewerToolDefinition[];
        withSchema: boolean;
      }): Promise<TurnOutcome> => {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        const collector = createCodexCollector({
          ...(conversation.onText !== undefined ? { onText: conversation.onText } : {}),
          transcript,
        });
        const mount = input.tools.length > 0 ? options.mcpServer : undefined;
        const schemaPathForTurn = input.withSchema ? await schemaFile(conversation) : undefined;
        try {
          const stream = exec({
            executablePath: options.executablePath,
            args: buildCodexArgs({
              model: options.model,
              instructions,
              ...(schemaPathForTurn !== undefined ? { outputSchemaPath: schemaPathForTurn } : {}),
              ...(effort !== undefined ? { effort } : {}),
              ...(mount !== undefined ? { mcpServer: mount } : {}),
            }),
            prompt: input.prompt,
            cwd: options.cwd,
            env: options.env,
            signal: controller.signal,
          });
          for await (const line of stream) collector.push(line);
        } catch (error) {
          if (timedOut) throw codexTimeoutError(timeoutMs);
          throw error;
        } finally {
          clearTimeout(timer);
        }
        if (timedOut) throw codexTimeoutError(timeoutMs);
        const outcome = collector.outcome();
        return { text: dropNullOptionals(outcome.text), usage: outcome.usage };
      };

      return {
        async turn(prompt) {
          conversation.startGuard?.();
          const outcome = await runTurn({
            prompt: withTranscript(transcript, prompt),
            tools: conversation.tools,
            withSchema: true,
          });
          conversation.onUsage?.(outcome.usage);
          return outcome;
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
                withSchema: true,
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
