import { describe, expect, it } from "vitest";

import { decideSkip, type SkipInput } from "../src/skip";

function baseInput(overrides: Partial<SkipInput> = {}): SkipInput {
  return {
    labels: [],
    title: "Add retry with backoff",
    authorLogin: "octocat",
    sender: { login: "octocat", type: "User" },
    isMergeFromBase: false,
    remainingFileCount: 3,
    ...overrides,
  };
}

describe("decideSkip", () => {
  it("skips PRs with the hammer:skip label", () => {
    const result = decideSkip(baseInput({ labels: ["hammer:skip"] }));
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/hammer:skip/);
  });

  it("skips PRs whose title contains [skip review]", () => {
    const result = decideSkip(baseInput({ title: "Bump deps [skip review]" }));
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/\[skip review\]/);
  });

  it("only matches the exact case-sensitive title marker", () => {
    const result = decideSkip(baseInput({ title: "Bump deps [Skip Review]" }));
    expect(result).toEqual({ skip: false });
  });

  it("skips authors in the default ignore_authors list", () => {
    for (const authorLogin of ["dependabot[bot]", "renovate[bot]"]) {
      const result = decideSkip(baseInput({ authorLogin }));
      expect(result.skip).toBe(true);
      expect(result.reason).toMatch(authorLogin);
    }
  });

  it("honours a custom ignore_authors list", () => {
    const skipped = decideSkip(
      baseInput({ authorLogin: "bot-account", ignoreAuthors: ["bot-account"] }),
    );
    expect(skipped.skip).toBe(true);

    const notSkipped = decideSkip(
      baseInput({ authorLogin: "dependabot[bot]", ignoreAuthors: ["bot-account"] }),
    );
    expect(notSkipped).toEqual({ skip: false });
  });

  it("skips bot senders by type or login suffix", () => {
    for (const sender of [
      { login: "github-actions[bot]", type: "Bot" },
      { login: "some-bot[bot]", type: "User" },
      { login: "some-bot[bot]" },
    ]) {
      const result = decideSkip(baseInput({ sender }));
      expect(result.skip).toBe(true);
      expect(result.reason).toMatch(sender.login);
    }
  });

  it("reviews bot senders when reviewBotPushes is on", () => {
    const sender = { login: "github-actions[bot]", type: "Bot" };
    expect(decideSkip(baseInput({ sender, reviewBotPushes: true }))).toEqual({ skip: false });
    expect(
      decideSkip(baseInput({ sender, reviewBotPushes: true, authorLogin: "dependabot[bot]" })).skip,
    ).toBe(true);
  });

  it("skips merge commits from the base branch", () => {
    const result = decideSkip(baseInput({ isMergeFromBase: true }));
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/merge/i);
  });

  it("skips when nothing remains after filtering", () => {
    const result = decideSkip(baseInput({ remainingFileCount: 0 }));
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/no files remain/i);
  });

  it("does not skip a normal PR", () => {
    expect(decideSkip(baseInput())).toEqual({ skip: false });
  });

  it("returns the first matching reason in a stable order", () => {
    const allMatch = decideSkip(
      baseInput({
        labels: ["hammer:skip"],
        title: "Bump deps [skip review]",
        authorLogin: "dependabot[bot]",
        sender: { login: "github-actions[bot]", type: "Bot" },
        isMergeFromBase: true,
        remainingFileCount: 0,
      }),
    );
    expect(allMatch.skip).toBe(true);
    expect(allMatch.reason).toMatch(/hammer:skip/);

    const emptyFilesLast = decideSkip(
      baseInput({
        title: "Bump deps [skip review]",
        remainingFileCount: 0,
      }),
    );
    expect(emptyFilesLast.skip).toBe(true);
    expect(emptyFilesLast.reason).toMatch(/\[skip review\]/);
  });
});
