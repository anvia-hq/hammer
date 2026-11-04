import { describe, expect, it, vi } from "vitest";
import {
  assertAllowedRequest,
  COMMENT_STATUS_CONTEXT,
  GitHub,
  RESOLVE_THREAD_MUTATION,
} from "../src/github";

const apiUrl = "https://enterprise.example/api/v3";
describe("GitHub API boundary", () => {
  it("allows the configured GHES API and denies other hosts and forbidden mutations", () => {
    expect(() =>
      assertAllowedRequest("GET", `${apiUrl}/repos/o/r/pulls/7`, apiUrl, {}),
    ).not.toThrow();
    for (const [method, url, body] of [
      ["GET", "https://attacker.example/repos/o/r/pulls/7", {}],
      ["PUT", `${apiUrl}/repos/o/r/pulls/7/merge`, {}],
      ["POST", `${apiUrl}/repos/o/r/issues/7/labels`, {}],
      ["POST", `${apiUrl}/repos/o/r/pulls/7/reviews`, { event: "APPROVE" }],
      ["POST", `${apiUrl}/repos/o/r/pulls/7/reviews`, { event: "REQUEST_CHANGES" }],
      ["POST", `${apiUrl}/repos/o/r/statuses/${"a".repeat(40)}`, { context: "ci/build" }],
      ["POST", `${apiUrl}/repos/o/r/statuses/main`, { context: COMMENT_STATUS_CONTEXT }],
      ["POST", `${apiUrl}/repos/o/r/check-runs`, { context: COMMENT_STATUS_CONTEXT }],
    ] as const)
      expect(() => assertAllowedRequest(method, url, apiUrl, body)).toThrow();
    expect(() =>
      assertAllowedRequest("POST", `${apiUrl}/repos/o/r/statuses/${"a".repeat(40)}`, apiUrl, {
        context: COMMENT_STATUS_CONTEXT,
      }),
    ).not.toThrow();
  });
  it("resolves Octokit's route templates before enforcing its allowlist", async () => {
    const request = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ permission: "write" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const github = new GitHub("test-token", apiUrl, request);
    expect(await github.permission("acme", "sandbox", "maintainer")).toBe("write");
    expect(request.mock.calls[0]?.[0]).toBe(
      `${apiUrl}/repos/acme/sandbox/collaborators/maintainer/permission`,
    );
  });
});

it("permits a COMMENT review through the real client and preserves its payload", async () => {
  const request = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify({ html_url: "https://enterprise.example/o/r/pull/7#review-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const github = new GitHub("test-token", apiUrl, request);
  await github.review({
    owner: "o",
    repo: "r",
    pull_number: 7,
    commit_id: "a".repeat(40),
    event: "COMMENT",
    body: "Review",
    comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "Fix it" }],
  });
  expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
    event: "COMMENT",
    comments: [{ side: "RIGHT" }],
  });
});

it("does not log handled 403 and 404 responses", async () => {
  const log = [vi.spyOn(console, "error"), vi.spyOn(console, "info"), vi.spyOn(console, "warn")];
  const request = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
  );
  const github = new GitHub("test-token", apiUrl, request);
  expect(await github.content("acme", "sandbox", "CLAUDE.md", "a".repeat(40))).toBeUndefined();
  for (const spy of log) expect(spy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("review threads", () => {
  const graphql = (nodes: unknown[]) =>
    vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

  it("lists each thread with its resolved and outdated state", async () => {
    const request = graphql([
      {
        id: "PRRT_1",
        isResolved: true,
        isOutdated: false,
        path: "a.ts",
        comments: { nodes: [{ databaseId: 1 }, { databaseId: 2 }] },
      },
      {
        id: "PRRT_2",
        isResolved: false,
        isOutdated: true,
        path: "b.ts",
        comments: { nodes: [{ databaseId: 3 }] },
      },
    ]);
    const threads = await new GitHub("test-token", apiUrl, request).reviewThreads("o", "r", 7);
    expect(threads).toEqual([
      { id: "PRRT_1", resolved: true, outdated: false, path: "a.ts", commentIds: [1, 2] },
      { id: "PRRT_2", resolved: false, outdated: true, path: "b.ts", commentIds: [3] },
    ]);
    expect(request.mock.calls[0]?.[0]).toBe("https://enterprise.example/api/graphql");
  });

  it("resolves a thread with the one allowed mutation", async () => {
    const request = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_2" } } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await new GitHub("test-token", apiUrl, request).resolveThread("PRRT_2");
    const sent = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(sent.query).toBe(RESOLVE_THREAD_MUTATION);
    expect(sent.variables).toEqual({ threadId: "PRRT_2" });
  });

  it("allows a read-only GraphQL query and only the resolve mutation", () => {
    const url = "https://enterprise.example/api/graphql";
    expect(() =>
      assertAllowedRequest("POST", url, apiUrl, { query: "query { viewer { id } }" }),
    ).not.toThrow();
    expect(() =>
      assertAllowedRequest("POST", url, apiUrl, {
        query: RESOLVE_THREAD_MUTATION,
        variables: { threadId: "PRRT_kwDOA" },
      }),
    ).not.toThrow();
    for (const body of [
      { query: 'mutation { resolveReviewThread(input: {threadId: "x"}) { thread { id } } }' },
      { query: RESOLVE_THREAD_MUTATION },
      { query: RESOLVE_THREAD_MUTATION, variables: { threadId: 'x") { id } }' } },
      { query: RESOLVE_THREAD_MUTATION, variables: { threadId: "PRRT_kwDOA", extra: "x" } },
      { query: "mutation { addPullRequestReview(input: {}) { clientMutationId } }" },
      {},
    ])
      expect(() => assertAllowedRequest("POST", url, apiUrl, body)).toThrow();
    expect(() =>
      assertAllowedRequest("POST", "https://attacker.example/api/graphql", apiUrl, {
        query: RESOLVE_THREAD_MUTATION,
        variables: { threadId: "PRRT_kwDOA" },
      }),
    ).toThrow();
  });
});
