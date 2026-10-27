import type { CompletionModel, StreamingCompletionModel } from "@anvia/core/completion";
import { Agent } from "@anvia/core/agent";
import {
  buildPriorFindingsContext,
  createBudget,
  DEFAULT_BATCH_TOKENS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_SINGLE_PASS_TOKENS,
  filterDuplicates,
  mergeBatchResults,
  planBatches,
  runBatches,
  validateFindings,
  type EffectiveConfig,
  type FileBatch,
  type PriorFinding,
  type PricingFn,
  type ReviewEventSink,
} from "@anvia/hammer-core";
import { COMPLETION_TIMEOUT_MS, createIdleSignal, STREAM_IDLE_MS } from "./idle-signal";
import { buildReviewPrompt, approxTokens, type BuildReviewPromptInput } from "./prompt";
import { buildReviewerTools, runSinglePassReview, type SinglePassRunOptions } from "./run";
import type { SkillSet } from "./skills";
import { applyVerification, VERIFICATION_INSTRUCTIONS } from "./verify";

export interface ReviewPipelineInput extends BuildReviewPromptInput {
  modelRef: string;
  anchorFiles?: BuildReviewPromptInput["files"];
  baseUrl?: string;
  config: EffectiveConfig;
  checkoutRoot: string;
  discussion: SinglePassRunOptions["discussion"];
  model: CompletionModel;
  prior?: PriorFinding[];
  priorFingerprints?: Set<string>;
  pricing?: PricingFn;
  reasoningEffort?: string;
  onEvent?: ReviewEventSink;
  skills?: SkillSet;
}

export async function runReviewPipeline(input: ReviewPipelineInput) {
  const emit: ReviewEventSink = (event) => {
    try {
      input.onEvent?.(event);
    } catch {}
  };
  const budget = createBudget({
    maxTokens: input.config.max_tokens,
    maxTurns: input.config.max_turns,
    maxCostUsd: input.config.max_cost_usd,
    ...(input.pricing ? { pricing: input.pricing } : {}),
  });
  const guarded = <T extends { abortSignal?: AbortSignal | undefined }>(options: T | undefined) => {
    if (!budget.canStartBatch().ok) throw new Error("Review budget reached.");
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
  const upstream = input.model as Partial<StreamingCompletionModel>;
  const model: CompletionModel = {
    provider: input.model.provider,
    modelId: input.model.modelId,
    capabilities: input.model.capabilities,
    ...(input.model.controls ? { controls: input.model.controls } : {}),
    async completion(request, options) {
      const response = await input.model.completion(request, guarded(options));
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
              for await (const event of upstream.streamCompletion!(request, {
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
  const context = input.prior?.length ? buildPriorFindingsContext(input.prior) : "";
  const promptInput = { ...input, priorFindings: context };
  const overhead = buildReviewPrompt({ ...promptInput, files: [] }).approxTokens;
  const planned = planBatches({
    files: input.files,
    estimateFileTokens: (file) => approxTokens(file.patch ?? "") + 200,
    singlePassTokens: Math.max(1, DEFAULT_SINGLE_PASS_TOKENS - overhead),
    batchTokens: Math.max(1, DEFAULT_BATCH_TOKENS - overhead),
  });
  const batches: FileBatch[] =
    planned.mode === "single"
      ? [
          {
            id: "single",
            dir: ".",
            files: input.files,
            tokens: buildReviewPrompt(promptInput).approxTokens,
          },
        ]
      : planned.batches;
  emit({
    type: "plan",
    files: input.files.length,
    batches: batches.length,
    batchList: batches.map((batch) => ({ id: batch.id, files: batch.files.length })),
  });
  const results = await runBatches({
    batches,
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    runBatch: async (batch) => {
      if (!budget.canStartBatch().ok) return { ok: false, error: "Review budget reached." };
      emit({ type: "batch_start", batch: batch.id, files: batch.files.length });
      const outcome = await runSinglePassReview(
        {
          ...promptInput,
          files: batch.files,
          model: input.modelRef,
          ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        },
        {
          model,
          checkoutRoot: input.checkoutRoot,
          files: batch.files,
          discussion: input.discussion ?? {},
          maxTurns: budget.maxTurns,
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          onToolCall: (name, detail) => emit({ type: "tool", batch: batch.id, name, detail }),
          onText: (kind, text) => emit({ type: "text", batch: batch.id, kind, text }),
          ...(input.skills ? { skills: input.skills } : {}),
        },
      );
      if (outcome.ok) {
        emit({
          type: "batch_end",
          batch: batch.id,
          ok: true,
          findings: outcome.batch.findings.length,
        });
        return outcome;
      }
      const error = outcome.issues.map((issue) => issue.message).join("; ");
      emit({ type: "batch_end", batch: batch.id, ok: false, findings: 0, error });
      return { ok: false, error };
    },
  });
  const merged = mergeBatchResults(results.results);
  const verifying = input.config.verify && merged.findings.length > 0;
  if (verifying) emit({ type: "verify_start", findings: merged.findings.length });
  const verification = await applyVerification({
    findings: merged.findings,
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
          discussion: input.discussion,
          onToolCall: (name, detail) => emit({ type: "tool", batch: "verify", name, detail }),
        }),
        maxTurns: input.config.max_turns,
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
      ...results.results.flatMap((entry) =>
        entry.status === "failed"
          ? [`Batch ${entry.id} failed: ${entry.error.slice(0, 1000)}`]
          : [],
      ),
      ...validated.generalNotes.map(
        ({ finding }) => `${finding.path}:${finding.line}: ${finding.body}`,
      ),
    ],
    usage: budget.summary(),
    partial: merged.partial || budget.summary().partial,
    failedBatches: results.results
      .filter((entry) => entry.status === "failed" && entry.error !== "Review budget reached.")
      .map((entry) => entry.id),
    unverified: verification.status === "unverified",
    duplicates: deduped.duplicates.length,
  };
}
export type ReviewPipelineResult = Awaited<ReturnType<typeof runReviewPipeline>>;
