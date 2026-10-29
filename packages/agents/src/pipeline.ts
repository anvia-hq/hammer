import type { CompletionModel, StreamingCompletionModel } from "@anvia/core/completion";
import { Agent } from "@anvia/core/agent";
import {
  buildPriorFindingsContext,
  buildResolvedFindingsContext,
  createBudget,
  filterDuplicates,
  validateFindings,
  type EffectiveConfig,
  type ReviewBatch,
  type PriorFinding,
  type PullFileEntry,
  type PricingFn,
  type ReviewEventSink,
} from "@anvia/hammer-core";
import { COMPLETION_TIMEOUT_MS, createIdleSignal, STREAM_IDLE_MS } from "./idle-signal";
import { buildPrDiff, DIFF_PAGE_LINES, type PrMeta } from "./diff";
import type { BuildReviewPromptInput } from "./prompt";
import { buildReviewerTools, runSinglePassReview, type SinglePassRunOptions } from "./run";
import type { SkillSet } from "./skills";
import { applyVerification, VERIFICATION_INSTRUCTIONS } from "./verify";

const VERIFY_MAX_TURNS = 15;
const VERIFY_TIME_LIMIT_MS = 240_000;

export interface ReviewPipelineInput extends BuildReviewPromptInput {
  modelRef: string;
  anchorFiles?: BuildReviewPromptInput["files"];
  baseUrl?: string;
  pr?: Omit<PrMeta, "title">;
  config: EffectiveConfig;
  checkoutRoot: string;
  discussion: SinglePassRunOptions["discussion"];
  model: CompletionModel;
  prior?: PriorFinding[];
  resolved?: PriorFinding[];
  priorFingerprints?: Set<string>;
  pricing?: PricingFn;
  reasoningEffort?: string;
  onEvent?: ReviewEventSink;
  skills?: SkillSet;
}

const MAX_VERIFY_DIFF_CHARS = 16_000;
const WIND_DOWN_RATIO = 0.85;
const SOFT_TURNS = 12;

function buildDiffContext(findings: Array<{ path: string }>, files: PullFileEntry[]): string {
  const paths = new Set(findings.map((finding) => finding.path));
  const text = files
    .filter((file) => paths.has(file.filename) && file.patch)
    .map((file) => `### ${file.filename}\n${file.patch}`)
    .join("\n\n");
  return text.slice(0, MAX_VERIFY_DIFF_CHARS);
}

export async function runReviewPipeline(input: ReviewPipelineInput) {
  const emit: ReviewEventSink = (event) => {
    try {
      input.onEvent?.(event);
    } catch {}
  };
  const budget = createBudget({
    maxTurns: input.config.max_turns,
    ...(input.config.max_tokens !== undefined ? { maxTokens: input.config.max_tokens } : {}),
    ...(input.config.max_cost_usd !== undefined ? { maxCostUsd: input.config.max_cost_usd } : {}),
    ...(input.pricing ? { pricing: input.pricing } : {}),
  });
  let verifyDeadline: number | undefined;
  const guarded = <T extends { abortSignal?: AbortSignal | undefined }>(options: T | undefined) => {
    if (!budget.canStartBatch().ok) throw new Error("Review budget reached.");
    if (verifyDeadline !== undefined && Date.now() > verifyDeadline)
      throw new Error("Verification time limit reached.");
    const timeout = AbortSignal.timeout(COMPLETION_TIMEOUT_MS);
    return {
      ...options,
      abortSignal: options?.abortSignal ? AbortSignal.any([timeout, options.abortSignal]) : timeout,
    };
  };
  const record = (usage: { inputTokens: number; outputTokens: number }): void => {
    budget.recordUsage({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      model: input.modelRef,
    });
    const { tokens, costUsd } = budget.summary();
    emit({ type: "turn", tokens, costUsd });
  };
  const diff = buildPrDiff(input.files, input.fileContents);
  const softTurns = SOFT_TURNS + 2 * Math.ceil(diff.totalLines / DIFF_PAGE_LINES);
  let reviewing = true;
  let calls = 0;
  const windDown = <T extends Parameters<CompletionModel["completion"]>[0]>(request: T): T => {
    const { tokens, costUsd } = budget.summary();
    calls += 1;
    const near =
      tokens >= budget.maxTokens * WIND_DOWN_RATIO ||
      (costUsd !== null && costUsd >= budget.maxCostUsd * WIND_DOWN_RATIO) ||
      (reviewing && calls > softTurns);
    // Changing the tool list mid-conversation invalidates signed thinking blocks (Anthropic 400),
    // so keep it and forbid calls instead.
    return near ? { ...request, toolChoice: "none" } : request;
  };
  const upstream = input.model as Partial<StreamingCompletionModel>;
  const model: CompletionModel = {
    provider: input.model.provider,
    modelId: input.model.modelId,
    capabilities: input.model.capabilities,
    ...(input.model.controls ? { controls: input.model.controls } : {}),
    async completion(request, options) {
      const response = await input.model.completion(windDown(request), guarded(options));
      record(response.usage);
      return response;
    },
    ...(upstream.streamCompletion
      ? {
          async *streamCompletion(
            request: Parameters<CompletionModel["completion"]>[0],
            options?: Parameters<CompletionModel["completion"]>[1],
          ) {
            if (!budget.canStartBatch().ok) throw new Error("Review budget reached.");
            const idle = createIdleSignal(STREAM_IDLE_MS, options?.abortSignal);
            try {
              for await (const event of upstream.streamCompletion!(windDown(request), {
                ...options,
                abortSignal: idle.signal,
              })) {
                idle.touch();
                if (event.type === "final") record(event.response.usage);
                yield event;
              }
            } finally {
              idle.clear();
            }
          },
        }
      : {}),
  };
  const focusPaths = new Set(input.files.map((file) => file.filename));
  const context = input.prior?.length
    ? buildPriorFindingsContext(input.prior, undefined, focusPaths)
    : "";
  const resolvedContext = input.resolved?.length
    ? buildResolvedFindingsContext(input.resolved, undefined, focusPaths)
    : "";
  const promptInput = { ...input, priorFindings: context, resolvedFindings: resolvedContext };
  emit({ type: "plan", files: input.files.length });
  let review: { ok: true; batch: ReviewBatch } | { ok: false; error: string };
  if (!budget.canStartBatch().ok) {
    review = { ok: false, error: "Review budget reached." };
  } else {
    const outcome = await runSinglePassReview(
      {
        ...promptInput,
        model: input.modelRef,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      },
      {
        model,
        checkoutRoot: input.checkoutRoot,
        files: input.files,
        diff,
        ...(input.pr ? { pr: input.pr } : {}),
        discussion: input.discussion ?? {},
        maxTurns: budget.maxTurns,
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        onToolCall: (name, detail) => emit({ type: "tool", name, detail }),
        onText: (kind, text) => emit({ type: "text", kind, text }),
        ...(input.skills ? { skills: input.skills } : {}),
      },
    );
    if (outcome.ok) {
      review = { ok: true, batch: outcome.batch };
      emit({ type: "review_end", ok: true, findings: outcome.batch.findings.length });
    } else {
      const error = outcome.issues.map((issue) => issue.message).join("; ");
      review = { ok: false, error };
      emit({ type: "review_end", ok: false, findings: 0, error });
    }
  }
  reviewing = false;
  const merged = {
    summaries: review.ok ? [review.batch.summary] : [],
    changes: review.ok ? (review.batch.changes ?? []) : [],
    findings: review.ok ? review.batch.findings : [],
    generalNotes: review.ok ? review.batch.generalNotes : [],
    partial: !review.ok,
  };
  const verifying = input.config.verify && merged.findings.length > 0;
  if (verifying) verifyDeadline = Date.now() + VERIFY_TIME_LIMIT_MS;
  if (verifying) emit({ type: "verify_start", findings: merged.findings.length });
  const verification = await applyVerification({
    findings: merged.findings,
    diffContext: buildDiffContext(merged.findings, input.files),
    verify: verifying,
    verifyThreshold: input.config.verify_threshold,
    canContinue: () => budget.canStartBatch().ok,
    runVerifier: async (prompt) => {
      const verifier = new Agent({
        id: "hammer-verifier",
        model,
        instructions: VERIFICATION_INSTRUCTIONS,
        tools: buildReviewerTools({
          checkoutRoot: input.checkoutRoot,
          files: input.files,
          fileContents: input.fileContents ?? {},
          pr: { title: input.title, ...input.pr },
          discussion: input.discussion,
          onToolCall: (name, detail) => emit({ type: "tool", name: `verify ${name}`, detail }),
        }),
        maxTurns: Math.min(input.config.max_turns, VERIFY_MAX_TURNS),
        maxTokens: 4096,
        retries: { maxAttempts: 3 },
        ...(input.reasoningEffort ? { controls: { reasoningEffort: input.reasoningEffort } } : {}),
      });
      const response = await verifier.generate({ prompt });
      if (response.type !== "response") throw new Error("Verification did not finish.");
      return response.text;
    },
  });
  if (verifying)
    emit({
      type: "verify_end",
      kept: verification.findings.length,
      dropped: verification.dropped.length,
    });
  const validated = validateFindings(
    verification.findings,
    input.anchorFiles ?? input.files,
    input.config,
  );
  const deduped = filterDuplicates(
    [...validated.inline, ...validated.single].map((entry) => entry.finding),
    input.priorFingerprints ?? new Set(),
  );
  const kept = new Set(deduped.kept);
  const findings = [...validated.inline, ...validated.single]
    .map((entry) => entry.finding)
    .concat(validated.generalNotes.map((entry) => entry.finding));
  emit({
    type: "done",
    inline: validated.inline.length + validated.single.length,
    notes: validated.generalNotes.length,
  });
  return {
    summary: merged.summaries.join(" "),
    changes: merged.changes,
    ...validated,
    findings,
    inline: validated.inline.filter((entry) => kept.has(entry.finding)),
    single: validated.single.filter((entry) => kept.has(entry.finding)),
    generalNotes: [
      ...merged.generalNotes,
      ...validated.generalNotes.map(
        ({ finding }) => `${finding.path}:${finding.line}: ${finding.body}`,
      ),
    ],
    usage: budget.summary(),
    partial: merged.partial || budget.summary().partial,
    failed: !review.ok && review.error !== "Review budget reached.",
    unverified: verification.status === "unverified",
    ...(review.ok ? {} : { reviewError: review.error.slice(0, 1000) }),
    duplicates: deduped.duplicates.length,
  };
}
export type ReviewPipelineResult = Awaited<ReturnType<typeof runReviewPipeline>>;
