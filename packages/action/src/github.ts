import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { fetch as proxyFetch } from "undici";
import { z } from "zod";
import {
  sanitizeForPosting,
  type CreateReviewPayload,
  type PullFileEntry,
} from "@anvia/hammer-core";

const Client = Octokit.plugin(retry, throttling);
const sha = z.string().regex(/^[0-9a-f]{40,64}$/i);
const user = z.object({ login: z.string(), type: z.string() });
const repository = z.object({ full_name: z.string(), clone_url: z.string().url() });
export const PullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  title: z.string(),
  body: z.string().nullable(),
  draft: z.boolean(),
  user,
  labels: z.array(z.object({ name: z.string() })),
  changed_files: z.number().int().nonnegative(),
  head: z.object({ sha, repo: repository.nullable() }),
  base: z.object({ sha, repo: repository }),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;
const fileSchema = z.object({
  sha: z.string(),
  filename: z.string(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number(),
  deletions: z.number(),
  changes: z.number(),
  patch: z.string().optional(),
  previous_filename: z.string().optional(),
});
const commentSchema = z.object({
  id: z.number(),
  body: z.string().nullable(),
  user: user.nullable(),
});
const reviewCommentSchema = commentSchema.extend({
  path: z.string(),
  line: z.number().nullable(),
  original_line: z.number().nullable(),
});
export type IssueComment = z.infer<typeof commentSchema>;
export type ReviewComment = z.infer<typeof reviewCommentSchema>;

export function assertAllowedRequest(
  method: string,
  url: string,
  apiUrl: string,
  body: unknown,
): void {
  const base = new URL(`${apiUrl.replace(/\/$/, "")}/`);
  const target = new URL(url, base);
  const graphqlUrl = `${apiUrl.replace(/\/$/, "").replace(/\/api\/v3$/, "/api")}/graphql`;
  if (
    method === "POST" &&
    target.href === new URL(graphqlUrl).href &&
    typeof body === "object" &&
    body !== null &&
    "query" in body &&
    typeof body.query === "string" &&
    /^\s*query\b/.test(body.query) &&
    !/\bmutation\b/i.test(body.query)
  )
    return;
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname))
    throw new Error("GitHub request escaped the configured API host.");
  const route = decodeURI(target.pathname.slice(base.pathname.length));
  if (
    method === "GET" &&
    (/^repos\/[^/]+\/[^/]+\/(pulls\/\d+(\/files|\/comments)?|issues\/\d+\/comments|contents\/.+|compare\/[^/]+|commits\/[^/]+|collaborators\/[^/]+\/permission|tarball\/[0-9a-f]+)$/.test(
      route,
    ) ||
      route === "user")
  )
    return;
  if (
    method === "POST" &&
    /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/.test(route) &&
    typeof body === "object" &&
    body !== null &&
    "event" in body &&
    body.event === "COMMENT"
  )
    return;
  if (
    method === "POST" &&
    /^repos\/[^/]+\/[^/]+\/(issues\/\d+\/comments|issues\/comments\/\d+\/reactions)$/.test(route)
  )
    return;
  if (method === "PATCH" && /^repos\/[^/]+\/[^/]+\/issues\/comments\/\d+$/.test(route)) return;
  throw new Error(`GitHub operation is outside Hammer's allowlist: ${method} ${route}`);
}

export const proxiedFetch = proxyFetch as unknown as typeof globalThis.fetch;

const MAX_THREAD_PAGES = 5;
const THREADS_QUERY = `query($owner: String!, $repo: String!, $pull_number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pull_number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 50) { nodes { databaseId } } }
      }
    }
  }
}`;
const threadsSchema = z.object({
  repository: z.object({
    pullRequest: z.object({
      reviewThreads: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(
          z.object({
            isResolved: z.boolean(),
            comments: z.object({ nodes: z.array(z.object({ databaseId: z.number() })) }),
          }),
        ),
      }),
    }),
  }),
});

export class GitHub {
  private readonly api;
  constructor(token: string, apiUrl: string, requestFetch: typeof globalThis.fetch = proxiedFetch) {
    this.api = new Client({
      auth: token,
      baseUrl: apiUrl,
      request: { fetch: requestFetch },
      log: { debug: () => {}, info: () => {}, warn: console.warn, error: () => {} },
      retry: { retries: 2 },
      throttle: {
        onRateLimit: (_delay, _options, _client, count) => count < 1,
        onSecondaryRateLimit: (_delay, _options, _client, count) => count < 1,
      },
    });
    this.api.hook.before("request", (options) => {
      const request = this.api.request.endpoint(options);
      assertAllowedRequest(request.method, request.url, apiUrl, options);
    });
  }
  async identity(): Promise<string> {
    try {
      return user.parse((await this.api.users.getAuthenticated()).data).login;
    } catch (error) {
      if (status(error) === 403) return "github-actions[bot]";
      throw error;
    }
  }
  async permission(owner: string, repo: string, username: string): Promise<string> {
    return z
      .object({ permission: z.string() })
      .parse((await this.api.repos.getCollaboratorPermissionLevel({ owner, repo, username })).data)
      .permission;
  }
  async pull(owner: string, repo: string, pull_number: number): Promise<PullRequest> {
    return PullRequestSchema.parse((await this.api.pulls.get({ owner, repo, pull_number })).data);
  }
  async files(
    owner: string,
    repo: string,
    pull_number: number,
    page: number,
    per_page: number,
  ): Promise<PullFileEntry[]> {
    return z
      .array(fileSchema)
      .parse((await this.api.pulls.listFiles({ owner, repo, pull_number, page, per_page })).data);
  }
  async compare(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<{ ancestor: boolean; files: PullFileEntry[] }> {
    const result = (await this.api.repos.compareCommits({ owner, repo, base, head })).data;
    return {
      ancestor: result.merge_base_commit.sha === base,
      files: z.array(fileSchema).parse(result.files ?? []),
    };
  }
  async content(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | undefined> {
    try {
      const result = z
        .object({
          type: z.literal("file"),
          encoding: z.literal("base64"),
          content: z.string(),
          size: z.number().max(1_000_000),
        })
        .parse((await this.api.repos.getContent({ owner, repo, path, ref })).data);
      return Buffer.from(result.content, "base64").toString("utf8");
    } catch (error) {
      if (status(error) === 404) return undefined;
      throw error;
    }
  }
  async comments(owner: string, repo: string, issue_number: number): Promise<IssueComment[]> {
    return z.array(commentSchema).parse(
      await this.api.paginate(this.api.issues.listComments, {
        owner,
        repo,
        issue_number,
        per_page: 100,
      }),
    );
  }
  async reviewComments(owner: string, repo: string, pull_number: number): Promise<ReviewComment[]> {
    return z.array(reviewCommentSchema).parse(
      await this.api.paginate(this.api.pulls.listReviewComments, {
        owner,
        repo,
        pull_number,
        per_page: 100,
      }),
    );
  }
  async resolvedReviewCommentIds(
    owner: string,
    repo: string,
    pull_number: number,
  ): Promise<Set<number>> {
    const resolved = new Set<number>();
    let after: string | null = null;
    for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
      const data: unknown = await this.api.graphql(THREADS_QUERY, {
        owner,
        repo,
        pull_number,
        after,
      });
      const threads = threadsSchema.parse(data).repository.pullRequest.reviewThreads;
      for (const thread of threads.nodes)
        if (thread.isResolved)
          for (const comment of thread.comments.nodes) resolved.add(comment.databaseId);
      if (!threads.pageInfo.hasNextPage) break;
      after = threads.pageInfo.endCursor;
    }
    return resolved;
  }
  async createComment(
    owner: string,
    repo: string,
    issue_number: number,
    body: string,
  ): Promise<{ id: number }> {
    return (
      await this.api.issues.createComment({
        owner,
        repo,
        issue_number,
        body: sanitizeForPosting(body, { owner, repo }),
      })
    ).data;
  }
  async createSummary(
    owner: string,
    repo: string,
    issue_number: number,
    body: string,
  ): Promise<{ id: number }> {
    return (await this.api.issues.createComment({ owner, repo, issue_number, body })).data;
  }
  async updateSummary(
    owner: string,
    repo: string,
    comment_id: number,
    body: string,
  ): Promise<void> {
    await this.api.issues.updateComment({ owner, repo, comment_id, body });
  }
  async react(owner: string, repo: string, comment_id: number): Promise<void> {
    await this.api.reactions.createForIssueComment({ owner, repo, comment_id, content: "eyes" });
  }
  async review(payload: CreateReviewPayload): Promise<{ html_url: string }> {
    return (
      await this.api.pulls.createReview({
        ...payload,
        comments: payload.comments.map(({ start_line, start_side, ...comment }) => ({
          ...comment,
          ...(start_line === undefined ? {} : { start_line }),
          ...(start_side === undefined ? {} : { start_side }),
        })),
        request: { retries: 0 },
      })
    ).data;
  }
  async archive(owner: string, repo: string, ref: string): Promise<Buffer> {
    const response = await this.api.repos.downloadTarballArchive({ owner, repo, ref });
    return Buffer.from(response.data as ArrayBuffer);
  }
  async parents(owner: string, repo: string, ref: string): Promise<string[]> {
    return (await this.api.repos.getCommit({ owner, repo, ref })).data.parents.map(
      (parent) => parent.sha,
    );
  }
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}
export type GitHubPort = Pick<GitHub, keyof GitHub>;
