import { describe, expect, it } from "vitest";
import type { PullFileEntry } from "@anvia/hammer-core";
import { shardFiles } from "../src/shard";

function file(name: string, lines: number): PullFileEntry {
  const patch = [
    `@@ -1,1 +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, i) => `+const value${i} = ${i};`),
  ].join("\n");
  return {
    filename: name,
    sha: "x",
    status: "modified",
    additions: lines,
    deletions: 0,
    changes: lines,
    patch,
  };
}

describe("shardFiles", () => {
  it("returns one shard when the diff is under the threshold", () => {
    const files = [file("a.ts", 5), file("b.ts", 5)];
    expect(shardFiles(files, {}, 100_000, 5).shards).toEqual([files]);
  });

  it("returns one shard when sharding is off", () => {
    const files = [file("a.ts", 500), file("b.ts", 500)];
    expect(shardFiles(files, {}, 100, 1).shards).toHaveLength(1);
  });

  it("splits by directory order into balanced shards, never losing a file", () => {
    const files = [
      ...Array.from({ length: 6 }, (_, i) => file(`src/a/f${i}.ts`, 100)),
      ...Array.from({ length: 6 }, (_, i) => file(`src/b/f${i}.ts`, 100)),
    ];
    const plan = shardFiles(files, {}, 2000, 5);
    expect(plan.shards.length).toBeGreaterThan(1);
    expect(plan.shards.length).toBeLessThanOrEqual(5);
    expect(
      plan.shards
        .flat()
        .map((f) => f.filename)
        .sort(),
    ).toEqual(files.map((f) => f.filename).sort());
    expect(plan.shards[0]?.every((f) => f.filename.startsWith("src/a/"))).toBe(true);
  });

  it("caps the shard count and gives an oversized file its own shard", () => {
    const files = [
      file("a.ts", 3000),
      ...Array.from({ length: 20 }, (_, i) => file(`z${i}.ts`, 20)),
    ];
    const plan = shardFiles(files, {}, 1000, 3);
    expect(plan.shards.length).toBeLessThanOrEqual(3);
    expect(plan.shards.flat()).toHaveLength(21);
  });
});
