import type { CompletionModel, CompletionResponse } from "@anvia/core/completion";
import { describe, expect, it, vi } from "vitest";

import {
  createAnthropicModel,
  createCompletionModel,
  createOpenAIModel,
  DEFAULT_SINGLE_PASS_TOKENS,
  parseModelId,
  parseModelRef,
  runSinglePass,
  runSinglePassReview,
  type Finding,
  type ModelAdapter,
  type AdapterUsage,
  type ReviewBatch,
} from "../src/index";

function validFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    path: "src/app.ts",
    line: 12,
    severity: "high",
    category: "correctness",
    title: "Null check missing",
    body: "Dereferences a possibly null value; guard before use.",
    confidence: 0.9,
    ...overrides,
  };
}

function validBatch(overrides: Partial<ReviewBatch> = {}): ReviewBatch {
  return {
    summary: "Adds null handling to the login flow.",
    findings: [validFinding()],
    generalNotes: [],
    ...overrides,
  };
}

function baseInput(model = "anthropic/claude-sonnet-4-5") {
  return {
    model,
    title: "Add retry with backoff",
    files: [],
    config: { rules: [], path_instructions: [], use_repo_guidelines: false },
  };
}

describe("parseModelRef", () => {
  it("parses anthropic and openai refs", () => {
    expect(parseModelRef("anthropic/claude-sonnet-4-5")).toEqual({
      ok: true,
      value: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
    });
    expect(parseModelRef("openai/gpt-4o")).toEqual({
      ok: true,
      value: { provider: "openai", modelId: "gpt-4o" },
    });
  });

  it("rejects an unknown provider with a coded error", () => {
    const result = parseModelRef("gemini/gemini-2.0-flash");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("unsupported_provider");
      expect(result.issues[0]?.message).toContain("gemini");
    }
  });

  it("rejects a missing slash and a missing model id", () => {
    const noSlash = parseModelRef("anthropic");
    expect(noSlash.ok).toBe(false);
    if (!noSlash.ok) expect(noSlash.issues[0]?.code).toBe("invalid_model");
    const noId = parseModelRef("anthropic/");
    expect(noId.ok).toBe(false);
    if (!noId.ok) expect(noId.issues[0]?.code).toBe("invalid_model");
  });
});

describe("provider factory", () => {
  it("builds completion models without network calls", () => {
    const anthropic = createAnthropicModel("claude-sonnet-4-5", { apiKey: "test-key" });
    expect(anthropic.provider).toBe("anthropic");
    const openai = createOpenAIModel("gpt-4o", { apiKey: "test-key" });
    expect(openai.provider).toBe("openai");
    const routed = createCompletionModel(
      { provider: "openai", modelId: "gpt-4o" },
      { apiKey: "test-key" },
    );
    expect(routed.provider).toBe("openai");
  });
});

describe("runSinglePassReview", () => {
  it("runs one call when the prompt fits", async () => {
    const generate = vi.fn(() => validBatch());
    const result = await runSinglePassReview(baseInput(), { generate });
    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.batch.summary).toContain("null handling");
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    }
  });

  it("returns needs_batching with zero calls when oversized", async () => {
    const generate = vi.fn(() => validBatch());
    const result = await runSinglePassReview(baseInput(), {
      generate,
      singlePassTokens: 1,
    });
    expect(result).toMatchObject({ ok: false, error: "needs_batching" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects unknown providers before calling generate", async () => {
    const generate = vi.fn(() => validBatch());
    const result = await runSinglePassReview(baseInput("gemini/gemini-2.0-flash"), {
      generate,
    });
    expect(result).toMatchObject({ ok: false, error: "unsupported_provider" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("repairs schema-invalid output once", async () => {
    const bad = validBatch({ summary: "s".repeat(601) });
    const good = validBatch();
    const generate = vi.fn((prompt: string) =>
      generate.mock.calls.length === 1 && prompt.length > 0 ? bad : good,
    );
    const result = await runSinglePassReview(baseInput(), { generate });
    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("returns schema_violation when repair fails", async () => {
    const bad = validBatch({ summary: "s".repeat(601) });
    const generate = vi.fn(() => bad);
    const result = await runSinglePassReview(baseInput(), { generate });
    expect(result).toMatchObject({ ok: false, error: "schema_violation" });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("returns generate_failed when generate throws", async () => {
    const generate = vi.fn(() => {
      throw new Error("model unavailable");
    });
    const result = await runSinglePassReview(baseInput(), { generate });
    expect(result).toMatchObject({ ok: false, error: "generate_failed" });
    if (!result.ok) expect(result.issues[0]?.message).toContain("model unavailable");
  });

  it("runs through an injected model adapter with usage", async () => {
    const batch = validBatch();
    const fakeModel: CompletionModel = {
      provider: "test",
      modelId: "test-model",
      capabilities: {
        streaming: false,
        tools: true,
        toolChoice: true,
        imageInput: false,
        documentInput: false,
        outputSchema: false,
        reasoning: false,
      },
      completion: async (): Promise<CompletionResponse<unknown>> => ({
        choice: [
          { type: "text", text: JSON.stringify(batch) },
        ] as CompletionResponse<unknown>["choice"],
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        rawResponse: null,
      }),
    };
    const result = await runSinglePassReview(baseInput(), {
      model: fakeModel,
      checkoutRoot: "/tmp",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.batch.summary).toContain("null handling");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    }
  });

  it("exposes the default token budget", () => {
    expect(DEFAULT_SINGLE_PASS_TOKENS).toBe(60000);
  });
});

describe("parseModelId", () => {
  it("parses valid anthropic and openai ids", () => {
    expect(parseModelId("anthropic/claude-sonnet-4-5")).toEqual({
      ok: true,
      value: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
    });
    expect(parseModelId("openai/gpt-4o")).toEqual({
      ok: true,
      value: { provider: "openai", modelId: "gpt-4o" },
    });
  });

  it("rejects an unknown provider", () => {
    expect(parseModelId("gemini/gemini-2.0-flash")).toEqual({
      ok: false,
      error: "unknown_provider",
    });
  });

  it("rejects a missing model id", () => {
    expect(parseModelId("anthropic/")).toEqual({ ok: false, error: "missing_model_id" });
  });

  it("rejects a malformed id", () => {
    expect(parseModelId("anthropic")).toEqual({ ok: false, error: "malformed" });
  });
});

describe("runSinglePass", () => {
  function adapterFor(outputs: unknown[], usage?: AdapterUsage) {
    let calls = 0;
    const result: { output: unknown; usage?: AdapterUsage } =
      usage === undefined ? { output: undefined } : { output: undefined, usage };
    const adapter: ModelAdapter = {
      generate: async () => ({ ...result, output: outputs[calls++] }),
    };
    return { adapter, calls: () => calls };
  }

  it("returns needs_batching with zero adapter calls when oversized", async () => {
    const { adapter, calls } = adapterFor([validBatch()]);
    const result = await runSinglePass({
      modelInput: "anthropic/claude-sonnet-4-5",
      prompt: "x".repeat(4 * 60000 + 4),
      adapter,
    });
    expect(result).toEqual({ ok: false, error: "needs_batching" });
    expect(calls()).toBe(0);
  });

  it("returns ok with zeroed usage when the adapter gives none", async () => {
    const { adapter } = adapterFor([validBatch()]);
    const result = await runSinglePass({
      modelInput: "openai/gpt-4o",
      prompt: "review this",
      adapter,
    });
    expect(result).toEqual({
      ok: true,
      batch: validBatch(),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
  });

  it("repairs schema-invalid output once", async () => {
    const bad = validBatch({ summary: "s".repeat(601) });
    const { adapter, calls } = adapterFor([bad, validBatch()]);
    const result = await runSinglePass({
      modelInput: "anthropic/claude-sonnet-4-5",
      prompt: "review this",
      adapter,
    });
    expect(result.ok).toBe(true);
    expect(calls()).toBe(2);
  });

  it("returns schema_violation after two invalid outputs", async () => {
    const bad = validBatch({ summary: "s".repeat(601) });
    const { adapter, calls } = adapterFor([bad, bad]);
    const result = await runSinglePass({
      modelInput: "anthropic/claude-sonnet-4-5",
      prompt: "review this",
      adapter,
    });
    expect(result).toEqual({ ok: false, error: "schema_violation" });
    expect(calls()).toBe(2);
  });

  it("returns generate_failed when the adapter throws", async () => {
    const adapter: ModelAdapter = {
      generate: async () => {
        throw new Error("model unavailable");
      },
    };
    const result = await runSinglePass({
      modelInput: "anthropic/claude-sonnet-4-5",
      prompt: "review this",
      adapter,
    });
    expect(result).toEqual({ ok: false, error: "generate_failed" });
  });

  it("rejects a bad model input before any adapter call", async () => {
    const { adapter, calls } = adapterFor([validBatch()]);
    const result = await runSinglePass({
      modelInput: "gemini/gemini-2.0-flash",
      prompt: "review this",
      adapter,
    });
    expect(result).toEqual({ ok: false, error: "unknown_provider" });
    expect(calls()).toBe(0);
  });
});
