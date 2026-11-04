import { describe, expect, it } from "vitest";

import {
  fingerprints,
  formatFingerprintComment,
  parseFingerprintMarker,
  selectThreadsToResolve,
} from "../src/index";

const path = "src/a.ts";
const flagged = { path, body: "When user is null, this throws.", suggestion: "if (!user) return;" };

function thread(id: string, overrides: Partial<{ path: string; outdated: boolean; body: string }>) {
  const marker = formatFingerprintComment(
    fingerprints(flagged.path, flagged.body, flagged.suggestion),
  );
  return { id, path, outdated: true, body: `${flagged.body}\n${marker}`, ...overrides };
}

const base = {
  reviewedPaths: new Set([path]),
  reported: [],
  complete: true,
};

describe("selectThreadsToResolve", () => {
  it("resolves an outdated thread whose finding was not reported again", () => {
    expect(selectThreadsToResolve({ ...base, threads: [thread("t1", {})] })).toEqual(["t1"]);
  });

  it("leaves a thread whose flagged lines did not change", () => {
    expect(
      selectThreadsToResolve({ ...base, threads: [thread("t1", { outdated: false })] }),
    ).toEqual([]);
  });

  it("leaves a thread whose finding the reviewer restated", () => {
    expect(
      selectThreadsToResolve({
        ...base,
        threads: [thread("t1", {})],
        reported: [{ path, body: "  WHEN user is null,   this throws. " }],
      }),
    ).toEqual([]);
  });

  it("leaves a thread whose suggestion the reviewer proposed again", () => {
    expect(
      selectThreadsToResolve({
        ...base,
        threads: [thread("t1", {})],
        reported: [{ path, body: "Reworded.", suggestion: "if (!user) return;" }],
      }),
    ).toEqual([]);
  });

  it("does not match a suggestion-less finding on the same path", () => {
    const noSuggestion = thread("t1", {
      body: formatFingerprintComment(fingerprints(path, "Other body")),
    });
    expect(
      selectThreadsToResolve({
        ...base,
        threads: [noSuggestion],
        reported: [{ path, body: "Unrelated finding" }],
      }),
    ).toEqual(["t1"]);
  });

  it("leaves a thread on a file that was not reviewed this run", () => {
    expect(
      selectThreadsToResolve({
        ...base,
        threads: [thread("t1", { path: "src/b.ts" })],
      }),
    ).toEqual([]);
  });

  it("resolves nothing when the run did not complete", () => {
    expect(
      selectThreadsToResolve({ ...base, complete: false, threads: [thread("t1", {})] }),
    ).toEqual([]);
  });

  it("ignores a thread without a Hammer fingerprint", () => {
    expect(
      selectThreadsToResolve({ ...base, threads: [thread("t1", { body: "A human reply" })] }),
    ).toEqual([]);
  });
});

describe("parseFingerprintMarker", () => {
  it("reads the first marker in a comment body", () => {
    const fp = fingerprints(path, "body", "fix");
    expect(parseFingerprintMarker(`text\n${formatFingerprintComment(fp)}`)).toEqual(fp);
    expect(parseFingerprintMarker("no marker")).toBeUndefined();
  });
});
