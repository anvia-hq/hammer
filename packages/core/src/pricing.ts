import { z } from "zod";
import prices from "./pricing.json";
import type { PricingFn } from "./budget";

const rateSchema = z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() });
const priceSchema = rateSchema.extend({
  long_context: rateSchema.extend({ above_tokens: z.number().int().positive() }).optional(),
});
const catalogSchema = z.record(z.string(), priceSchema);

export function resolvePricing(model: string, override?: string): PricingFn | undefined {
  const catalog = catalogSchema.parse({
    ...prices,
    ...(override ? catalogSchema.parse(JSON.parse(override)) : {}),
  });
  const price = catalog[model];
  if (!price) return undefined;
  return (_model, usage) => {
    const rate =
      price.long_context && usage.inputTokens > price.long_context.above_tokens
        ? price.long_context
        : price;
    return (usage.inputTokens * rate.input + usage.outputTokens * rate.output) / 1_000_000;
  };
}
