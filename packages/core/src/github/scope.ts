export type IncrementalScopeReason =
  | "no_last_sha"
  | "same_sha"
  | "not_ancestor"
  | "normal_push"
  | "compare_failed";

export type IncrementalScopeDecision =
  | { mode: "full"; reason: "no_last_sha" | "not_ancestor" | "compare_failed" }
  | { mode: "none"; reason: "same_sha" }
  | { mode: "incremental"; files: string[]; reason: "normal_push" };

export interface DecideIncrementalScopeOptions {
  lastSha?: string | null | undefined;
  headSha: string;
  isAncestor: (base: string, head: string) => Promise<boolean>;
  compareFiles: (base: string, head: string) => Promise<string[]>;
}

export async function decideIncrementalScope(
  options: DecideIncrementalScopeOptions,
): Promise<IncrementalScopeDecision> {
  const lastSha = options.lastSha;
  if (lastSha === undefined || lastSha === null || lastSha === "") {
    return { mode: "full", reason: "no_last_sha" };
  }
  if (lastSha === options.headSha) {
    return { mode: "none", reason: "same_sha" };
  }
  try {
    if ((await options.isAncestor(lastSha, options.headSha)) === false) {
      return { mode: "full", reason: "not_ancestor" };
    }
    const files = await options.compareFiles(lastSha, options.headSha);
    return { mode: "incremental", files, reason: "normal_push" };
  } catch {
    return { mode: "full", reason: "compare_failed" };
  }
}
