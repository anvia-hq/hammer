import { AnthropicClient } from "@anvia/anthropic";
import type { CompletionModel } from "@anvia/core/completion";
import { OpenAIClient } from "@anvia/openai";

export const SUPPORTED_MODEL_PROVIDERS = ["anthropic", "openai"] as const;

export type SupportedModelProvider = (typeof SUPPORTED_MODEL_PROVIDERS)[number];

export interface ParsedModelRef {
  provider: SupportedModelProvider;
  modelId: string;
}

export type ModelParseErrorCode = "invalid_model" | "unsupported_provider";

export interface ModelParseIssue {
  code: ModelParseErrorCode;
  message: string;
}

export type ParseModelResult =
  | { ok: true; value: ParsedModelRef }
  | { ok: false; issues: ModelParseIssue[] };

export function parseModelRef(raw: string): ParseModelResult {
  const input = raw.trim();
  const slash = input.indexOf("/");
  if (slash < 0) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_model",
          message: `Invalid model "${raw}": expected "provider/model-id".`,
        },
      ],
    };
  }
  const provider = input.slice(0, slash).trim();
  const modelId = input.slice(slash + 1).trim();
  if (!isSupportedProvider(provider)) {
    return {
      ok: false,
      issues: [
        {
          code: "unsupported_provider",
          message: `Unsupported provider "${provider}": expected one of ${SUPPORTED_MODEL_PROVIDERS.join(", ")}.`,
        },
      ],
    };
  }
  if (modelId === "" || modelId.includes("/")) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_model",
          message: `Invalid model "${raw}": expected "provider/model-id" with a non-empty model id.`,
        },
      ],
    };
  }
  return { ok: true, value: { provider, modelId } };
}

function isSupportedProvider(provider: string): provider is SupportedModelProvider {
  return (SUPPORTED_MODEL_PROVIDERS as readonly string[]).includes(provider);
}

export interface ModelClientOptions {
  apiKey: string;
}

export function createAnthropicModel(
  modelId: string,
  options: ModelClientOptions,
): CompletionModel {
  const client = new AnthropicClient({ apiKey: options.apiKey });
  return client.completionModel({ modelId }) as unknown as CompletionModel;
}

export function createOpenAIModel(modelId: string, options: ModelClientOptions): CompletionModel {
  const client = new OpenAIClient({ apiKey: options.apiKey });
  return client.completionModel({ modelId }) as unknown as CompletionModel;
}

export function createCompletionModel(
  ref: ParsedModelRef,
  options: ModelClientOptions,
): CompletionModel {
  if (ref.provider === "anthropic") return createAnthropicModel(ref.modelId, options);
  return createOpenAIModel(ref.modelId, options);
}
