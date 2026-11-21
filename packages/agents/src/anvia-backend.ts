import { Agent } from "@anvia/core/agent";
import type { CompletionModel, Message } from "@anvia/core/completion";
import { createTool } from "@anvia/core/tool";
import type { AnyTool } from "@anvia/core/tool";

import type { ReviewBatch } from "@anvia/hammer-core";

import type {
  ReviewBackend,
  ReviewConversation,
  ReviewConversationOptions,
  ReviewerToolDefinition,
  SalvageHooks,
  TurnOutcome,
} from "./backend";
import { toUsage } from "./backend";
import { promptCacheProviderOptions } from "./model";
import { WIND_DOWN_CALL } from "./reviewer-tools";
import {
  compactHistory,
  describeStop,
  FINALIZE_PROMPT,
  hasToolActivity,
  SALVAGE_RESULT_LIMITS,
} from "./salvage";
import { createTextStreamer } from "./stream";

export interface AnviaBackendOptions {
  model: CompletionModel;
  getHistory?: (() => Message[]) | undefined;
}

const AGENT_RETRIES = { maxAttempts: 3 } as const;

function describeReason(finishReason?: string, providerFinishReason?: string): string | undefined {
  if (finishReason === undefined) return providerFinishReason;
  if (providerFinishReason === undefined) return finishReason;
  return `${finishReason} (${providerFinishReason})`;
}

export function toAnviaTools(definitions: ReviewerToolDefinition[]): AnyTool[] {
  return definitions.map((definition) =>
    createTool({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: async (args: Record<string, unknown>) => definition.execute(args),
    }),
  );
}

// The finalize turn must not spend the run on tools, so every tool answers with the wind-down note.
function windDownTools(definitions: ReviewerToolDefinition[]): AnyTool[] {
  return definitions.map((definition) =>
    createTool({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: async () => WIND_DOWN_CALL,
    }),
  );
}

async function generateTurn(
  agent: Agent<string | ReviewBatch>,
  prompt: string,
  model: CompletionModel,
  options: ReviewConversationOptions,
): Promise<Awaited<ReturnType<typeof agent.generate>>> {
  const onText = options.onText;
  const canStream =
    onText !== undefined && model.capabilities.streaming && "streamCompletion" in model;
  if (!canStream) return agent.generate({ prompt });
  const streamer = createTextStreamer(onText);
  const stream = agent.stream({ prompt });
  let started = false;
  try {
    for await (const event of stream) {
      if (event.type === "text_delta") streamer.delta("text", event.turn, event.delta);
      else if (event.type === "reasoning_delta")
        streamer.delta("reasoning", event.turn, event.delta);
      else if (event.type === "tool_call") streamer.toolCall(event.turn);
      else if (event.type === "turn_end") streamer.turnEnd(event.turn);
      if (
        event.type === "text_delta" ||
        event.type === "reasoning_delta" ||
        event.type === "tool_call"
      )
        started = true;
    }
    streamer.end();
    return await stream.result;
  } catch (error) {
    // A gateway that cannot stream fails before any output; retry once without streaming.
    if (started) throw error;
    return agent.generate({ prompt });
  }
}

function historyAfterFailure(error: unknown, getHistory?: () => Message[]): Message[] {
  const messages = (error as { messages?: unknown } | null)?.messages;
  const carried = Array.isArray(messages) ? (messages as Message[]) : [];
  return carried.length > 0 ? carried : (getHistory?.() ?? []);
}

function createAnviaConversation(
  options: ReviewConversationOptions,
  backend: AnviaBackendOptions,
): ReviewConversation {
  const model = backend.model;
  const providerOptions = promptCacheProviderOptions(model.provider);
  const createAgent = (maxTurns: number, tools: AnyTool[]): Agent<string | ReviewBatch> =>
    new Agent<string | ReviewBatch>({
      id: "hammer-pr-reviewer",
      model,
      ...(providerOptions ? { providerOptions } : {}),
      instructions: options.instructions,
      ...(options.skills ? { skills: options.skills } : {}),
      ...(options.outputSchema && model.capabilities.outputSchema
        ? { outputSchema: options.outputSchema }
        : {}),
      retries: AGENT_RETRIES,
      maxTokens: options.maxTokens ?? 16384,
      tools,
      maxTurns,
      ...(options.reasoningEffort
        ? { controls: { reasoningEffort: options.reasoningEffort } }
        : {}),
    });
  const agent = createAgent(options.maxTurns, toAnviaTools(options.tools));
  return {
    async turn(prompt): Promise<TurnOutcome | null> {
      const outcome = await generateTurn(agent, prompt, model, options);
      if (outcome.type !== "response") return null;
      const finishReason = describeReason(outcome.finishReason, outcome.providerFinishReason);
      return {
        text: outcome.text,
        usage: toUsage(outcome.usage),
        ...(finishReason !== undefined ? { finishReason } : {}),
      };
    },
    async salvage(error, hooks: SalvageHooks) {
      const history = historyAfterFailure(error, backend.getHistory);
      if (!hasToolActivity(history)) return null;
      hooks.begin?.();
      const stop = describeStop(error);
      const finalizeTools = windDownTools(options.tools);
      for (const limit of SALVAGE_RESULT_LIMITS) {
        try {
          const finalizer = createAgent(2, finalizeTools);
          const response = await finalizer.generate({
            messages: [
              ...compactHistory(history, limit),
              { role: "user", content: FINALIZE_PROMPT },
            ],
          });
          if (response.type !== "response") continue;
          const accepted = hooks.accept({
            text: response.text,
            usage: toUsage(response.usage),
            stop,
          });
          if (accepted !== null) return accepted;
        } catch {}
      }
      return null;
    },
  };
}

// Usage is recorded and the budget enforced by the CompletionModel proxy the pipeline injects,
// so this backend ignores startGuard and onUsage.
export function createAnviaBackend(backend: AnviaBackendOptions): ReviewBackend {
  return {
    id: "anvia",
    createConversation: (options) => createAnviaConversation(options, backend),
  };
}
