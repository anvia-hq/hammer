import { DEFAULT_CAPS, DEFAULT_CONFIG_PATH, type ConfigInputOverrides } from "@anvia/hammer-core";
import { z } from "zod";

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
const bool = z.enum(["true", "false"]).transform((value) => value === "true");
const count = z.coerce.number().int().positive();
const globs = z.string().transform((value) =>
  value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean),
);
const schema = z.object({
  model: z.string(),
  pricing: z.string(),
  "api-key": z.string(),
  "github-token": z.string(),
  "base-url": z.string(),
  "config-path": z.string().default(DEFAULT_CONFIG_PATH),
  "lens-endpoint": z.string(),
  "otel-endpoint": z.string(),
  min_severity: optional(z.enum(["high", "medium", "low"])),
  max_comments: optional(z.coerce.number().int().nonnegative()),
  fail_on: optional(z.enum(["none", "high", "medium"])),
  review_drafts: optional(bool),
  ignore: optional(globs),
  include: optional(globs),
  max_files: count.default(DEFAULT_CAPS.max_files),
  max_diff_lines: count.default(DEFAULT_CAPS.max_diff_lines),
  max_turns: count.default(DEFAULT_CAPS.max_turns),
  max_tokens: count.default(DEFAULT_CAPS.max_tokens),
  max_cost_usd: z.coerce.number().nonnegative().default(DEFAULT_CAPS.max_cost_usd),
  verify: optional(bool),
  verify_threshold: optional(z.coerce.number().int().min(0).max(10)),
  fail_on_error: bool.default(false),
});

export type ActionInputs = z.infer<typeof schema>;

export function readInputs(getInput: (name: string) => string): ActionInputs {
  const raw = Object.fromEntries(
    Object.keys(schema.shape).map((key) => {
      const value = getInput(key);
      const defaulted = [
        "config-path",
        "max_files",
        "max_diff_lines",
        "max_turns",
        "max_tokens",
        "max_cost_usd",
        "fail_on_error",
      ].includes(key);
      return [key, value === "" && defaulted ? undefined : value];
    }),
  );
  return schema.parse(raw);
}

export function configOverrides(inputs: ActionInputs): ConfigInputOverrides {
  const keys = [
    "min_severity",
    "max_comments",
    "fail_on",
    "review_drafts",
    "ignore",
    "include",
    "max_files",
    "max_diff_lines",
    "max_turns",
    "max_tokens",
    "max_cost_usd",
    "verify",
    "verify_threshold",
  ] as const;
  return Object.fromEntries(
    keys.filter((key) => inputs[key] !== undefined).map((key) => [key, inputs[key]]),
  ) as ConfigInputOverrides;
}
