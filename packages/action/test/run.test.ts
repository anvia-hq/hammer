import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fingerprints,
  formatFingerprintComment,
  type CreateReviewPayload,
} from "@anvia/hammer-core";
import type { ReviewPipelineInput } from "@anvia/hammer-agents";
import { runAction, type ActionRuntime } from "../src/run";
import type { GitHubPort, IssueComment, PullRequest } from "../src/github";
import { cleanup } from "../src/post";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const head = "a".repeat(40);
const base = "b".repeat(40);
const repository = { full_name: "acme/sandbox", clone_url: "https://github.com/acme/sandbox.git" };
const finding = {
  path: "src/a.ts",
  line: 2,
  severity: "high",
  category: "correctness",
  title: "Null dereference",
  body: "When user is null, this throws. Guard before use.",
  details:
    "- `packages/core/src/github/sanitize.ts:2` — reads `user.profile.displayName` before the null check\n\nRequired outcome: the lookup tolerates a missing user.",
  confidence: 0.95,
};

async function fixture(overrides: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "hammer-test-"));
  roots.push(root);
  const eventPath = join(root, "event.json");
  const payload = {
    action: "opened",
    repository: { name: "sandbox", owner: { login: "acme" } },
    sender: { login: "contributor", type: "User" },
    pull_request: { number: 7, head: { sha: head }, draft: false },
  };
  await writeFile(eventPath, JSON.stringify(payload));
  const inputs = {
    client: "openai",
    model: "gpt-4o",
    "api-key": "test-model-key",
    "github-token": "test-github-token",
    verify: "false",
    ...overrides,
  };
  const outputs: Record<string, string> = {};
  const state: Record<string, string> = {};
  const runtime: ActionRuntime = {
    getInput: (key) => inputs[key as keyof typeof inputs] ?? "",
    setSecret: vi.fn(),
    setOutput: (key, value) => {
      outputs[key] = value;
    },
    saveState: (key, value) => {
      state[key] = value;
    },
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    setFailed: vi.fn(),
    summary: vi.fn(async () => {}),
  };
  const pr: PullRequest = {
    number: 7,
    state: "open",
    title: "Update user lookup",
    body: "PR data",
    draft: false,
    user: { login: "contributor", type: "User" },
    labels: [],
    changed_files: 1,
    head: { sha: head, repo: repository },
    base: { sha: base, repo: repository },
  };
  const posted: CreateReviewPayload[] = [];
  const summaries: string[] = [];
  const comments: IssueComment[] = [];
  const github = {
    permission: vi.fn(async () => "write"),
    identity: vi.fn(async () => "github-actions[bot]"),
    pull: vi.fn(async () => structuredClone(pr)),
    files: vi.fn(async () => [
      {
        filename: "src/a.ts",
        sha: head,
        status: "modified" as const,
        additions: 1,
        deletions: 1,
        changes: 2,
        patch:
          "@@ -1,3 +1,3 @@\n function get(user) {\n-  return user?.name;\n+  return user.name;\n }",
      },
    ]),
    compare: vi.fn(async () => ({ ancestor: true, files: [] })),
    content: vi.fn(
      async (
        _owner: string,
        _repo: string,
        path: string,
        _ref: string,
      ): Promise<string | undefined> => (path === "AGENTS.md" ? "Base branch rule" : undefined),
    ),
    comments: vi.fn(async () => comments),
    reviewComments: vi.fn<GitHubPort["reviewComments"]>(async () => []),
    resolvedReviewCommentIds: vi.fn(async () => new Set<number>()),
    parents: vi.fn(async () => [base]),
    review: vi.fn(async (value: CreateReviewPayload) => {
      posted.push(value);
      return { html_url: "https://github.com/acme/sandbox/pull/7#pullrequestreview-1" };
    }),
    createSummary: vi.fn(async (_owner: string, _repo: string, _number: number, body: string) => {
      summaries.push(body);
      return { id: 12 };
    }),
    updateSummary: vi.fn(async (_owner: string, _repo: string, _id: number, body: string) => {
      summaries.push(body);
    }),
    createComment: vi.fn(async () => ({ id: 13 })),
    react: vi.fn(async () => {}),
    archive: vi.fn(async () => Buffer.alloc(0)),
  } satisfies GitHubPort;
  const model: ReviewPipelineInput["model"] = {
    provider: "test",
    modelId: "fake",
    capabilities: {
      streaming: false,
      tools: true,
      toolChoice: true,
      outputSchema: false,
      imageInput: false,
      documentInput: false,
      reasoning: false,
    },
    completion: vi.fn(async () => ({
      choice: [
        {
          type: "text" as const,
          text: JSON.stringify({
            summary: "Changes user lookup",
            changes: ["Reworked the user lookup"],
            findings: [finding],
            generalNotes: [],
          }),
        },
      ],
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      rawResponse: {},
    })),
  };
  const checkout = vi.fn(async (options: { directory: string }) => {
    await mkdir(join(options.directory, "src"), { recursive: true });
    await writeFile(
      join(options.directory, "src/a.ts"),
      "function get(user) {\n  return user.name;\n}\n",
    );
  });
  const env = {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "acme/sandbox",
    GITHUB_RUN_ID: "123",
    RUNNER_TEMP: root,
  };
  return {
    root,
    eventPath,
    payload,
    runtime,
    outputs,
    state,
    pr,
    posted,
    summaries,
    comments,
    github,
    model,
    checkout,
    env,
    run: (extra: Partial<Parameters<typeof runAction>[2]> = {}) =>
      runAction(runtime, env, { github, model, checkout, ...extra }),
  };
}

describe("Action review flow", () => {
  it("reviews a PR through the real agent and publishes a pinned COMMENT review, summary, outputs and result", async () => {
    const f = await fixture({ fail_on: "high" });
    await f.run();
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0]).toMatchObject({
      event: "COMMENT",
      commit_id: head,
      comments: [{ path: "src/a.ts", line: 2, side: "RIGHT" }],
    });
    expect(f.posted[0]?.comments[0]?.body).toContain("<!-- hammer:fp=");
    expect(f.posted[0]?.body.startsWith("> [!CAUTION]\n> 1 high-severity finding")).toBe(true);
    expect(f.posted[0]?.body).toContain(
      "**Reviewed changes**\n\nChanges user lookup\n\n- Reworked the user lookup",
    );
    expect(f.posted[0]?.body).toContain(
      "[View workflow run](https://github.com/acme/sandbox/actions/runs/123) | Using `openai/gpt-4o`",
    );
    const inline = f.posted[0]?.comments[0]?.body ?? "";
    expect(inline.startsWith("> [!CAUTION]\n> **High · correctness**")).toBe(true);
    expect(inline).toContain("<details>\n<summary>Technical details</summary>");
    expect(inline).toContain("`packages/core/src/github/sanitize.ts:2`");
    expect(inline).not.toContain("[redacted]");
    expect(f.summaries[0]).toContain("Review in progress");
    expect(f.summaries[0]).toContain("- [ ] ⏳ Check out the PR head");
    expect(f.summaries[0]).not.toContain("Null dereference");
    expect(f.github.createSummary).toHaveBeenCalledTimes(1);
    expect(f.github.updateSummary.mock.calls.every((call) => call[2] === 12)).toBe(true);
    expect(f.summaries.at(-1)).toContain("Null dereference");
    expect(f.summaries.at(-1)).not.toContain("Review in progress");
    expect(f.summaries.at(-1)).toContain(`hammer:last-sha=${head}`);
    expect(f.outputs).toMatchObject({ findings_count: "1", high_count: "1", tokens: "30" });
    expect(JSON.parse(await readFile(f.outputs.result_path!, "utf8"))).toMatchObject({
      headSha: head,
      findings: [{ title: "Null dereference" }],
    });
    expect(f.runtime.setFailed).toHaveBeenCalled();
    expect(f.github.content.mock.calls.every((call) => call[3] === base)).toBe(true);
    expect(f.runtime.setSecret).toHaveBeenCalledWith("test-model-key");
    expect(f.runtime.info).toHaveBeenCalledWith("[hammer] skills: code-review-and-quality");
    expect(f.runtime.warning).not.toHaveBeenCalledWith(
      expect.stringContaining("skills unavailable"),
    );
    await cleanup(f.state["review-directory"]!, f.root);
    await expect(readFile(f.outputs.result_path!, "utf8")).rejects.toThrow();
  });
  it("skips fork auto-review before requiring a model key or accessing config", async () => {
    const f = await fixture({ "api-key": "" });
    f.pr.head.repo = { ...repository, full_name: "fork/sandbox" };
    await f.run();
    expect(f.checkout).not.toHaveBeenCalled();
    expect(f.github.content).not.toHaveBeenCalled();
    expect(f.summaries).toHaveLength(0);
    expect(f.runtime.setFailed).not.toHaveBeenCalled();
    expect(f.runtime.notice).toHaveBeenCalledWith(
      expect.stringContaining("maintainer's /hammer review"),
    );
  });
  it("denies an unauthorized command before reading repository data and adds an eyes reaction", async () => {
    const f = await fixture();
    f.env.GITHUB_EVENT_NAME = "issue_comment";
    await writeFile(
      f.eventPath,
      JSON.stringify({
        action: "created",
        repository: f.payload.repository,
        sender: f.payload.sender,
        issue: { number: 7, pull_request: {} },
        comment: { id: 8, body: "/hammer review", user: f.payload.sender },
      }),
    );
    f.github.permission.mockResolvedValue("read");
    await f.run();
    expect(f.github.react).toHaveBeenCalledWith("acme", "sandbox", 8);
    expect(f.github.pull).not.toHaveBeenCalled();
    expect(f.checkout).not.toHaveBeenCalled();
  });
  it("allows an authorized fork review with a maintainer instruction", async () => {
    const f = await fixture();
    f.pr.head.repo = { ...repository, full_name: "fork/sandbox" };
    f.env.GITHUB_EVENT_NAME = "issue_comment";
    await writeFile(
      f.eventPath,
      JSON.stringify({
        action: "created",
        repository: f.payload.repository,
        sender: f.payload.sender,
        issue: { number: 7, pull_request: {} },
        comment: { id: 8, body: "/hammer review focus on null handling", user: f.payload.sender },
      }),
    );
    await f.run();
    expect(f.github.permission).toHaveBeenCalled();
    expect(f.posted).toHaveLength(1);
    expect(f.model.completion).toHaveBeenCalledWith(
      expect.objectContaining({
        chatHistory: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("focus on null handling"),
          }),
        ]),
      }),
      expect.anything(),
    );
  });
  it("discards stale results without publishing", async () => {
    const f = await fixture();
    f.github.pull
      .mockResolvedValueOnce(structuredClone(f.pr))
      .mockResolvedValueOnce({ ...f.pr, head: { ...f.pr.head, sha: "c".repeat(40) } });
    await f.run();
    expect(f.posted).toHaveLength(0);
    expect(f.summaries.every((body) => body.includes("Review in progress"))).toBe(true);
  });
  it("publishes a sanitized error and obeys fail_on_error", async () => {
    const f = await fixture({ fail_on_error: "true" });
    f.github.content.mockRejectedValue(
      new Error("unavailable test-model-key <img src=x> @attacker"),
    );
    await f.run();
    expect(f.runtime.setFailed).toHaveBeenCalled();
    expect(f.summaries[0]).toContain("[redacted]");
    expect(f.summaries[0]).not.toContain("test-model-key");
    expect(f.summaries[0]).not.toContain("<img");
    expect(f.posted).toHaveLength(0);
  });
  it("does not duplicate a previously posted finding", async () => {
    const f = await fixture();
    f.github.reviewComments.mockResolvedValue([
      {
        id: 9,
        path: finding.path,
        line: 2,
        original_line: 2,
        user: { login: "github-actions[bot]", type: "Bot" },
        body: `${finding.body}\n${formatFingerprintComment(fingerprints(finding.path, finding.body))}`,
      },
    ] as never);
    await f.run();
    expect(f.posted).toHaveLength(0);
    expect(f.outputs.findings_count).toBe("1");
  });
  it("uses bot-login as its identity without looking the token up", async () => {
    const f = await fixture({ "bot-login": "hammer[bot]" });
    f.comments.push({
      id: 5,
      user: { login: "hammer[bot]", type: "Bot" },
      body: "<!-- hammer:summary -->",
    });
    await f.run();
    expect(f.github.identity).not.toHaveBeenCalled();
    expect(f.github.updateSummary.mock.calls.some((call) => call[2] === 5)).toBe(true);
    expect(f.github.createSummary).not.toHaveBeenCalled();
  });
  it("posts as the platform bot when the platform issues a token", async () => {
    const f = await fixture({ "platform-url": "https://platform.example" });
    f.comments.push({
      id: 5,
      user: { login: "anvia-hammer[bot]", type: "Bot" },
      body: "<!-- hammer:summary -->",
    });
    const platformToken = vi.fn(async () => ({
      ok: true as const,
      value: { token: "ghs_app", login: "anvia-hammer[bot]" },
    }));
    await f.run({ platformToken });
    expect(platformToken).toHaveBeenCalledWith(
      expect.objectContaining({ platformUrl: "https://platform.example" }),
    );
    expect(f.github.identity).not.toHaveBeenCalled();
    expect(f.github.updateSummary.mock.calls.some((call) => call[2] === 5)).toBe(true);
    expect(f.runtime.info).toHaveBeenCalledWith("[hammer] posting as anvia-hammer[bot]");
  });
  it("falls back to the workflow token when the platform cannot issue one", async () => {
    const f = await fixture({ "platform-url": "https://platform.example" });
    const platformToken = vi.fn(async () => ({ ok: false as const, reason: "no id-token" }));
    await f.run({ platformToken });
    expect(f.github.identity).toHaveBeenCalled();
    expect(f.posted).toHaveLength(1);
    expect(f.runtime.info).toHaveBeenCalledWith(
      "[hammer] posting as the workflow token: no id-token",
    );
  });
  it("skips the platform when bot-login is set or platform-url is empty", async () => {
    const platformToken = vi.fn(async () => ({ ok: false as const, reason: "unused" }));
    const withLogin = await fixture({ "platform-url": "https://p.example", "bot-login": "x[bot]" });
    await withLogin.run({ platformToken });
    const disabled = await fixture({ "platform-url": "" });
    await disabled.run({ platformToken });
    expect(platformToken).not.toHaveBeenCalled();
  });
  it("does not overwrite an attacker comment containing the sticky marker", async () => {
    const f = await fixture();
    f.comments.push({
      id: 5,
      user: { login: "attacker", type: "User" },
      body: "<!-- hammer:summary -->",
    });
    await f.run();
    expect(f.github.updateSummary.mock.calls.every((call) => call[2] !== 5)).toBe(true);
    expect(f.github.createSummary).toHaveBeenCalled();
  });
  it("reports partial model failures without advancing incremental state", async () => {
    const f = await fixture();
    vi.mocked(f.model.completion).mockRejectedValue(new Error("model unavailable"));
    await f.run();
    expect(f.posted).toHaveLength(0);
    expect(f.summaries.at(-1)).toContain("partial");
    expect(f.summaries.at(-1)).not.toContain("hammer:last-sha=");
    expect(f.runtime.setFailed).not.toHaveBeenCalled();
  });
  it("rejects cleanup outside its own directory", async () => {
    const f = await fixture();
    await expect(cleanup(f.root, f.root)).rejects.toThrow("Refusing");
  });
});

it("lets the real agent read PR discussion through its read-only tool", async () => {
  const f = await fixture();
  vi.mocked(f.model.completion).mockResolvedValueOnce({
    choice: [
      { type: "tool-call", toolCallId: "discussion-1", toolName: "get_pr_discussion", input: {} },
    ],
    usage: {
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    rawResponse: {},
  });
  await f.run();
  expect(f.posted).toHaveLength(1);
  const second = vi.mocked(f.model.completion).mock.calls[1]?.[0];
  expect(JSON.stringify(second?.chatHistory)).toContain("PR data");
  expect(second?.instructions).not.toContain("PR data");
  expect(f.outputs.tokens).toBe("40");
});

it("retains the severity gate for a deduplicated finding", async () => {
  const f = await fixture({ fail_on: "high" });
  f.github.reviewComments.mockResolvedValue([
    {
      id: 9,
      path: finding.path,
      line: 2,
      original_line: 2,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: formatFingerprintComment(fingerprints(finding.path, finding.body)),
    },
  ]);
  await f.run();
  expect(f.posted).toHaveLength(0);
  expect(f.runtime.setFailed).toHaveBeenCalled();
  expect(f.summaries.at(-1)).toContain("Null dereference");
});

it("tells the reviewer which earlier findings were resolved and dedupes them", async () => {
  const f = await fixture();
  f.github.reviewComments.mockResolvedValue([
    {
      id: 9,
      path: finding.path,
      line: 2,
      original_line: 2,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: formatFingerprintComment(fingerprints(finding.path, finding.body)),
    },
  ]);
  f.github.resolvedReviewCommentIds.mockResolvedValue(new Set([9]));
  await f.run();
  const prompt = JSON.stringify(vi.mocked(f.model.completion).mock.calls[0]?.[0].chatHistory);
  expect(prompt).toContain("marked resolved");
  expect(prompt).not.toContain("Previously posted open Hammer findings");
  expect(f.posted).toHaveLength(0);
});

it("keeps reviewing when resolved threads cannot be read", async () => {
  const f = await fixture();
  f.github.resolvedReviewCommentIds.mockRejectedValue(new Error("Resource not accessible"));
  await f.run();
  expect(f.posted).toHaveLength(1);
  expect(f.runtime.warning).toHaveBeenCalledWith(
    expect.stringContaining("Resolved threads unavailable"),
  );
});

it("honors verification disabled in base config when there is no action override", async () => {
  const f = await fixture({ verify: "" });
  f.github.content.mockImplementation(async (_owner, _repo, path) =>
    path === ".github/hammer.yml" ? "verify: false\n" : undefined,
  );
  await f.run();
  expect(f.model.completion).toHaveBeenCalledTimes(1);
});

it("reports cost from a host pricing override", async () => {
  const f = await fixture({
    pricing: JSON.stringify({ "openai/gpt-4o": { input: 2, output: 10 } }),
  });
  await f.run();
  expect(Number(f.outputs.cost_usd)).toBeCloseTo(0.00014);
});

it("publishes a partial result without treating a zero-cost cap as an action error", async () => {
  const f = await fixture({
    max_cost_usd: "0",
    fail_on_error: "true",
    pricing: JSON.stringify({ "openai/gpt-4o": { input: 2, output: 10 } }),
  });
  await f.run();
  expect(f.model.completion).not.toHaveBeenCalled();
  expect(f.summaries.at(-1)).toContain("partial");
  expect(f.runtime.setFailed).not.toHaveBeenCalled();
});
