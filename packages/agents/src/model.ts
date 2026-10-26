import { AnthropicClient } from "@anvia/anthropic";
import { AzureOpenAIClient } from "@anvia/azure";
import {
  defineCompletionModelControls,
  type CompletionModel,
  type CompletionModelControls,
} from "@anvia/core/completion";
import { GeminiClient } from "@anvia/gemini";
import { OpenAIClient } from "@anvia/openai";

export const SUPPORTED_MODEL_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "openai-compatible",
  "azure",
] as const;

export type SupportedModelProvider = (typeof SUPPORTED_MODEL_PROVIDERS)[number];

export interface ParsedModelRef {
  provider: SupportedModelProvider;
  modelId: string;
  baseUrl?: string;
}

export type ModelParseErrorCode = "invalid_model" | "unsupported_provider" | "missing_base_url";

export interface ModelParseIssue {
  code: ModelParseErrorCode;
  message: string;
}

export type ParseModelResult =
  | { ok: true; value: ParsedModelRef }
  | { ok: false; issues: ModelParseIssue[] };

export interface ParseModelOptions {
  baseUrl?: string;
}

export function parseModelRef(raw: string, options: ParseModelOptions = {}): ParseModelResult {
  return parseModelRefWithBase(raw, options.baseUrl);
}

export function parseModelRefWithBase(raw: string, baseUrl?: string): ParseModelResult {
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
  if (modelId === "" || (provider !== "openai-compatible" && modelId.includes("/"))) {
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
  if (provider === "openai-compatible" || provider === "azure") {
    const normalized = baseUrl?.trim() ?? "";
    if (normalized === "") {
      return {
        ok: false,
        issues: [
          {
            code: "missing_base_url",
            message: `Model "${raw}" needs the "base-url" action input for the ${provider} provider.`,
          },
        ],
      };
    }
    return { ok: true, value: { provider, modelId, baseUrl: normalized } };
  }
  return { ok: true, value: { provider, modelId } };
}

function isSupportedProvider(provider: string): provider is SupportedModelProvider {
  return (SUPPORTED_MODEL_PROVIDERS as readonly string[]).includes(provider);
}

export interface ModelClientOptions {
  apiKey: string;
  nativeJsonSchema?: boolean | undefined;
  baseUrl?: string | undefined;
}

const ANTHROPIC_CONTROLS: CompletionModelControls = defineCompletionModelControls({
  reasoningEffort: {
    type: "select",
    label: "Reasoning effort",
    options: ["low", "medium", "high", "xhigh", "max"],
    defaultValue: "high",
  },
});

export function createAnthropicModel(
  modelId: string,
  options: ModelClientOptions,
): CompletionModel {
  const client = new AnthropicClient({ apiKey: options.apiKey });
  return client.completionModel({
    modelId,
    controls: ANTHROPIC_CONTROLS,
  }) as unknown as CompletionModel;
}

export function createOpenAIModel(modelId: string, options: ModelClientOptions): CompletionModel {
  const client = new OpenAIClient({ apiKey: options.apiKey });
  return client.completionModel({ modelId }) as unknown as CompletionModel;
}

export function createGeminiModel(modelId: string, options: ModelClientOptions): CompletionModel {
  const client = new GeminiClient({ apiKey: options.apiKey });
  return client.completionModel({ modelId }) as unknown as CompletionModel;
}

const OPENAI_COMPATIBLE_CONTROLS: CompletionModelControls = defineCompletionModelControls({
  reasoningEffort: {
    type: "select",
    label: "Reasoning effort",
    options: ["low", "medium", "high", "xhigh", "max"],
  },
});

export function createOpenAICompatibleModel(
  modelId: string,
  options: ModelClientOptions,
): CompletionModel {
  const baseUrl = options.baseUrl?.trim() ?? "";
  if (baseUrl === "") {
    throw new Error(
      'Missing base URL for the openai-compatible provider: pass "base-url" as an action input.',
    );
  }
  const client = new OpenAIClient({ apiKey: options.apiKey, baseUrl });
  const model = client.completionModel({ modelId, controls: OPENAI_COMPATIBLE_CONTROLS });
  if (options.nativeJsonSchema === false) model.capabilities.outputSchema = false;
  return model as unknown as CompletionModel;
}

export function createAzureModel(modelId: string, options: ModelClientOptions): CompletionModel {
  const baseUrl = options.baseUrl?.trim() ?? "";
  if (baseUrl === "") {
    throw new Error('Missing base URL for the azure provider: pass "base-url" as an action input.');
  }
  const client = new AzureOpenAIClient({ apiKey: options.apiKey, endpoint: baseUrl });
  const model = client.completionModel({ modelId });
  if (options.nativeJsonSchema === false) model.capabilities.outputSchema = false;
  return model as unknown as CompletionModel;
}

export function createCompletionModel(
  ref: ParsedModelRef,
  options: ModelClientOptions,
): CompletionModel {
  if (ref.provider === "anthropic") return createAnthropicModel(ref.modelId, options);
  if (ref.provider === "gemini") return createGeminiModel(ref.modelId, options);
  if (ref.provider === "openai-compatible" || ref.provider === "azure") {
    const baseUrl = ref.baseUrl ?? options.baseUrl;
    const withBaseUrl =
      baseUrl === undefined ? { apiKey: options.apiKey } : { ...options, baseUrl };
    return ref.provider === "azure"
      ? createAzureModel(ref.modelId, withBaseUrl)
      : createOpenAICompatibleModel(ref.modelId, withBaseUrl);
  }
  return createOpenAIModel(ref.modelId, options);
}
