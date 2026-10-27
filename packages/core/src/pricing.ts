import { z } from "zod";
import prices from "./pricing.json";
import type { PricingFn } from "./budget";

const rateSchema = z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() });
const priceSchema = rateSchema.extend({
  long_context: rateSchema.extend({ above_tokens: z.number().int().positive() }).optional(),
});
const catalogSchema = z.record(z.string(), priceSchema);

export type PriceCatalog = z.infer<typeof catalogSchema>;

const gatewayEntrySchema = z.object({
  id: z.string(),
  pricing: z.object({ prompt: z.coerce.number(), completion: z.coerce.number() }).optional(),
});
const gatewayModelsSchema = z.object({ data: z.array(z.unknown()) });

// Gateways such as OpenRouter list USD per token; the catalog is USD per million tokens.
export function parseGatewayCatalog(payload: unknown): PriceCatalog {
  const models = gatewayModelsSchema.safeParse(payload);
  if (!models.success) return {};
  const catalog: PriceCatalog = {};
  for (const raw of models.data.data) {
    const entry = gatewayEntrySchema.safeParse(raw);
    if (!entry.success || !entry.data.pricing) continue;
    const { prompt, completion } = entry.data.pricing;
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue;
    if (prompt < 0 || completion < 0 || (prompt === 0 && completion === 0)) continue;
    catalog[entry.data.id] = { input: prompt * 1_000_000, output: completion * 1_000_000 };
  }
  return catalog;
}

export function resolvePricing(
  model: string,
  override?: string,
  gateway?: PriceCatalog,
): PricingFn | undefined {
  const overrides = override ? catalogSchema.parse(JSON.parse(override)) : {};
  const gatewayId = model.slice(model.indexOf("/") + 1);
  const price = overrides[model] ?? gateway?.[gatewayId] ?? catalogSchema.parse(prices)[model];
  if (!price) return undefined;
  return (_model, usage) => {
    const rate =
      price.long_context && usage.inputTokens > price.long_context.above_tokens
        ? price.long_context
        : price;
    return (usage.inputTokens * rate.input + usage.outputTokens * rate.output) / 1_000_000;
  };
}
