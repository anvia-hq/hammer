import type { CompletionModel, Message, StreamingCompletionModel } from "@anvia/core/completion";
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
import { promptCacheProviderOptions } from "./model";
import type { SkillSet } from "./skills";
import { findChangeLeads } from "./leads";
import { shardFiles } from "./shard";
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
type ShardReview =
  | {
      ok: true;
      batch: ReviewBatch;
      partial?: boolean;
      note?: string;
      finishReason?: string;
      outputChars?: number;
    }
  | {
      ok: false;
      error: string;
      finishReason?: string;
      outputChars?: number;
      repairAttempted?: boolean;
    };

const WIND_DOWN_RATIO = 0.85;
const SOFT_TURNS = 12;
const TURN_MARGIN = 3;

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
  const upstream = input.model as Partial<StreamingCompletionModel>;
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
  // Anthropic binds a signed thinking block to the tools/tool_choice shape of the turn
  // that created it, so wind-down must never change the request mid-conversation. Instead
  // the budget state below is surfaced to reviewer tools (see isNearBudget), which return a
  // wind-down message and skip the real work, while the request itself stays untouched.
  const createRunner = (softTurns: number, reviewing: boolean) => {
    let finalizing = false;
    let lastHistory: Message[] = [];
    let calls = 0;
    let near = false;
    const turnMargin = Math.min(TURN_MARGIN, Math.floor(budget.maxTurns / 4));
    const guarded = <T extends { abortSignal?: AbortSignal | undefined }>(
      options: T | undefined,
    ) => {
      if (!finalizing && !budget.canStartBatch().ok) throw new Error("Review budget reached.");
      if (verifyDeadline !== undefined && Date.now() > verifyDeadline)
        throw new Error("Verification time limit reached.");
      const timeout = AbortSignal.timeout(COMPLETION_TIMEOUT_MS);
      return {
        ...options,
        abortSignal: options?.abortSignal
          ? AbortSignal.any([timeout, options.abortSignal])
          : timeout,
      };
    };
    const trackWindDown = (): void => {
      const { tokens, costUsd } = budget.summary();
      calls += 1;
      near =
        tokens >= budget.maxTokens * WIND_DOWN_RATIO ||
        (costUsd !== null && costUsd >= budget.maxCostUsd * WIND_DOWN_RATIO) ||
        (reviewing && calls > softTurns) ||
        (reviewing && calls >= budget.maxTurns - turnMargin);
    };
    const model: CompletionModel = {
      provider: input.model.provider,
      modelId: input.model.modelId,
      capabilities: input.model.capabilities,
      ...(input.model.controls ? { controls: input.model.controls } : {}),
      async completion(request, options) {
        lastHistory = request.chatHistory;
        trackWindDown();
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
              if (!finalizing && !budget.canStartBatch().ok)
                throw new Error("Review budget reached.");
              lastHistory = request.chatHistory;
              trackWindDown();
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
    return {
      model,
      isNearBudget: (): boolean => near,
      getHistory: (): Message[] => lastHistory,
      beginFinalize: (): void => {
        finalizing = true;
      },
      endFinalize: (): void => {
        finalizing = false;
      },
    };
  };
  const focusPaths = new Set(input.files.map((file) => file.filename));
  const context = input.prior?.length
    ? buildPriorFindingsContext(input.prior, undefined, focusPaths)
    : "";
  const resolvedContext = input.resolved?.length
    ? buildResolvedFindingsContext(input.resolved, undefined, focusPaths)
    : "";
  const sharding = shardFiles(
    input.files,
    input.fileContents ?? {},
    input.config.shard_tokens,
    input.config.max_shards,
  );
  emit({ type: "plan", files: input.files.length });
  const reviewShard = async (
    shardFilesList: PullFileEntry[],
    shardNote: string | undefined,
  ): Promise<ShardReview> => {
    if (!budget.canStartBatch().ok) return { ok: false, error: "Review budget reached." };
    const diff = buildPrDiff(shardFilesList, input.fileContents);
    const runner = createRunner(
      SOFT_TURNS + 2 * Math.ceil(diff.totalLines / DIFF_PAGE_LINES),
      true,
    );
    const changeLeads = await findChangeLeads(shardFilesList, input.checkoutRoot);
    const outcome = await runSinglePassReview(
      {
        ...input,
        files: shardFilesList,
        ...(changeLeads !== "" ? { changeLeads } : {}),
        priorFindings: context,
        resolvedFindings: resolvedContext,
        ...(shardNote ? { shardNote } : {}),
        model: input.modelRef,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      },
      {
        model: runner.model,
        checkoutRoot: input.checkoutRoot,
        files: shardFilesList,
        diff,
        ...(input.pr ? { pr: input.pr } : {}),
        discussion: input.discussion ?? {},
        maxTurns: budget.maxTurns,
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        onToolCall: (name, detail) => emit({ type: "tool", name, detail }),
        onText: (kind, text) => emit({ type: "text", kind, text }),
        ...(input.skills ? { skills: input.skills } : {}),
        isNearBudget: runner.isNearBudget,
        getHistory: runner.getHistory,
        beginFinalize: runner.beginFinalize,
      },
    );
    runner.endFinalize();
    if (outcome.ok) {
      const succeeding: ShardReview = { ok: true, batch: outcome.batch };
      if (outcome.partial === true) succeeding.partial = true;
      if (outcome.note !== undefined) succeeding.note = outcome.note;
      if (outcome.finishReason !== undefined) succeeding.finishReason = outcome.finishReason;
      if (outcome.outputChars !== undefined) succeeding.outputChars = outcome.outputChars;
      return succeeding;
    }
    const failing: ShardReview = {
      ok: false,
      error: outcome.issues.map((issue) => issue.message).join("; "),
    };
    if (outcome.finishReason !== undefined) failing.finishReason = outcome.finishReason;
    if (outcome.outputChars !== undefined) failing.outputChars = outcome.outputChars;
    if (outcome.repairAttempted === true) failing.repairAttempted = true;
    return failing;
  };
  let review: ShardReview;
  const failedShardFiles: Array<{ path: string; reason: string }> = [];
  if (sharding.shards.length <= 1) {
    review = await reviewShard(input.files, undefined);
  } else {
    const total = sharding.shards.length;
    const results = await Promise.all(
      sharding.shards.map((shard, index) =>
        reviewShard(
          shard,
          `This is shard ${index + 1} of ${total} of a large pull request. Review only the files listed below; other agents review the rest in parallel. Do not report findings for files outside this shard.`,
        ).catch((error: unknown): ShardReview => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })),
      ),
    );
    const good = results.flatMap((result) => (result.ok ? [result] : []));
    results.forEach((result, index) => {
      if (result.ok) return;
      for (const file of sharding.shards[index] ?? [])
        failedShardFiles.push({
          path: file.filename,
          reason: `review shard ${index + 1} of ${total} failed: ${result.error.slice(0, 200)}`,
        });
    });
    const firstFailure = results.find((result) => !result.ok);
    if (good.length === 0 && firstFailure !== undefined) {
      review = firstFailure;
    } else {
      const notes = [
        ...(failedShardFiles.length > 0
          ? [`${results.length - good.length} of ${total} review shards failed`]
          : []),
        ...good.flatMap((result) => (result.note !== undefined ? [result.note] : [])),
      ];
      review = {
        ok: true,
        batch: {
          summary: good
            .map((result) => result.batch.summary)
            .join(" ")
            .slice(0, 600),
          changes: good.flatMap((result) => result.batch.changes ?? []).slice(0, 6),
          findings: good.flatMap((result) => result.batch.findings),
          generalNotes: good.flatMap((result) => result.batch.generalNotes).slice(0, 5),
        },
        ...(failedShardFiles.length > 0 || good.some((result) => result.partial === true)
          ? { partial: true }
          : {}),
        ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
      };
    }
  }
  if (review.ok) {
    emit({
      type: "review_end",
      ok: true,
      findings: review.batch.findings.length,
      ...(review.partial === true ? { partial: true as const } : {}),
      ...(review.finishReason !== undefined ? { finishReason: review.finishReason } : {}),
      ...(review.outputChars !== undefined ? { outputChars: review.outputChars } : {}),
    });
  } else {
    emit({
      type: "review_end",
      ok: false,
      findings: 0,
      error: review.error,
      ...(review.finishReason !== undefined ? { finishReason: review.finishReason } : {}),
      ...(review.outputChars !== undefined ? { outputChars: review.outputChars } : {}),
    });
  }
  const verifyRunner = createRunner(0, false);
  const model = verifyRunner.model;
  const isNearBudget = verifyRunner.isNearBudget;
  const merged = {
    summaries: review.ok ? [review.batch.summary] : [],
    changes: review.ok ? (review.batch.changes ?? []) : [],
    findings: review.ok ? review.batch.findings : [],
    generalNotes: review.ok ? review.batch.generalNotes : [],
    partial: !review.ok || (review.ok && review.partial === true),
  };
  const verifying = input.config.verify && merged.findings.length > 0;
  if (verifying) verifyDeadline = Date.now() + VERIFY_TIME_LIMIT_MS;
  if (verifying) emit({ type: "verify_start", findings: merged.findings.length });
  const providerOptions = promptCacheProviderOptions(input.model.provider);
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
        ...(providerOptions ? { providerOptions } : {}),
        instructions: VERIFICATION_INSTRUCTIONS,
        tools: buildReviewerTools({
          checkoutRoot: input.checkoutRoot,
          files: input.files,
          fileContents: input.fileContents ?? {},
          pr: { title: input.title, ...input.pr },
          discussion: input.discussion,
          onToolCall: (name, detail) => emit({ type: "tool", name: `verify ${name}`, detail }),
          isNearBudget,
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
      ...(verification.status === "unverified"
        ? { unverified: verification.note ?? "no reason given" }
        : {}),
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
  const belowSeverity = validated.dropped.filter(
    (entry) => entry.reason === "below_min_severity",
  ).length;
  const lowConfidence = validated.dropped.filter(
    (entry) => entry.reason === "low_confidence",
  ).length;
  if (belowSeverity + lowConfidence + deduped.duplicates.length > 0)
    emit({
      type: "filtered",
      belowSeverity,
      lowConfidence,
      duplicates: deduped.duplicates.length,
    });
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
    ...(!review.ok && review.repairAttempted === true ? { repairAttempted: true as const } : {}),
    ...(review.ok && review.partial === true && review.note !== undefined
      ? { reviewNote: review.note }
      : {}),
    ...((review.ok && review.finishReason !== undefined) ||
    (!review.ok && review.finishReason !== undefined)
      ? { finishReason: review.finishReason }
      : {}),
    ...((review.ok && review.outputChars !== undefined) ||
    (!review.ok && review.outputChars !== undefined)
      ? { outputChars: review.outputChars }
      : {}),
    duplicates: deduped.duplicates.length,
    ...(failedShardFiles.length > 0 ? { notReviewed: failedShardFiles } : {}),
    shards: sharding.shards.length,
  };
}
export type ReviewPipelineResult = Awaited<ReturnType<typeof runReviewPipeline>>;
