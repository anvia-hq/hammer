import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialProgress } from "@anvia/hammer-core";
import { createProgressReporter } from "../src/progress";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function reporter(write = vi.fn(async (_body: string) => {})) {
  const warn = vi.fn();
  return {
    write,
    warn,
    reporter: createProgressReporter({
      state: initialProgress({ files: 1, verify: false }),
      write,
      warn,
      intervalMs: 1000,
    }),
  };
}

describe("progress reporter", () => {
  it("posts at start and coalesces rapid events into one update", async () => {
    const { reporter: r, write } = reporter();
    await r.start();
    r.onEvent({ type: "plan", files: 1, batches: 1 });
    r.onEvent({ type: "batch_start", batch: "single", files: 1 });
    r.onEvent({ type: "batch_end", batch: "single", ok: true, findings: 0 });
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![0]).toContain("- [x] Review 1 file (0 findings)");
    await r.settle();
  });

  it("stops writing after settle so it cannot overwrite the final summary", async () => {
    const { reporter: r, write } = reporter();
    await r.start();
    r.onEvent({ type: "plan", files: 1, batches: 1 });
    await r.settle();
    await vi.advanceTimersByTimeAsync(5000);
    r.onEvent({ type: "done", inline: 0, notes: 0 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("warns once and stops when an update fails", async () => {
    const write = vi.fn(async () => {
      throw new Error("403");
    });
    const { reporter: r, warn } = reporter(write);
    await r.start();
    r.onEvent({ type: "plan", files: 1, batches: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    await r.settle();
  });
});
