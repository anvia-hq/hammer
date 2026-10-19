import { beforeEach, describe, expect, it, vi } from "vitest";

describe("action entries", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("exposes a main function", async () => {
    const entry = await import("../src/index");

    expect(entry.main).toBeTypeOf("function");
  });

  it("exposes a post function", async () => {
    const entry = await import("../src/post");

    expect(entry.post).toBeTypeOf("function");
  });
});
