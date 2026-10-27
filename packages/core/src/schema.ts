import { z } from "zod";

export const FindingSchema = z.object({
  path: z.string(),
  startLine: z.number().int().positive().optional(),
  line: z.number().int().positive(),
  severity: z.enum(["high", "medium", "low"]),
  category: z.enum([
    "correctness",
    "security",
    "performance",
    "reliability",
    "maintainability",
    "tests",
    "rule",
  ]),
  title: z.string().max(120),
  body: z.string().max(1500),
  details: z.string().max(1200).optional(),
  suggestion: z.string().optional(),
  ruleId: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

export const ReviewBatchSchema = z.object({
  summary: z.string().max(600),
  changes: z.array(z.string().max(160)).max(6).optional(),
  findings: z.array(FindingSchema).max(25),
  generalNotes: z.array(z.string().max(300)).max(5),
});

export type Finding = z.infer<typeof FindingSchema>;
export type ReviewBatch = z.infer<typeof ReviewBatchSchema>;

export interface BatchValidationIssue {
  path: string;
  message: string;
}

export type BatchValidationResult =
  | { ok: true; value: ReviewBatch }
  | { ok: false; issues: BatchValidationIssue[] };

function toIssues(error: z.ZodError): BatchValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}

// Models without native JSON-schema output often wrap the object in a code fence or a sentence.
function extractJsonObject(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

function describeUnparsable(text: string): string {
  const trimmed = text.trim();
  const ending = trimmed.endsWith("}") ? "ends with }" : "does not end with }, possibly cut off";
  return `Output is not valid JSON (${trimmed.length} chars, ${ending}).`;
}

export function validateBatchOutput(raw: unknown): BatchValidationResult {
  let candidate: unknown = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(extractJsonObject(raw));
    } catch {
      return { ok: false, issues: [{ path: "(root)", message: describeUnparsable(raw) }] };
    }
  }
  const parsed = ReviewBatchSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: toIssues(parsed.error) };
}

export function buildRepairPrompt(originalPrompt: string, issues: BatchValidationIssue[]): string {
  const details = issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
  return `${originalPrompt}\n\nYour previous output did not match the required JSON schema. Fix these validation issues:\n${details}\n\nRespond with only JSON matching the schema: an object with summary (max 600 characters), optional changes (max 6 strings of max 160 characters each), findings (max 25 items, each with an optional details string of max 1200 characters), and generalNotes (max 5 strings of max 300 characters each).`;
}

export type RepairFailureCode = "schema_violation" | "generate_failed";

export type RunWithRepairResult =
  | { ok: true; value: ReviewBatch }
  | { ok: false; error: RepairFailureCode; issues: BatchValidationIssue[] };

export interface RunWithRepairOptions {
  prompt: string;
  generate: (prompt: string) => unknown | Promise<unknown>;
  validate?: (raw: unknown) => BatchValidationResult;
  maxRepairs?: number;
}

export async function runWithRepair(options: RunWithRepairOptions): Promise<RunWithRepairResult> {
  const validate = options.validate ?? validateBatchOutput;
  const maxRepairs = options.maxRepairs ?? 1;
  let prompt = options.prompt;
  let repairs = 0;
  for (;;) {
    let raw: unknown;
    try {
      raw = await options.generate(prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: "generate_failed", issues: [{ path: "(generate)", message }] };
    }
    const result = validate(raw);
    if (result.ok) return { ok: true, value: result.value };
    if (repairs >= maxRepairs) {
      return { ok: false, error: "schema_violation", issues: result.issues };
    }
    repairs += 1;
    prompt = buildRepairPrompt(options.prompt, result.issues);
  }
}
