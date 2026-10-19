import { DEFAULT_SINGLE_PASS_TOKENS } from "./agent/run";
import type { Finding, ReviewBatch } from "./agent/schema";
import type { Budget } from "./budget";
import type { PullFileEntry } from "./github/files";

export const DEFAULT_BATCH_TOKENS = 40000;
export const DEFAULT_MAX_CONCURRENT = 3;

export interface FileBatch {
  id: string;
  dir: string;
  files: PullFileEntry[];
  tokens: number;
  oversized?: boolean | undefined;
}

export interface PlanBatchesInput<TFile = PullFileEntry> {
  files: TFile[];
  singlePassTokens?: number;
  batchTokens?: number;
  estimateFileTokens: (file: TFile) => number;
}

export type PlanBatchesResult<TFile = PullFileEntry> =
  | { mode: "single"; batches: [TFile[]] }
  | { mode: "batched"; batches: FileBatch[] };

export interface BatchUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number | undefined;
  model?: string | undefined;
}

export type RunBatchResult =
  | { ok: true; batch: ReviewBatch; usage: BatchUsage }
  | { ok: false; error: string };

export interface RunBatchesInput {
  batches: FileBatch[];
  runBatch: (batch: FileBatch) => RunBatchResult | Promise<RunBatchResult>;
  maxConcurrent?: number;
  budget?: Budget | undefined;
}

export type BatchRunEntry =
  | { status: "ok"; id: string; batch: ReviewBatch; usage: BatchUsage }
  | { status: "failed"; id: string; error: string }
  | { status: "not_run"; id: string; reason: string };

export interface RunBatchesResult {
  results: BatchRunEntry[];
  partial: boolean;
}

export interface MergedBatches {
  summaries: string[];
  findings: Finding[];
  generalNotes: string[];
  failedBatches: string[];
  notRunBatches: string[];
  partial: boolean;
}

function parentDir(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "." : path.slice(0, slash);
}

function cleanTokens(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

export function planBatches<TFile = PullFileEntry>(
  input: PlanBatchesInput<TFile>,
): PlanBatchesResult<TFile> {
  const singlePassTokens = input.singlePassTokens ?? DEFAULT_SINGLE_PASS_TOKENS;
  const batchTokens = input.batchTokens ?? DEFAULT_BATCH_TOKENS;
  const estimates = input.files.map((file) => cleanTokens(input.estimateFileTokens(file)));
  const total = estimates.reduce((sum, tokens) => sum + tokens, 0);
  if (total <= singlePassTokens) return { mode: "single", batches: [input.files] };

  const groups = new Map<string, Array<{ file: TFile; tokens: number }>>();
  for (let i = 0; i < input.files.length; i += 1) {
    const file = input.files[i] as TFile;
    const path =
      typeof (file as { filename?: unknown }).filename === "string"
        ? ((file as { filename: string }).filename as string)
        : String(i);
    const dir = parentDir(path);
    const list = groups.get(dir);
    const entry = { file, tokens: estimates[i] as number };
    if (list === undefined) groups.set(dir, [entry]);
    else list.push(entry);
  }

  const batches: FileBatch[] = [];
  let counter = 0;
  const nextId = (): string => {
    counter += 1;
    return `batch-${counter}`;
  };
  for (const [dir, entries] of groups) {
    let current: Array<{ file: TFile; tokens: number }> = [];
    let currentTokens = 0;
    const flush = (): void => {
      if (current.length === 0) return;
      batches.push({
        id: nextId(),
        dir,
        files: current.map((entry) => entry.file as unknown as PullFileEntry),
        tokens: currentTokens,
      });
      current = [];
      currentTokens = 0;
    };
    for (const entry of entries) {
      if (entry.tokens > batchTokens) {
        flush();
        batches.push({
          id: nextId(),
          dir,
          files: [entry.file as unknown as PullFileEntry],
          tokens: entry.tokens,
          oversized: true,
        });
        continue;
      }
      if (current.length > 0 && currentTokens + entry.tokens > batchTokens) flush();
      current.push(entry);
      currentTokens += entry.tokens;
    }
    flush();
  }
  return { mode: "batched", batches };
}

export async function runBatches(input: RunBatchesInput): Promise<RunBatchesResult> {
  const maxConcurrent = Math.max(1, Math.floor(input.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
  const budget = input.budget;
  const results: Array<BatchRunEntry | undefined> = Array.from({
    length: input.batches.length,
  });
  let next = 0;
  let stopped = false;
  let stopReason = "";

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      const index = next;
      next += 1;
      if (index >= input.batches.length) return;
      const batch = input.batches[index] as FileBatch;
      if (budget !== undefined) {
        const gate = budget.canStartBatch();
        if (!gate.ok) {
          stopped = true;
          stopReason = gate.reason;
          results[index] = { status: "not_run", id: batch.id, reason: gate.reason };
          return;
        }
      }
      let outcome: RunBatchResult;
      try {
        outcome = await input.runBatch(batch);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results[index] = { status: "failed", id: batch.id, error: message };
        continue;
      }
      if (!outcome.ok) {
        results[index] = { status: "failed", id: batch.id, error: outcome.error };
        continue;
      }
      if (budget !== undefined) {
        budget.recordUsage({
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          ...(outcome.usage.totalTokens !== undefined
            ? { totalTokens: outcome.usage.totalTokens }
            : {}),
          ...(outcome.usage.model !== undefined ? { model: outcome.usage.model } : {}),
        });
      }
      results[index] = {
        status: "ok",
        id: batch.id,
        batch: outcome.batch,
        usage: outcome.usage,
      };
    }
  };

  const workers: Promise<void>[] = [];
  const count = Math.min(maxConcurrent, input.batches.length);
  for (let i = 0; i < count; i += 1) workers.push(worker());
  await Promise.all(workers);

  for (let i = 0; i < results.length; i += 1) {
    if (results[i] === undefined) {
      const batch = input.batches[i] as FileBatch;
      results[i] = { status: "not_run", id: batch.id, reason: stopReason };
    }
  }
  const partial = results.some((entry) => entry === undefined || entry.status !== "ok");
  return { results: results as BatchRunEntry[], partial };
}

const SEVERITY_RANK: Record<Finding["severity"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function dedupeKey(finding: Finding): string {
  return `${finding.path}\n${finding.line}\n${finding.title.trim().toLowerCase()}\n${finding.category}`;
}

function better(existing: Finding, candidate: Finding): Finding {
  const severityDelta = SEVERITY_RANK[candidate.severity] - SEVERITY_RANK[existing.severity];
  if (severityDelta !== 0) return severityDelta > 0 ? candidate : existing;
  if (candidate.confidence !== existing.confidence) {
    return candidate.confidence > existing.confidence ? candidate : existing;
  }
  return existing;
}

export function mergeBatchResults(results: BatchRunEntry[]): MergedBatches {
  const summaries: string[] = [];
  const generalNotes: string[] = [];
  const failedBatches: string[] = [];
  const notRunBatches: string[] = [];
  const byKey = new Map<string, Finding>();

  for (const entry of results) {
    if (entry.status === "failed") {
      failedBatches.push(entry.id);
    } else if (entry.status === "not_run") {
      notRunBatches.push(entry.id);
    } else {
      summaries.push(entry.batch.summary);
      generalNotes.push(...entry.batch.generalNotes);
      for (const finding of entry.batch.findings) {
        const key = dedupeKey(finding);
        const existing = byKey.get(key);
        byKey.set(key, existing === undefined ? finding : better(existing, finding));
      }
    }
  }

  const partial = failedBatches.length > 0 || notRunBatches.length > 0;
  return {
    summaries,
    findings: [...byKey.values()],
    generalNotes,
    failedBatches,
    notRunBatches,
    partial,
  };
}
