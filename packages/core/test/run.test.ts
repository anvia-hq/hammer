import type { CompletionModel, CompletionResponse } from "@anvia/core/completion";
import { describe, expect, it, vi } from "vitest";

import {
  createAnthropicModel,
  createCompletionModel,
  createOpenAIModel,
  DEFAULT_SINGLE_PASS_TOKENS,
  parseModelRef,
  runSinglePassReview,
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
