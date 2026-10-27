import { describe, expect, it } from "vitest";
import { parseGatewayCatalog, resolvePricing } from "../src/index";

describe("Haiku 5.5 pricing", () => {
  const model = "anthropic/claude-haiku-5-5";
  it("uses the standard rate through 100k input tokens", () => {
    expect(resolvePricing(model)?.(model, { inputTokens: 100000, outputTokens: 1000 })).toBeCloseTo(
      0.0105,
    );
  });
  it("prices all tokens at the long-context rate above 100k input tokens", () => {
    expect(resolvePricing(model)?.(model, { inputTokens: 100001, outputTokens: 1000 })).toBeCloseTo(
      0.0525005,
    );
  });
  it("lets a host override replace the bundled rates", () => {
    expect(
      resolvePricing(model, JSON.stringify({ [model]: { input: 1, output: 5 } }))?.(model, {
        inputTokens: 100001,
        outputTokens: 1000,
      }),
    ).toBeCloseTo(0.105001);
  });
});

describe("gateway pricing", () => {
  const payload = {
    data: [
      { id: "vendor/model-a", pricing: { prompt: "0.000003", completion: "0.000015" } },
      { id: "vendor/free", pricing: { prompt: "0", completion: "0" } },
      { id: "vendor/no-price" },
      { id: "vendor/bad", pricing: { prompt: "-1", completion: "x" } },
    ],
  };

  it("converts per-token prices to per-million rates and skips unusable entries", () => {
    expect(parseGatewayCatalog(payload)).toEqual({
      "vendor/model-a": { input: 3, output: 15 },
    });
    expect(parseGatewayCatalog({ nope: true })).toEqual({});
  });

  it("prices a model from the gateway catalog by its id after the provider", () => {
    const model = "openai-compatible/vendor/model-a";
    const cost = resolvePricing(
      model,
      undefined,
      parseGatewayCatalog(payload),
    )?.(model, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(18);
  });

  it("lets the explicit override beat the gateway, and the gateway beat the bundled list", () => {
    const gateway = parseGatewayCatalog(payload);
    const model = "openai-compatible/vendor/model-a";
    const usage = { inputTokens: 1_000_000, outputTokens: 0 };
    const override = JSON.stringify({ [model]: { input: 1, output: 1 } });
    expect(resolvePricing(model, override, gateway)?.(model, usage)).toBeCloseTo(1);
    const bundled = "anthropic/claude-haiku-5-5";
    const gatewayHaiku = { "claude-haiku-5-5": { input: 9, output: 9 } };
    expect(resolvePricing(bundled, undefined, gatewayHaiku)?.(bundled, usage)).toBeCloseTo(9);
  });

  it("returns undefined when no source knows the model", () => {
    expect(resolvePricing("openai-compatible/unknown", undefined, {})).toBeUndefined();
  });
});
