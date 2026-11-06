import type { PullFileEntry } from "@anvia/hammer-core";
import { approxTokens, renderPromptFile } from "./prompt";

export interface ShardPlan {
  shards: PullFileEntry[][];
  tokens: number;
}

export function shardFiles(
  files: PullFileEntry[],
  contents: Record<string, string>,
  shardTokens: number,
  maxShards: number,
): ShardPlan {
  const costs = new Map(
    files.map((file) => [file.filename, approxTokens(renderPromptFile(file, contents)) + 2]),
  );
  const tokens = [...costs.values()].reduce((sum, value) => sum + value, 0);
  if (maxShards <= 1 || tokens <= shardTokens) return { shards: [files], tokens };
  const count = Math.min(maxShards, Math.ceil(tokens / shardTokens));
  const target = Math.ceil(tokens / count);
  const ordered = [...files].sort((a, b) => a.filename.localeCompare(b.filename));
  const shards: PullFileEntry[][] = [];
  let current: PullFileEntry[] = [];
  let used = 0;
  for (const file of ordered) {
    const cost = costs.get(file.filename) ?? 0;
    if (current.length > 0 && used + cost > target && shards.length < count - 1) {
      shards.push(current);
      current = [];
      used = 0;
    }
    current.push(file);
    used += cost;
  }
  if (current.length > 0) shards.push(current);
  return { shards, tokens };
}
