import { describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({ runAction: vi.fn(async () => {}) }));
vi.mock("../src/runtime", () => ({ runtime: {} }));

describe("action entries", () => {
  it("starts the main run", async () => {
    const { runAction } = await import("../src/run");
    await import("../src/index");
    expect(runAction).toHaveBeenCalledOnce();
  });
  it("exposes post cleanup", async () => {
    expect((await import("../src/post")).post).toBeTypeOf("function");
  });
});
