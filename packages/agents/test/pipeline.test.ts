import type { CompletionModel } from "@anvia/core/completion";
import { describe, expect, it, vi } from "vitest";
import { runReviewPipeline, type ReviewPipelineInput } from "../src/index";
import { defaultRepoConfig, resolveConfig } from "@anvia/hammer-core";

const finding = {
  path: "a.ts",
  line: 1,
  severity: "high",
  category: "correctness",
  title: "Null dereference",
  body: "Null input crashes; add a guard.",
  confidence: 0.9,
};
const batch = { summary: "Changes a helper", findings: [finding], generalNotes: [] };
function input(responses: unknown[], structured = false): ReviewPipelineInput {
  const model: CompletionModel = {
    provider: "test",
    modelId: "fake",
    capabilities: {
      outputSchema: structured,
      tools: true,
      toolChoice: true,
      streaming: false,
      imageInput: false,
      documentInput: false,
      reasoning: false,
    },
    completion: vi.fn(async () => ({
      choice: [{ type: "text" as const, text: JSON.stringify(responses.shift()) }],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      rawResponse: {},
    })),
  };
  return {
    title: "PR",
    files: [
      {
        filename: "a.ts",
        sha: "x",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
    ],
    config: resolveConfig(defaultRepoConfig(), { verify: false }),
    checkoutRoot: "/tmp/unused",
    discussion: {},
    modelRef: "openai/fake",
    model,
  };
}
describe("review pipeline", () => {
  it("uses the SDK structured output and performs one repair", async () => {
    const request = input([{ nope: true }, batch], true);
    const result = await runReviewPipeline(request);
    expect(request.model.completion).toHaveBeenCalledTimes(2);
    expect(request.model.completion).toHaveBeenCalledWith(
      expect.objectContaining({ outputSchema: expect.any(Object) }),
      expect.anything(),
    );
    expect(result.usage.tokens).toBe(30);
    expect(result.findings).toHaveLength(1);
  });
  it("validates and repairs JSON even when native schema output is disabled", async () => {
    const request = input([{ nope: true }, batch]);
    const result = await runReviewPipeline(request);
    expect(result.findings).toHaveLength(1);
    expect(result.partial).toBe(false);
    expect(request.model.completion).toHaveBeenCalledTimes(2);
    for (const [call] of vi.mocked(request.model.completion).mock.calls) {
      expect(call.outputSchema).toBeUndefined();
    }
  });
  it("accounts for invalid responses even when their batch fails", async () => {
    const request = input([{ nope: true }, { nope: true }], true);
    const result = await runReviewPipeline(request);
    expect(request.model.completion).toHaveBeenCalledTimes(2);
    expect(result.usage.tokens).toBe(30);
    expect(result.partial).toBe(true);
    expect(result.failedBatches).toHaveLength(1);
  });
  it("stops verification after a token cap and keeps completed findings", async () => {
    const request = input([batch]);
    request.config.verify = true;
    request.config.max_tokens = 10;
    const result = await runReviewPipeline(request);
    expect(request.model.completion).toHaveBeenCalledTimes(1);
    expect(result.findings).toHaveLength(1);
    expect(result.partial).toBe(true);
    expect(result.unverified).toBe(true);
  });
  it("revalidates verification anchors and moves out-of-diff findings to the summary", async () => {
    const request = input([batch, { scores: [{ id: "f1", score: 8, relocatedLine: 99 }] }]);
    request.config.verify = true;
    const result = await runReviewPipeline(request);
    expect(result.inline).toHaveLength(0);
    expect(result.generalNotes[0]).toContain("a.ts:99");
    expect(request.model.completion).toHaveBeenCalledTimes(2);
  });
});

it("validates incremental findings against the overall PR's commentable lines", async () => {
  const request = input([{ ...batch, findings: [{ ...finding, line: 99 }] }]);
  request.anchorFiles = request.files;
  request.files = request.files.map((file) => ({ ...file, patch: "@@ -99 +99 @@\n-old\n+new" }));
  const result = await runReviewPipeline(request);
  expect(result.inline).toHaveLength(0);
  expect(result.generalNotes[0]).toContain("a.ts:99");
});

it("emits progress events through the review lifecycle", async () => {
  const request = input([batch, { scores: [{ id: "f1", score: 9 }] }]);
  request.config.verify = true;
  const events: string[] = [];
  request.onEvent = (event) => events.push(event.type);
  await runReviewPipeline(request);
  expect(events).toEqual([
    "plan",
    "batch_start",
    "turn",
    "batch_end",
    "verify_start",
    "turn",
    "verify_end",
    "done",
  ]);
});

it("keeps reviewing when the event sink throws", async () => {
  const request = input([batch]);
  request.onEvent = () => {
    throw new Error("sink failed");
  };
  const result = await runReviewPipeline(request);
  expect(result.findings).toHaveLength(1);
});

it("streams model commentary but not the final JSON, and still accounts usage", async () => {
  const request = input([]);
  const usage = {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  let turn = 0;
  const streaming = {
    ...request.model,
    capabilities: { ...request.model.capabilities, streaming: true },
    streamCompletion: async function* () {
      turn += 1;
      if (turn === 1) {
        yield { type: "text_delta" as const, delta: "Checking the diff.\n" };
        const call = {
          type: "tool-call" as const,
          toolCallId: "c1",
          toolName: "get_file_diff",
          input: { path: "a.ts" },
        };
        yield { type: "tool_call" as const, toolCall: call };
        yield {
          type: "final" as const,
          response: {
            choice: [{ type: "text" as const, text: "Checking the diff.\n" }, call],
            usage,
            finishReason: "tool-calls" as const,
            rawResponse: {},
          },
        };
        return;
      }
      const text = JSON.stringify(batch);
      yield { type: "text_delta" as const, delta: text };
      yield {
        type: "final" as const,
        response: {
          choice: [{ type: "text" as const, text }],
          usage,
          finishReason: "stop" as const,
          rawResponse: {},
        },
      };
    },
  };
  request.model = streaming as unknown as typeof request.model;
  const events: Array<{ type: string; text?: string }> = [];
  request.onEvent = (event) => events.push(event);
  const result = await runReviewPipeline(request);
  expect(result.findings).toHaveLength(1);
  expect(result.usage.tokens).toBe(30);
  const texts = events.filter((event) => event.type === "text").map((event) => event.text);
  expect(texts).toEqual(["Checking the diff."]);
  expect(events.filter((event) => event.type === "turn")).toHaveLength(2);
});

it("falls back to a non-streaming run when the stream fails before any output", async () => {
  const request = input([batch]);
  const failing = {
    ...request.model,
    capabilities: { ...request.model.capabilities, streaming: true },
    streamCompletion: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("stream unsupported")),
      }),
    }),
  };
  request.model = failing as unknown as typeof request.model;
  const result = await runReviewPipeline(request);
  expect(result.findings).toHaveLength(1);
  expect(result.failedBatches).toEqual([]);
});
