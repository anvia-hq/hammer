import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
import { codexTimeoutError, codexTurnLimitError, isCodexError } from "./errors";
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
}

const DEFAULT_TURN_TIMEOUT_MS = 600_000;

function skillInstructions(instructions: string, skills: SkillSet | undefined): string {
  if (skills === undefined || skills.instructions.trim() === "") return instructions;
  return `${instructions}\n${skills.instructions}`;
}

export function createCodexBackend(options: CodexBackendOptions): ReviewBackend {
  const schemaFiles = new Map<string, Promise<string>>();

  // Shards share this backend and run in parallel, so a schema is written once: the file name is
  // derived from the schema itself, and concurrent callers await the same write instead of
  // truncating a file a sibling's Codex process may already be reading.
  const schemaFile = (conversation: ReviewConversationOptions): Promise<string> | undefined => {
    if (conversation.outputSchema === undefined) return undefined;
    const json = `${JSON.stringify(codexReviewSchema(conversation.outputSchema))}\n`;
    const key = createHash("sha256").update(json).digest("hex").slice(0, 16);
    const cached = schemaFiles.get(key);
    if (cached !== undefined) return cached;
    const ready = (async (): Promise<string> => {
      await mkdir(options.workDirectory, { recursive: true });
      const path = join(options.workDirectory, `codex-schema-${key}.json`);
      try {
        await writeFile(path, json, { mode: 0o600 });
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      }
      return path;
    })();
    const tracked = ready.catch((error: unknown) => {
      schemaFiles.delete(key);
      throw error;
    });
    schemaFiles.set(key, tracked);
    return tracked;
  };

  return {
    id: "codex",
    createConversation(conversation: ReviewConversationOptions): ReviewConversation {
      // Codex reaches tools only through an MCP server, so a conversation that needs tools and
      // was handed no server would review without ever reading the checkout.
      if (conversation.tools.length > 0 && options.mcpServer === undefined)
        throw new Error(
          "The codex backend needs an mcpServer to expose Hammer's read-only tools; without it the reviewer cannot read the pull request.",
        );
      const transcript: TranscriptEntry[] = [];
      const instructions = skillInstructions(conversation.instructions, conversation.skills);
      const effort = codexEffort(conversation.reasoningEffort);
      const timeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
      const exec = options.exec ?? spawnCodex;

      const runTurn = async (input: {
        prompt: string;
        tools: ReviewerToolDefinition[];
        withSchema: boolean;
        maxTurns: number;
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
        try {
          const schemaPathForTurn = input.withSchema ? await schemaFile(conversation) : undefined;
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
          for await (const line of stream) {
            collector.push(line);
            if (collector.toolCalls() > input.maxTurns) {
              controller.abort();
              throw codexTurnLimitError(input.maxTurns);
            }
          }
        } catch (error) {
          if (timedOut) throw codexTimeoutError(timeoutMs);
          // Codex exits non-zero right after a `turn.failed` or `error` event, which would
          // otherwise replace the reason the collector recorded with a bare exit line.
          if (isCodexError(error) && error.code === "exit") {
            const recorded = collector.failure();
            if (recorded !== undefined) throw recorded;
          }
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
            maxTurns: conversation.maxTurns,
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
                maxTurns: conversation.maxTurns,
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
