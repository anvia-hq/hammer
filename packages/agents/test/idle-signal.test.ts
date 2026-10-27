import { afterEach, describe, expect, it, vi } from "vitest";

import { createIdleSignal } from "../src/idle-signal";

afterEach(() => vi.useRealTimers());

describe("createIdleSignal", () => {
  it("aborts only after the stream has been quiet for the whole interval", () => {
    vi.useFakeTimers();
    const idle = createIdleSignal(1000);
    vi.advanceTimersByTime(900);
    idle.touch();
    vi.advanceTimersByTime(900);
    expect(idle.signal.aborted).toBe(false);
    vi.advanceTimersByTime(200);
    expect(idle.signal.aborted).toBe(true);
    expect((idle.signal.reason as Error).name).toBe("TimeoutError");
  });

  it("follows the parent signal and stops its timer on clear", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const idle = createIdleSignal(1000, parent.signal);
    parent.abort();
    expect(idle.signal.aborted).toBe(true);
    const other = createIdleSignal(1000);
    other.clear();
    vi.advanceTimersByTime(5000);
    expect(other.signal.aborted).toBe(false);
  });
});
