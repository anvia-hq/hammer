import type { Options, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { defaultRepoConfig, resolveConfig } from "@anvia/hammer-core";
import {
  createClaudeSdkBackend,
  resultUsage,
  runReviewPipeline,
  runSinglePassReview,
  translateQueryError,
  type ClaudeQueryFn,
  type ReviewPipelineInput,
} from "../src/index";

const batch = {
  summary: "Adds a retry helper.",
  findings: [
    {
      path: "a.ts",
      line: 2,
      severity: "high",
      category: "correctness",
      title: "Retry loop runs one extra time",
      body: "`attempt <= 3` sends four requests.",
      confidence: 0.9,
    },
  ],
  generalNotes: [],
};

function assistant(text: string, tools: string[] = []): SDKMessage {
  return {
    type: "assistant",
    message: {
      content: [
        ...(text === "" ? [] : [{ type: "text", text }]),
        ...tools.map((name) => ({ type: "tool_use", id: `t-${name}`, name, input: {} })),
      ],
    },
    parent_tool_use_id: null,
    session_id: "s",
    uuid: "u",
  } as unknown as SDKMessage;
}

function toolResult(text: string): SDKMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: text }] },
    parent_tool_use_id: null,
    session_id: "s",
    uuid: "u",
  } as unknown as SDKMessage;
}

function delta(text: string): SDKMessage[] {
  return [
    {
      type: "stream_event",
      event: { type: "message_start" },
      session_id: "s",
    } as unknown as SDKMessage,
    {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
      session_id: "s",
    } as unknown as SDKMessage,
  ];
}

function result(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 2,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { "claude-sonnet-4-5": { inputTokens: 120, outputTokens: 30 } },
    permission_denials: [],
    errors: [],
    session_id: "s",
    uuid: "u",
    ...overrides,
  } as unknown as SDKMessage;
}

interface Recorded {
  prompt: string;
  options: Options | undefined;
}

function scriptedQuery(script: SDKMessage[][], seen: Recorded[] = []): ClaudeQueryFn {
  let index = 0;
  return (params) => {
    seen.push({ prompt: params.prompt, options: params.options });
    const messages = script[index] ?? script[script.length - 1] ?? [];
    index += 1;
    return (async function* () {
      for (const message of messages) yield message;
    })();
  };
}

function backend(script: SDKMessage[][], seen: Recorded[] = []) {
  return createClaudeSdkBackend({
    model: "claude-sonnet-4-5",
    executablePath: "/tmp/hammer-claude/claude",
    cwd: "/tmp/hammer-review/head",
    configDir: "/tmp/hammer-review/claude-config",
    env: { CLAUDE_CODE_OAUTH_TOKEN: "secret-token" },
    query: scriptedQuery(script, seen),
  });
}

function reviewInput() {
  return {
    model: "claude-agent-sdk/claude-sonnet-4-5",
    title: "Add retry",
    files: [
      {
        filename: "a.ts",
        sha: "x",
        status: "modified" as const,
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
    ],
    config: { rules: [], path_instructions: [], use_repo_guidelines: false },
  };
}

describe("claude-agent-sdk review backend", () => {
  it("returns a validated batch with usage from model usage", async () => {
    const text: string[] = [];
    const seen: Recorded[] = [];
    const built = createClaudeSdkBackend({
      model: "claude-sonnet-4-5",
      executablePath: "/tmp/claude",
      cwd: "/tmp/hammer-review/head",
      configDir: "/tmp/hammer-review/cfg",
      env: {},
      query: scriptedQuery(
        [
          [
            ...delta("Reading a.ts to check the loop.\n"),
            assistant("Reading a.ts to check the loop.", ["mcp__hammer__read_file"]),
            toolResult("1: export const retry = 1;"),
            result({ structured_output: batch }),
          ],
        ],
        seen,
      ),
    });
    const outcome = await runSinglePassReview(reviewInput(), {
      backend: built,
      checkoutRoot: "/tmp",
      onText: (kind, value) => text.push(`${kind}:${value}`),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.batch.findings).toHaveLength(1);
      expect(outcome.usage).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    }
    expect(text.join("\n")).toContain("Reading a.ts to check the loop.");
    expect(seen[0]?.options?.tools).toEqual([]);
    expect(seen[0]?.options?.systemPrompt).toContain("You are Hammer");
  });

  it("repairs a schema violation by replaying the transcript", async () => {
    const seen: Recorded[] = [];
    const built = backend(
      [
        [assistant("first try"), result({ result: "not json", structured_output: undefined })],
        [result({ structured_output: batch })],
      ],
      seen,
    );
    const outcome = await runSinglePassReview(reviewInput(), {
      backend: built,
      checkoutRoot: "/tmp",
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.prompt).toContain("Earlier in this review");
    expect(seen[1]?.prompt).toContain("first try");
    expect(seen[1]?.prompt).toContain("did not match the required JSON schema");
  });

  it("salvages a turn that hit the turn limit, with tools off", async () => {
    const seen: Recorded[] = [];
    const built = backend(
      [
        [
          assistant("checking", ["mcp__hammer__read_file"]),
          toolResult("1: const a = 1;"),
          result({
            subtype: "error_max_turns",
            is_error: true,
            errors: ["Reached maximum number of turns (100)"],
          }),
        ],
        [result({ structured_output: batch })],
      ],
      seen,
    );
    const outcome = await runSinglePassReview(reviewInput(), {
      backend: built,
      checkoutRoot: "/tmp",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.partial).toBe(true);
      expect(outcome.note).toContain("turn limit reached");
      expect(outcome.batch.findings).toHaveLength(1);
    }
    expect(seen[1]?.options?.mcpServers).toBeUndefined();
    expect(seen[1]?.options?.maxTurns).toBe(2);
    expect(seen[1]?.prompt).toContain("Do not call any tools");
  });

  it("reports an authentication failure with the setup-token instruction, without salvage", async () => {
    const seen: Recorded[] = [];
    const built = backend(
      [
        [
          result({
            subtype: "error_during_execution",
            is_error: true,
            errors: ["Invalid API key · Please run /login"],
          }),
        ],
      ],
      seen,
    );
    const outcome = await runSinglePassReview(reviewInput(), {
      backend: built,
      checkoutRoot: "/tmp",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("generate_failed");
      expect(outcome.issues[0]?.message).toContain("claude setup-token");
      expect(outcome.issues[0]?.message).toContain("Pro, Max, Team or Enterprise");
      expect(outcome.issues[0]?.message).not.toContain("secret-token");
    }
    expect(seen).toHaveLength(1);
  });

  it("keeps a runtime error that only mentions a line 401 out of the authentication message", async () => {
    const built = backend([
      [
        result({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["TypeError: cannot read properties of undefined at a.ts:401"],
        }),
      ],
    ]);
    const outcome = await runSinglePassReview(reviewInput(), {
      backend: built,
      checkoutRoot: "/tmp",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues[0]?.message).toContain("reported an error");
      expect(outcome.issues[0]?.message).not.toContain("claude setup-token");
    }
  });

  it("names each error result subtype", async () => {
    for (const [subtype, expected] of [
      ["error_max_budget_usd", "budget"],
      ["error_max_structured_output_retries", "structured_output_retries"],
      ["error_during_execution", "reported an error"],
    ] as const) {
      const built = backend([[result({ subtype, is_error: true, errors: ["boom"] })]]);
      const outcome = await runSinglePassReview(reviewInput(), {
        backend: built,
        checkoutRoot: "/tmp",
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.issues[0]?.message.toLowerCase()).toContain(expected);
    }
  });

  it("stops a turn at the budget guard instead of starting it", async () => {
    const seen: Recorded[] = [];
    const built = backend([[result({ structured_output: batch })]], seen);
    const outcome = await runSinglePassReview(reviewInput(), {
      backend: built,
      checkoutRoot: "/tmp",
      startGuard: () => {
        throw new Error("Review budget reached.");
      },
    });
    expect(outcome.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("runs verification and thread judgement on the same backend", async () => {
    const seen: Recorded[] = [];
    const built = backend(
      [
        [result({ structured_output: batch })],
        [result({ result: '{"scores":[{"id":"f1","score":9}]}' })],
        [result({ result: '{"verdicts":[{"id":"t1","verdict":"fixed"}]}' })],
      ],
      seen,
    );
    const request: ReviewPipelineInput & { backend: typeof built } = {
      title: "PR",
      files: reviewInput().files,
      config: resolveConfig(defaultRepoConfig(), { verify: true, max_comments: 5 }),
      checkoutRoot: "/tmp",
      discussion: {},
      modelRef: "claude-agent-sdk/claude-sonnet-4-5",
      backend: built,
      openThreads: [{ id: "thread-1", path: "a.ts", line: 2, body: "this loops forever" }],
    };
    const outcome = await runReviewPipeline(request);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.unverified).toBe(false);
    expect(outcome.judgements).toEqual([{ id: "thread-1", fixed: true, note: undefined }]);
    expect(seen).toHaveLength(3);
    expect(seen[1]?.options?.outputFormat).toBeUndefined();
  });
});

describe("claude-agent-sdk usage", () => {
  it("counts cached prompt tokens as input", () => {
    const usage = resultUsage(
      result({
        modelUsage: {
          "claude-sonnet-4-5": {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 900,
            cacheCreationInputTokens: 50,
          },
        },
        usage: { input_tokens: 960, output_tokens: 5 },
      }) as SDKResultMessage,
    );
    expect(usage).toEqual({ inputTokens: 960, outputTokens: 5, totalTokens: 965 });
  });

  it("reads the API's own snake_case usage when a result carries no model usage", () => {
    const usage = resultUsage(
      result({
        modelUsage: {},
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 10,
        },
      }) as SDKResultMessage,
    );
    expect(usage).toEqual({ inputTokens: 150, outputTokens: 20, totalTokens: 170 });
  });
});

describe("claude-agent-sdk SDK error translation", () => {
  it("maps an error result the SDK throws into the authentication failure", async () => {
    const built = createClaudeSdkBackend({
      model: "claude-sonnet-4-5",
      executablePath: "/tmp/claude",
      cwd: "/tmp",
      configDir: "/tmp/cfg",
      env: {},
      query: () => {
        throw new Error(
          "Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token is invalid.",
        );
      },
    });
    const outcome = await runSinglePassReview(reviewInput(), {
      backend: built,
      checkoutRoot: "/tmp",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues[0]?.message).toContain("claude setup-token");
      expect(outcome.issues[0]?.message).not.toContain("invalid..");
    }
  });

  it("passes other errors through untouched", () => {
    const error = new Error("spawn claude ENOENT");
    expect(translateQueryError(error)).toBe(error);
  });
});
