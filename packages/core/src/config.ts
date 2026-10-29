import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const DEFAULT_CONFIG_PATH = ".github/hammer.yml";

export type Severity = "high" | "medium" | "low";
export type FailOn = "none" | "high" | "medium";

export interface ConfigRule {
  id: string;
  text: string;
}

export interface PathInstruction {
  path: string;
  text: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const severitySchema = z.enum(["high", "medium", "low"]);
const failOnSchema = z.enum(["none", "high", "medium"]);

const ruleSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});

const pathInstructionSchema = z.object({
  path: z.string().min(1),
  text: z.string().min(1),
});

const stringListSchema = z.array(z.string().min(1));

const repoConfigSchema = z.object({
  min_severity: severitySchema.default("medium"),
  max_comments: z.number().int().min(0).default(10),
  review_drafts: z.boolean().default(false),
  fail_on: failOnSchema.default("none"),
  ignore: stringListSchema.default([]),
  include: stringListSchema.default([]),
  ignore_authors: stringListSchema.default(["dependabot[bot]", "renovate[bot]"]),
  use_repo_guidelines: z.boolean().default(true),
  language: z.string().min(1).default("en"),
  rules: z.array(ruleSchema).default([]),
  path_instructions: z.array(pathInstructionSchema).default([]),
  max_files: z.number().int().min(1).optional(),
  max_diff_lines: z.number().int().min(1).optional(),
  max_turns: z.number().int().min(1).optional(),
  max_tokens: z.number().int().min(1).optional(),
  max_cost_usd: z.number().nonnegative().optional(),
  verify: z.boolean().default(true),
  verify_threshold: z.number().int().min(0).max(10).default(6),
});

export type RepoConfig = z.infer<typeof repoConfigSchema>;

export interface ConfigInputOverrides {
  min_severity?: Severity;
  max_comments?: number;
  review_drafts?: boolean;
  fail_on?: FailOn;
  ignore?: string[];
  include?: string[];
  max_files?: number;
  max_diff_lines?: number;
  max_turns?: number;
  max_tokens?: number;
  max_cost_usd?: number;
  verify?: boolean;
  verify_threshold?: number;
}

export interface EffectiveConfig {
  min_severity: Severity;
  max_comments: number;
  review_drafts: boolean;
  fail_on: FailOn;
  ignore: string[];
  include: string[];
  ignore_authors: string[];
  use_repo_guidelines: boolean;
  language: string;
  rules: ConfigRule[];
  path_instructions: PathInstruction[];
  max_files: number;
  max_diff_lines: number;
  max_turns: number;
  max_tokens?: number | undefined;
  max_cost_usd?: number | undefined;
  verify: boolean;
  verify_threshold: number;
}

export interface LoadConfigOptions {
  source?: string;
  onWarning?: (message: string) => void;
}

export const DEFAULT_CAPS = {
  max_files: 50,
  max_diff_lines: 3000,
  max_turns: 100,
} as const;

const KNOWN_KEYS = new Set(Object.keys(repoConfigSchema.shape));

const HOST_LEVEL_KEYS = new Set(["baseurl", "lensendpoint", "otelendpoint"]);

function isHostLevelKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  if (HOST_LEVEL_KEYS.has(normalized)) return true;
  if (normalized === "token" || normalized.endsWith("token")) return true;
  return normalized === "apikey" || normalized.endsWith("apikey");
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}

export function defaultRepoConfig(): RepoConfig {
  return repoConfigSchema.parse({});
}

export function loadConfig(
  content: string | null | undefined,
  options: LoadConfigOptions = {},
): RepoConfig {
  const source = options.source ?? DEFAULT_CONFIG_PATH;
  if (content === null || content === undefined || content.trim() === "") {
    return defaultRepoConfig();
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Invalid YAML in ${source}: ${detail}`);
  }

  if (raw === null || raw === undefined) {
    return defaultRepoConfig();
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    const found = Array.isArray(raw) ? "a list" : `a ${typeof raw}`;
    throw new ConfigError(
      `Invalid Hammer config in ${source}: expected a mapping of config keys but found ${found}.`,
    );
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (isHostLevelKey(key)) {
      throw new ConfigError(
        `Invalid Hammer config in ${source}: "${key}" is a host-level setting and cannot be set in repo config. Set it as an action input instead.`,
      );
    }
    if (!KNOWN_KEYS.has(key)) {
      options.onWarning?.(`Unknown Hammer config key "${key}" in ${source}; ignoring it.`);
    }
  }

  const parsed = repoConfigSchema.safeParse(record);
  if (!parsed.success) {
    throw new ConfigError(`Invalid Hammer config in ${source}:\n${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

function clampCap(
  repoValue: number | undefined,
  inputValue: number | undefined,
  fallback: number,
): number {
  if (inputValue === undefined) return repoValue ?? fallback;
  return Math.min(repoValue ?? inputValue, inputValue);
}

function clampOptionalCap(
  repoValue: number | undefined,
  inputValue: number | undefined,
): number | undefined {
  if (inputValue === undefined) return repoValue;
  return Math.min(repoValue ?? inputValue, inputValue);
}

export function resolveConfig(
  config: RepoConfig,
  inputs: ConfigInputOverrides = {},
): EffectiveConfig {
  return {
    min_severity: inputs.min_severity ?? config.min_severity,
    max_comments: inputs.max_comments ?? config.max_comments,
    review_drafts: inputs.review_drafts ?? config.review_drafts,
    fail_on: inputs.fail_on ?? config.fail_on,
    ignore: inputs.ignore ?? config.ignore,
    include: inputs.include ?? config.include,
    ignore_authors: config.ignore_authors,
    use_repo_guidelines: config.use_repo_guidelines,
    language: config.language,
    rules: config.rules,
    path_instructions: config.path_instructions,
    max_files: clampCap(config.max_files, inputs.max_files, DEFAULT_CAPS.max_files),
    max_diff_lines: clampCap(
      config.max_diff_lines,
      inputs.max_diff_lines,
      DEFAULT_CAPS.max_diff_lines,
    ),
    max_turns: clampCap(config.max_turns, inputs.max_turns, DEFAULT_CAPS.max_turns),
    max_tokens: clampOptionalCap(config.max_tokens, inputs.max_tokens),
    max_cost_usd: clampOptionalCap(config.max_cost_usd, inputs.max_cost_usd),
    verify: inputs.verify ?? config.verify,
    verify_threshold: inputs.verify_threshold ?? config.verify_threshold,
  };
}
