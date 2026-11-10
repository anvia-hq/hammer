import { fingerprints, parseFingerprintMarker, type DedupeFinding } from "./dedupe";

export interface FixableThread {
  id: string;
  path: string;
  outdated: boolean;
  body: string;
}

export interface SelectThreadsOptions {
  threads: FixableThread[];
  reviewedPaths: ReadonlySet<string>;
  reported: DedupeFinding[];
  complete: boolean;
  judgedFixed?: ReadonlySet<string>;
}

export function selectThreadsToResolve(options: SelectThreadsOptions): string[] {
  if (!options.complete) return [];
  const reported = options.reported.map((finding) => ({
    fp: fingerprints(finding.path, finding.body, finding.suggestion),
    hasSuggestion: finding.suggestion !== undefined,
  }));
  return options.threads
    .filter((thread) => {
      const outdatedHere = thread.outdated && options.reviewedPaths.has(thread.path);
      if (!outdatedHere && options.judgedFixed?.has(thread.id) !== true) return false;
      const marker = parseFingerprintMarker(thread.body);
      if (marker === undefined) return false;
      return !reported.some(
        (entry) =>
          entry.fp.bodyFp === marker.bodyFp ||
          (entry.hasSuggestion && entry.fp.suggestionFp === marker.suggestionFp),
      );
    })
    .map((thread) => thread.id);
}
