import { describe, expect, it, vi } from "vitest";

import {
  createBudget,
  mergeBatchResults,
  planBatches,
  runBatches,
  type BatchRunEntry,
  type FileBatch,
  type Finding,
  type PullFileEntry,
  type ReviewBatch,
} from "../src/index";

function file(filename: string, tokens = 1000): { entry: PullFileEntry; tokens: number } {
  const entry: PullFileEntry = {
    sha: "abc",
    filename,
    status: "modified",
    additions: 10,
    deletions: 2,
    changes: 12,
    patch: `diff ${filename}`,
  };
  return { entry, tokens };
}

function tokenMap(pairs: Array<{ entry: PullFileEntry; tokens: number }>): Map<string, number> {
  const map = new Map<string, number>();
  for (const pair of pairs) map.set(pair.entry.filename, pair.tokens);
  return map;
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    path: "src/app.ts",
    line: 12,
    severity: "medium",
    category: "correctness",
    title: "Null check missing",
    body: "Dereferences a possibly null value; guard before use.",
    confidence: 0.9,
    ...overrides,
  };
}

function reviewBatch(overrides: Partial<ReviewBatch> = {}): ReviewBatch {
  return {
    summary: "Does something.",
    findings: [],
    generalNotes: [],
    ...overrides,
  };
}

function fileBatch(id: string, dir = "src"): FileBatch {
  return {
    id,
    dir,
    files: [file(`${dir}/a.ts`).entry],
    tokens: 1000,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((inner) => {
    resolve = inner;
  });
  return { promise, resolve };
}

describe("planBatches", () => {
  it("uses single mode when the total estimate fits", () => {
    const files = [file("src/a.ts"), file("src/b.ts")].map((pair) => pair.entry);
    const plan = planBatches({
      files,
      estimateFileTokens: () => 1000,
    });
    expect(plan.mode).toBe("single");
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]).toHaveLength(2);
  });

  it("groups by directory and respects batchTokens", () => {
    const pairs = [file("src/a.ts"), file("src/b.ts"), file("src/c.ts"), file("db/migrate.sql")];
    const tokens = tokenMap(pairs);
    const plan = planBatches({
      files: pairs.map((pair) => pair.entry),
      singlePassTokens: 1000,
      batchTokens: 2000,
      estimateFileTokens: (entry) => tokens.get(entry.filename) ?? 0,
    });
    expect(plan.mode).toBe("batched");
    if (plan.mode !== "batched") return;
    expect(plan.batches).toHaveLength(3);
    const [first, second, third] = plan.batches;
    expect(first?.dir).toBe("src");
    expect(first?.files.map((entry) => entry.filename)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(second?.files.map((entry) => entry.filename)).toEqual(["src/c.ts"]);
    expect(third?.dir).toBe("db");
    for (const batch of plan.batches) {
      if (batch.dir === "src" || batch.dir === "db") {
        expect(batch.tokens).toBeLessThanOrEqual(2000);
      }
    }
    const ids = new Set(plan.batches.map((batch) => batch.id));
    expect(ids.size).toBe(plan.batches.length);
  });

  it("marks a single oversized file as its own oversized batch", () => {
    const pairs = [file("src/huge.ts"), file("src/small.ts")];
    const tokens = tokenMap(pairs);
    tokens.set("src/huge.ts", 90000);
    tokens.set("src/small.ts", 1000);
    const plan = planBatches({
      files: pairs.map((pair) => pair.entry),
      singlePassTokens: 1000,
      batchTokens: 40000,
      estimateFileTokens: (entry) => tokens.get(entry.filename) ?? 0,
    });
    expect(plan.mode).toBe("batched");
    if (plan.mode !== "batched") return;
    const huge = plan.batches.find((batch) =>
      batch.files.some((entry) => entry.filename === "src/huge.ts"),
    );
    expect(huge?.files).toHaveLength(1);
    expect(huge?.oversized).toBe(true);
    expect(huge?.tokens).toBe(90000);
  });

  it("groups root files as '.'", () => {
    const pairs = [file("README.md"), file("src/app.ts")];
    const plan = planBatches({
      files: pairs.map((pair) => pair.entry),
      singlePassTokens: 10,
      batchTokens: 40000,
      estimateFileTokens: () => 1000,
    });
    expect(plan.mode).toBe("batched");
    if (plan.mode !== "batched") return;
    const root = plan.batches.find((batch) => batch.dir === ".");
    expect(root?.files.map((entry) => entry.filename)).toEqual(["README.md"]);
  });
});

describe("runBatches", () => {
  it("never exceeds maxConcurrent", async () => {
    const batches = [fileBatch("batch-1"), fileBatch("batch-2"), fileBatch("batch-3")];
    let inFlight = 0;
    let maxInFlight = 0;
    const gates = batches.map(() => deferred<void>());
    const runBatch = vi.fn(async (batch: FileBatch) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const gate = gates.find((_, index) => batches[index]?.id === batch.id);
      await gate?.promise;
      inFlight -= 1;
      return {
        ok: true as const,
        batch: reviewBatch({ summary: batch.id }),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const pending = runBatches({ batches, runBatch, maxConcurrent: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(maxInFlight).toBeLessThanOrEqual(2);
    for (const gate of gates) gate.resolve();
    const result = await pending;
    expect(result.partial).toBe(false);
    expect(maxInFlight).toBe(2);
    expect(runBatch).toHaveBeenCalledTimes(3);
  });

  it("stops scheduling when the budget cap is hit and marks the rest not_run", async () => {
    const batches = [fileBatch("batch-1"), fileBatch("batch-2"), fileBatch("batch-3")];
    const budget = createBudget({ maxTokens: 15 });
    const runBatch = vi.fn(async (batch: FileBatch) => ({
      ok: true as const,
      batch: reviewBatch({ summary: batch.id }),
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const result = await runBatches({ batches, runBatch, maxConcurrent: 1, budget });
    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(result.partial).toBe(true);
    expect(result.results[0]?.status).toBe("ok");
    const rest = result.results.slice(1);
    for (const entry of rest) {
      expect(entry.status).toBe("not_run");
      if (entry.status === "not_run") {
        expect(entry.reason).toBe("max_tokens");
      }
    }
  });

  it("keeps going after a failed batch and stays partial", async () => {
    const batches = [fileBatch("batch-1"), fileBatch("batch-2")];
    const runBatch = vi.fn(async (batch: FileBatch) =>
      batch.id === "batch-1"
        ? { ok: false as const, error: "boom" }
        : {
            ok: true as const,
            batch: reviewBatch({ summary: "second" }),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
    );
    const result = await runBatches({ batches, runBatch, maxConcurrent: 2 });
    expect(runBatch).toHaveBeenCalledTimes(2);
    expect(result.partial).toBe(true);
    expect(result.results[0]).toMatchObject({ status: "failed", id: "batch-1" });
    expect(result.results[1]).toMatchObject({ status: "ok", id: "batch-2" });
  });

  it("returns results in the original batch order", async () => {
    const batches = [fileBatch("batch-1"), fileBatch("batch-2"), fileBatch("batch-3")];
    const delays = new Map([
      ["batch-1", 30],
      ["batch-2", 1],
      ["batch-3", 10],
    ]);
    const runBatch = async (batch: FileBatch) => {
      await new Promise((resolve) => setTimeout(resolve, delays.get(batch.id) ?? 1));
      return {
        ok: true as const,
        batch: reviewBatch({ summary: batch.id }),
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const result = await runBatches({ batches, runBatch, maxConcurrent: 3 });
    expect(result.results.map((entry) => entry.id)).toEqual(["batch-1", "batch-2", "batch-3"]);
    const ok = result.results.filter((entry) => entry.status === "ok");
    expect(ok.map((entry) => (entry.status === "ok" ? entry.batch.summary : ""))).toEqual([
      "batch-1",
      "batch-2",
      "batch-3",
    ]);
  });
});

describe("mergeBatchResults", () => {
  it("removes duplicates and keeps the higher-severity finding", () => {
    const results: BatchRunEntry[] = [
      {
        status: "ok",
        id: "batch-1",
        batch: reviewBatch({
          summary: "First.",
          findings: [finding({ severity: "medium", confidence: 0.7 })],
          generalNotes: ["note one"],
        }),
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        status: "ok",
        id: "batch-2",
        batch: reviewBatch({
          summary: "Second.",
          findings: [finding({ severity: "high", confidence: 0.6 })],
          generalNotes: ["note two"],
        }),
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ];
    const merged = mergeBatchResults(results);
    expect(merged.findings).toHaveLength(1);
    expect(merged.findings[0]?.severity).toBe("high");
    expect(merged.summaries).toEqual(["First.", "Second."]);
    expect(merged.generalNotes).toEqual(["note one", "note two"]);
    expect(merged.partial).toBe(false);
  });

  it("marks partial when a batch fails", () => {
    const merged = mergeBatchResults([
      {
        status: "ok",
        id: "batch-1",
        batch: reviewBatch({ summary: "First." }),
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      { status: "failed", id: "batch-2", error: "boom" },
      { status: "not_run", id: "batch-3", reason: "max_tokens" },
    ]);
    expect(merged.partial).toBe(true);
    expect(merged.failedBatches).toEqual(["batch-2"]);
    expect(merged.notRunBatches).toEqual(["batch-3"]);
    expect(merged.summaries).toEqual(["First."]);
  });

  it("completes a 200-file fixture under caps", async () => {
    const pairs: Array<{ entry: PullFileEntry; tokens: number }> = [];
    for (let i = 0; i < 200; i += 1) {
      const dir = `pkg/dir-${String(i % 20).padStart(2, "0")}`;
      pairs.push(file(`${dir}/file-${i}.ts`, 1000));
    }
    const tokens = tokenMap(pairs);
    const plan = planBatches({
      files: pairs.map((pair) => pair.entry),
      estimateFileTokens: (entry) => tokens.get(entry.filename) ?? 0,
    });
    expect(plan.mode).toBe("batched");
    if (plan.mode !== "batched") return;
    for (const batch of plan.batches) {
      if (!batch.oversized) {
        expect(batch.tokens).toBeLessThanOrEqual(40000);
      }
    }
    const budget = createBudget({});
    const runBatch = async (batch: FileBatch) => ({
      ok: true as const,
      batch: reviewBatch({
        summary: `Reviewed ${batch.files.length} files in ${batch.dir}.`,
        findings: batch.files.slice(0, 1).map((entry) =>
          finding({
            path: entry.filename,
            line: 5,
            title: `Issue in ${entry.filename}`,
          }),
        ),
      }),
      usage: { inputTokens: batch.tokens, outputTokens: 200 },
    });
    const ran = await runBatches({ batches: plan.batches, runBatch, budget });
    expect(ran.partial).toBe(false);
    const merged = mergeBatchResults(ran.results);
    if (plan.mode !== "batched") return;
    expect(merged.summaries).toHaveLength(plan.batches.length);
    expect(merged.partial).toBe(false);
    expect(merged.findings.length).toBeGreaterThan(0);
  });
});
