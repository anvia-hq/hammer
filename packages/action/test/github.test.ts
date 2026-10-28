import { describe, expect, it, vi } from "vitest";
import { assertAllowedRequest, GitHub } from "../src/github";

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
    ] as const)
      expect(() => assertAllowedRequest(method, url, apiUrl, body)).toThrow();
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

describe("resolved review threads", () => {
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

  it("collects the comment ids of resolved threads only", async () => {
    const request = graphql([
      { isResolved: true, comments: { nodes: [{ databaseId: 1 }, { databaseId: 2 }] } },
      { isResolved: false, comments: { nodes: [{ databaseId: 3 }] } },
    ]);
    const ids = await new GitHub("test-token", apiUrl, request).resolvedReviewCommentIds(
      "o",
      "r",
      7,
    );
    expect([...ids]).toEqual([1, 2]);
    expect(request.mock.calls[0]?.[0]).toBe("https://enterprise.example/api/graphql");
  });

  it("allows a read-only GraphQL query and refuses a mutation", () => {
    expect(() =>
      assertAllowedRequest("POST", "https://enterprise.example/api/graphql", apiUrl, {
        query: "query { viewer { id } }",
      }),
    ).not.toThrow();
    expect(() =>
      assertAllowedRequest("POST", "https://enterprise.example/api/graphql", apiUrl, {
        query: 'mutation { resolveReviewThread(input: {threadId: "x"}) { thread { id } } }',
      }),
    ).toThrow();
    expect(() =>
      assertAllowedRequest("POST", "https://enterprise.example/api/graphql", apiUrl, {}),
    ).toThrow();
    expect(() =>
      assertAllowedRequest("POST", "https://attacker.example/api/graphql", apiUrl, {
        query: "query { viewer { id } }",
      }),
    ).toThrow();
  });
});
