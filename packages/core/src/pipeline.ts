import type { CompletionModel } from "@anvia/core/completion";
import { Agent } from "@anvia/core/agent";
import { buildReviewPrompt, approxTokens, type BuildReviewPromptInput } from "./agent/prompt";
import { buildReviewerTools, runSinglePassReview, type SinglePassRunOptions } from "./agent/run";
import { planBatches, runBatches, mergeBatchResults, type FileBatch } from "./batching";
import { createBudget, type PricingFn } from "./budget";
import type { EffectiveConfig } from "./config";
import { filterDuplicates, type PriorFinding } from "./dedupe";
import { buildPriorFindingsContext } from "./dedupe";
import { validateFindings } from "./validate";
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
}

export async function runReviewPipeline(input: ReviewPipelineInput) {
  const budget = createBudget({
    maxTokens: input.config.max_tokens,
    maxTurns: input.config.max_turns,
    maxCostUsd: input.config.max_cost_usd,
    ...(input.pricing ? { pricing: input.pricing } : {}),
  });
  const model: CompletionModel = {
    provider: input.model.provider,
    modelId: input.model.modelId,
    capabilities: input.model.capabilities,
    async completion(request, options) {
      if (!budget.canStartBatch().ok) throw new Error("Review budget reached.");
      const timeout = AbortSignal.timeout(120_000);
      const response = await input.model.completion(request, {
        ...options,
        abortSignal: options?.abortSignal
          ? AbortSignal.any([timeout, options.abortSignal])
          : timeout,
      });
      budget.recordUsage({
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        totalTokens: response.usage.inputTokens + response.usage.outputTokens,
        model: input.modelRef,
      });
      return response;
    },
  };
  const context = input.prior?.length ? buildPriorFindingsContext(input.prior) : "";
  const promptInput = { ...input, priorFindings: context };
  const overhead = buildReviewPrompt({ ...promptInput, files: [] }).approxTokens;
  const planned = planBatches({
    files: input.files,
    estimateFileTokens: (file) => approxTokens(file.patch ?? "") + 200,
    singlePassTokens: Math.max(1, 60000 - overhead),
    batchTokens: Math.max(1, 40000 - overhead),
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
  const results = await runBatches({
    batches,
    maxConcurrent: 3,
    runBatch: async (batch) => {
      if (!budget.canStartBatch().ok) return { ok: false, error: "Review budget reached." };
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
        },
      );
      return outcome.ok
        ? outcome
        : { ok: false, error: outcome.issues.map((issue) => issue.message).join("; ") };
    },
  });
  const merged = mergeBatchResults(results.results);
  const verification = await applyVerification({
    findings: merged.findings,
    verify: input.config.verify && merged.findings.length > 0,
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
        }),
        maxTurns: input.config.max_turns,
        maxTokens: 4096,
        retries: { maxAttempts: 3 },
      });
      const response = await verifier.generate({ prompt });
      if (response.type !== "response") throw new Error("Verification did not finish.");
      return response.text;
    },
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
  return {
    summary: merged.summaries.join(" "),
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
