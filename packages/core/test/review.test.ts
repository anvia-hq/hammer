import { describe, expect, it } from "vitest";

import {
  assertCommentEvent,
  GENERIC_RETRY_SLEEPS_MS,
  postPullReview,
  type CreateReviewPayload,
} from "../src/index";

function apiError(status: number, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { status }, extra);
}

describe("postPullReview", () => {
  it("always posts with event COMMENT and passes commit_id through", async () => {
    const seen: CreateReviewPayload[] = [];
    const result = await postPullReview(
      {
        owner: "octo",
        repo: "hello",
        pullNumber: 7,
        commitId: "abc123",
        inline: [{ path: "src/app.ts", line: 4, body: "fix this" }],
        body: "summary",
      },
      {
        createReview: async (payload) => {
          seen.push(payload);
        },
      },
    );
    expect(result).toEqual({ ok: true, attempts: 1, movedToSummary: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.event).toBe("COMMENT");
    expect(seen[0]!.commit_id).toBe("abc123");
    expect(seen[0]!.pull_number).toBe(7);
  });

  it("rejects APPROVE and REQUEST_CHANGES events", async () => {
    let calls = 0;
    for (const event of ["APPROVE", "REQUEST_CHANGES"]) {
      const result = await postPullReview(
        {
          owner: "octo",
          repo: "hello",
          pullNumber: 7,
          commitId: "abc123",
          inline: [],
          body: "summary",
          event,
        },
        {
          createReview: async () => {
            calls += 1;
          },
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("invalid_event");
    }
    expect(calls).toBe(0);
    expect(() => assertCommentEvent("APPROVE")).toThrow();
    expect(() => assertCommentEvent("REQUEST_CHANGES")).toThrow();
  });

  it("sends RIGHT side and range fields when a range is used", async () => {
    const seen: CreateReviewPayload[] = [];
    await postPullReview(
      {
        owner: "octo",
        repo: "hello",
        pullNumber: 7,
        commitId: "abc123",
        inline: [
          { path: "src/app.ts", line: 8, start_line: 5, body: "range note" },
          { path: "src/one.ts", line: 3, body: "single note" },
        ],
        body: "summary",
      },
      {
        createReview: async (payload) => {
          seen.push(payload);
        },
      },
    );
    expect(seen[0]!.comments[0]).toMatchObject({
      path: "src/app.ts",
      line: 8,
      side: "RIGHT",
      start_line: 5,
      start_side: "RIGHT",
    });
    expect(seen[0]!.comments[1]).toMatchObject({
      path: "src/one.ts",
      line: 3,
      side: "RIGHT",
    });
    expect(seen[0]!.comments[1]).not.toHaveProperty("start_line");
  });

  it("retries generic 422s twice with 1s then 3s sleeps", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await postPullReview(
      {
        owner: "octo",
        repo: "hello",
        pullNumber: 7,
        commitId: "abc123",
        inline: [{ path: "src/app.ts", line: 4, body: "note" }],
        body: "summary",
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        createReview: async () => {
          calls += 1;
          if (calls < 3) throw apiError(422, "Unprocessable Entity");
        },
      },
    );
    expect(result).toEqual({ ok: true, attempts: 3, movedToSummary: [] });
    expect(sleeps).toEqual([1000, 3000]);
    expect(GENERIC_RETRY_SLEEPS_MS).toEqual([1000, 3000]);
  });

  it("retries generic internal-error 422s and reports failure after retries", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await postPullReview(
      {
        owner: "octo",
        repo: "hello",
        pullNumber: 7,
        commitId: "abc123",
        inline: [],
        body: "summary",
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        createReview: async () => {
          calls += 1;
          throw apiError(422, "internal error");
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 3000]);
  });

  it("moves a bad-anchor 422 comment to general notes and retries once", async () => {
    const seen: CreateReviewPayload[] = [];
    let calls = 0;
    const result = await postPullReview(
      {
        owner: "octo",
        repo: "hello",
        pullNumber: 7,
        commitId: "abc123",
        inline: [
          { path: "src/good.ts", line: 2, body: "good note" },
          { path: "src/bad.ts", line: 99, body: "bad anchor note" },
        ],
        body: "summary",
      },
      {
        createReview: async (payload) => {
          calls += 1;
          seen.push(payload);
          if (calls === 1) {
            throw apiError(422, "Validation failed: line 99 in src/bad.ts is not in the diff", {
              errors: [{ field: "line", code: "custom" }],
            });
          }
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.movedToSummary).toHaveLength(1);
      expect(result.movedToSummary[0]!.path).toBe("src/bad.ts");
    }
    expect(calls).toBe(2);
    expect(seen[1]!.comments.map((comment) => comment.path)).toEqual(["src/good.ts"]);
  });

  it("succeeds after one generic retry", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await postPullReview(
      {
        owner: "octo",
        repo: "hello",
        pullNumber: 7,
        commitId: "abc123",
        inline: [{ path: "src/app.ts", line: 4, body: "note" }],
        body: "summary",
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        createReview: async () => {
          calls += 1;
          if (calls === 1) throw apiError(422, "Unprocessable Entity");
        },
      },
    );
    expect(result).toEqual({ ok: true, attempts: 2, movedToSummary: [] });
    expect(sleeps).toEqual([1000]);
  });

  it("sanitises inline bodies and the summary before posting", async () => {
    const seen: CreateReviewPayload[] = [];
    await postPullReview(
      {
        owner: "octo",
        repo: "hello",
        pullNumber: 7,
        commitId: "abc123",
        inline: [{ path: "src/app.ts", line: 4, body: "hey @sam key sk-abcdefghijklmnopqr key" }],
        body: "ping @sam <b>hi</b>",
      },
      {
        createReview: async (payload) => {
          seen.push(payload);
        },
      },
    );
    expect(seen[0]!.comments[0]!.body).not.toContain("sk-abcdefghijklmnopqr");
    expect(seen[0]!.comments[0]!.body).not.toContain("@sam");
    expect(seen[0]!.body).not.toContain("<b>");
  });
});
