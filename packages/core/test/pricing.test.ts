import { describe, expect, it } from "vitest";
import { resolvePricing } from "../src/index";

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
