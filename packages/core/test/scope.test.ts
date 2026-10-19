import { describe, expect, it } from "vitest";

import { decideIncrementalScope } from "../src/index";

function ancestor(value: boolean): (base: string, head: string) => Promise<boolean> {
  return async () => value;
}

function compare(files: string[]): (base: string, head: string) => Promise<string[]> {
  return async () => files;
}

function throwing(message: string): () => Promise<never> {
  return async () => {
    throw new Error(message);
  };
}

describe("decideIncrementalScope", () => {
  it("returns full when lastSha is missing", async () => {
    expect(
      await decideIncrementalScope({
        headSha: "bbb",
        isAncestor: ancestor(true),
        compareFiles: compare([]),
      }),
    ).toEqual({ mode: "full", reason: "no_last_sha" });
    expect(
      await decideIncrementalScope({
        lastSha: null,
        headSha: "bbb",
        isAncestor: ancestor(true),
        compareFiles: compare([]),
      }),
    ).toEqual({ mode: "full", reason: "no_last_sha" });
    expect(
      await decideIncrementalScope({
        lastSha: "",
        headSha: "bbb",
        isAncestor: ancestor(true),
        compareFiles: compare([]),
      }),
    ).toEqual({ mode: "full", reason: "no_last_sha" });
  });

  it("returns none when lastSha equals headSha", async () => {
    expect(
      await decideIncrementalScope({
        lastSha: "aaa",
        headSha: "aaa",
        isAncestor: ancestor(true),
        compareFiles: compare(["src/a.ts"]),
      }),
    ).toEqual({ mode: "none", reason: "same_sha" });
  });

  it("returns full when lastSha is not an ancestor", async () => {
    expect(
      await decideIncrementalScope({
        lastSha: "aaa",
        headSha: "bbb",
        isAncestor: ancestor(false),
        compareFiles: compare(["src/a.ts"]),
      }),
    ).toEqual({ mode: "full", reason: "not_ancestor" });
  });

  it("returns incremental files on a normal push", async () => {
    expect(
      await decideIncrementalScope({
        lastSha: "aaa",
        headSha: "bbb",
        isAncestor: ancestor(true),
        compareFiles: compare(["src/a.ts", "src/b.ts"]),
      }),
    ).toEqual({ mode: "incremental", files: ["src/a.ts", "src/b.ts"], reason: "normal_push" });
  });

  it("returns full when isAncestor throws", async () => {
    expect(
      await decideIncrementalScope({
        lastSha: "aaa",
        headSha: "bbb",
        isAncestor: throwing("boom"),
        compareFiles: compare(["src/a.ts"]),
      }),
    ).toEqual({ mode: "full", reason: "compare_failed" });
  });

  it("returns full when compareFiles throws", async () => {
    expect(
      await decideIncrementalScope({
        lastSha: "aaa",
        headSha: "bbb",
        isAncestor: ancestor(true),
        compareFiles: throwing("boom"),
      }),
    ).toEqual({ mode: "full", reason: "compare_failed" });
  });
});
