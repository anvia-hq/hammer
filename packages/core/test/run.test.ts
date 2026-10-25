import type {
  CompletionModel,
  CompletionRequest,
  CompletionResponse,
} from "@anvia/core/completion";
import { describe, expect, it, vi } from "vitest";

import {
  createAnthropicModel,
  createCompletionModel,
  createGeminiModel,
  createOpenAICompatibleModel,
  createOpenAIModel,
  DEFAULT_SINGLE_PASS_TOKENS,
  parseModelRef,
  parseModelRefWithBase,
  runSinglePassReview,
  validateBatchOutput,
  type Finding,
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
  it("parses anthropic, openai and gemini refs", () => {
    expect(parseModelRef("anthropic/claude-sonnet-4-5")).toEqual({
      ok: true,
      value: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
    });
    expect(parseModelRef("openai/gpt-4o")).toEqual({
      ok: true,
      value: { provider: "openai", modelId: "gpt-4o" },
    });
    expect(parseModelRef("gemini/gemini-2.0-flash")).toEqual({
      ok: true,
      value: { provider: "gemini", modelId: "gemini-2.0-flash" },
    });
  });

  it("parses openai-compatible with a base URL", () => {
    expect(
      parseModelRefWithBase("openai-compatible/my-model", "https://llm.example.com/v1"),
    ).toEqual({
      ok: true,
      value: {
        provider: "openai-compatible",
        modelId: "my-model",
        baseUrl: "https://llm.example.com/v1",
      },
    });
    expect(
      parseModelRef("openai-compatible/my-model", { baseUrl: "https://llm.example.com/v1" }),
    ).toEqual({
      ok: true,
      value: {
        provider: "openai-compatible",
        modelId: "my-model",
        baseUrl: "https://llm.example.com/v1",
      },
    });
  });

  it("rejects openai-compatible without a base URL", () => {
    const result = parseModelRef("openai-compatible/my-model");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("missing_base_url");
    }
    const blank = parseModelRefWithBase("openai-compatible/my-model", "  ");
    expect(blank.ok).toBe(false);
    if (!blank.ok) {
      expect(blank.issues[0]?.code).toBe("missing_base_url");
    }
  });

  it("rejects an unknown provider with a coded error", () => {
    const result = parseModelRef("cohere/command-r");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("unsupported_provider");
      expect(result.issues[0]?.message).toContain("cohere");
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
    const gemini = createGeminiModel("gemini-2.0-flash", { apiKey: "test-key" });
    expect(gemini.provider).toBe("gemini");
    const compatible = createOpenAICompatibleModel("my-model", {
      apiKey: "test-key",
      baseUrl: "https://llm.example.com/v1",
    });
    expect(compatible.provider).toBe("openai");
    const routed = createCompletionModel(
      { provider: "openai", modelId: "gpt-4o" },
      { apiKey: "test-key" },
    );
    expect(routed.provider).toBe("openai");
    const routedGemini = createCompletionModel(
      { provider: "gemini", modelId: "gemini-2.0-flash" },
      { apiKey: "test-key" },
    );
    expect(routedGemini.provider).toBe("gemini");
    const routedCompatible = createCompletionModel(
      {
        provider: "openai-compatible",
        modelId: "my-model",
        baseUrl: "https://llm.example.com/v1",
      },
      { apiKey: "test-key" },
    );
    expect(routedCompatible.provider).toBe("openai");
  });

  it("can disable native JSON schema for a compatible endpoint without affecting the default", () => {
    const ref = {
      provider: "openai-compatible" as const,
      modelId: "custom",
      baseUrl: "https://llm.example.com/v1",
    };
    const fallback = createCompletionModel(ref, { apiKey: "test-key", nativeJsonSchema: false });
    const native = createCompletionModel(ref, { apiKey: "test-key" });
    expect(fallback.capabilities.outputSchema).toBe(false);
    expect(native.capabilities.outputSchema).toBe(true);
    expect(fallback.capabilities.tools).toBe(true);
  });

  it("throws when the openai-compatible base URL is missing", () => {
    expect(() => createOpenAICompatibleModel("my-model", { apiKey: "test-key" })).toThrowError(
      /base-url/i,
    );
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
    const result = await runSinglePassReview(baseInput("cohere/command-r"), {
      generate,
    });
    expect(result).toMatchObject({ ok: false, error: "unsupported_provider" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects openai-compatible without a base URL before calling generate", async () => {
    const generate = vi.fn(() => validBatch());
    const result = await runSinglePassReview(baseInput("openai-compatible/my-model"), {
      generate,
    });
    expect(result).toMatchObject({ ok: false, error: "missing_base_url" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("accepts openai-compatible with a base URL", async () => {
    const generate = vi.fn(() => validBatch());
    const result = await runSinglePassReview(
      { ...baseInput("openai-compatible/my-model"), baseUrl: "https://llm.example.com/v1" },
      { generate },
    );
    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
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

describe("runSinglePassReview agent repair", () => {
  function repairingModel(texts: string[], seen: CompletionRequest[]): CompletionModel {
    let calls = 0;
    return {
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
      completion: async (request: CompletionRequest): Promise<CompletionResponse<unknown>> => {
        seen.push(request);
        const text = texts[Math.min(calls++, texts.length - 1)] ?? "";
        return {
          choice: [{ type: "text", text }] as CompletionResponse<unknown>["choice"],
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          rawResponse: null,
        };
      },
    };
  }

  it("re-runs the agent with a repair prompt containing the validation issues", async () => {
    const badText = "not json";
    const goodText = JSON.stringify(validBatch());
    const seen: CompletionRequest[] = [];
    const result = await runSinglePassReview(baseInput(), {
      model: repairingModel([badText, goodText], seen),
      checkoutRoot: "/tmp",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.batch.summary).toContain("null handling");
      expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
    }
    expect(seen).toHaveLength(2);
    const first = validateBatchOutput(badText);
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(JSON.stringify(seen[1])).toContain(first.issues[0]?.message ?? "");
    }
  });

  it("returns schema_violation after two invalid agent responses", async () => {
    const badText = "not json";
    const seen: CompletionRequest[] = [];
    const result = await runSinglePassReview(baseInput(), {
      model: repairingModel([badText, badText], seen),
      checkoutRoot: "/tmp",
    });
    expect(result).toMatchObject({ ok: false, error: "schema_violation" });
    expect(seen).toHaveLength(2);
  });
});
