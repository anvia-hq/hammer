import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultRepoConfig, resolveConfig, ReviewBatchSchema } from "@anvia/hammer-core";
import {
  CodexError,
  codexEffort,
  codexReviewSchema,
  createCodexBackend,
  dropNullOptionals,
  runReviewPipeline,
  runSinglePassReview,
  type CodexBackendOptions,
  type CodexExecFn,
  type CodexExecParams,
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

const MCP_SERVER = {
  command: "/usr/bin/node",
  args: ["/opt/hammer/dist/codex-mcp.js"],
  env: { HAMMER_CODEX_CONTEXT: "/tmp/hammer/context.json" },
};

function line(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

function turn(text: string, usage: Record<string, number> = {}): string[] {
  return [
    line({ type: "thread.started", thread_id: "t" }),
    line({ type: "turn.started" }),
    line({ type: "item.completed", item: { id: "i1", type: "agent_message", text } }),
    line({
      type: "turn.completed",
      usage: {
        input_tokens: 120,
        cached_input_tokens: 100,
        output_tokens: 30,
        reasoning_output_tokens: 10,
        ...usage,
      },
    }),
  ];
}

function toolTurn(name: string, result: string): string[] {
  return [
    line({ type: "thread.started", thread_id: "t" }),
    line({ type: "turn.started" }),
    line({
      type: "item.started",
      item: { id: "i1", type: "mcp_tool_call", server: "hammer", tool: name, arguments: {} },
    }),
    line({
      type: "item.completed",
      item: {
        id: "i1",
        type: "mcp_tool_call",
        server: "hammer",
        tool: name,
        arguments: {},
        status: "completed",
        result: { content: [{ type: "text", text: result }] },
      },
    }),
  ];
}

interface Recorded {
  params: CodexExecParams;
}

function scriptedExec(script: (string[] | Error)[], seen: Recorded[] = []): CodexExecFn {
  let index = 0;
  return (params) => {
    seen.push({ params });
    const entry = script[index] ?? script[script.length - 1] ?? [];
    index += 1;
    return (async function* () {
      if (entry instanceof Error) throw entry;
      for (const item of entry) yield item;
    })();
  };
}

const workDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    workDirectories.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

async function workDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hammer-codex-test-"));
  workDirectories.push(directory);
  return directory;
}

async function backend(
  script: (string[] | Error)[],
  seen: Recorded[] = [],
  overrides: Partial<CodexBackendOptions> = {},
) {
  return createCodexBackend({
    model: "gpt-5.1-codex",
    executablePath: "/opt/hammer/bin/codex",
    cwd: "/tmp/hammer/head",
    workDirectory: await workDirectory(),
    env: { CODEX_HOME: "/tmp/hammer/codex-home" },
    mcpServer: MCP_SERVER,
    exec: scriptedExec(script, seen),
    ...overrides,
  });
}

function reviewInput() {
  return {
    model: "codex/gpt-5.1-codex",
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

function override(argv: readonly string[], prefix: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? "";
    if (value === "-c" && (argv[index + 1] ?? "").startsWith(prefix))
      return (argv[index + 1] ?? "").slice(prefix.length);
  }
  return undefined;
}

describe("codex exec argv", () => {
  it("runs a read-only, tooled-down turn with Hammer's MCP server mounted", async () => {
    const seen: Recorded[] = [];
    const built = await backend(
      [[...toolTurn("read_file", "1: a"), ...turn(JSON.stringify(batch))]],
      seen,
    );
    await runSinglePassReview(reviewInput(), { backend: built, checkoutRoot: "/tmp" });
    const argv = seen[0]?.params.args ?? [];
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("--json");
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv).toContain("--ephemeral");
    expect(argv).toContain("--ignore-user-config");
    expect(argv).toContain("--ignore-rules");
    expect(argv.slice(argv.indexOf("--sandbox"), argv.indexOf("--sandbox") + 2)).toEqual([
      "--sandbox",
      "read-only",
    ]);
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual([
      "--model",
      "gpt-5.1-codex",
    ]);
    expect(argv.at(-1)).toBe("-");
    expect(override(argv, "web_search=")).toBe('"disabled"');
    expect(override(argv, "cli_auth_credentials_store=")).toBe('"file"');
    expect(override(argv, "project_doc_max_bytes=")).toBe("0");
    for (const feature of ["shell_tool", "view_image", "multi_agent", "multi_agent_v2"])
      expect(override(argv, `features.${feature}=`)).toBe("false");
    expect(override(argv, "mcp_servers.hammer.command=")).toBe('"/usr/bin/node"');
    expect(override(argv, "mcp_servers.hammer.args=")).toBe('["/opt/hammer/dist/codex-mcp.js"]');
    expect(override(argv, "mcp_servers.hammer.env=")).toBe(
      '{ "HAMMER_CODEX_CONTEXT" = "/tmp/hammer/context.json" }',
    );
    expect(override(argv, "mcp_servers.hammer.required=")).toBe("true");
    expect(override(argv, "developer_instructions=")).toContain("You are Hammer");
    expect(argv.join(" ")).not.toContain("dangerously-bypass");
    expect(seen[0]?.params.prompt).toContain("Add retry");
    expect(seen[0]?.params.cwd).toBe("/tmp/hammer/head");
  });

  it("asks for the review JSON through a strict output schema file", async () => {
    const seen: Recorded[] = [];
    const built = await backend([turn(JSON.stringify(batch))], seen);
    await runSinglePassReview(reviewInput(), { backend: built, checkoutRoot: "/tmp" });
    const argv = seen[0]?.params.args ?? [];
    const path = argv[argv.indexOf("--output-schema") + 1] ?? "";
    expect(path).toContain("review-schema.json");
    const schema = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(schema["additionalProperties"]).toBe(false);
    expect(schema["required"]).toEqual(["summary", "changes", "findings", "generalNotes"]);
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["changes"]).toMatchObject({ anyOf: [{ type: "array" }, { type: "null" }] });
  });

  it("passes a validated reasoning effort and fails fast on anything else", async () => {
    const seen: Recorded[] = [];
    const built = await backend([turn(JSON.stringify(batch))], seen);
    await runSinglePassReview(reviewInput(), {
      backend: built,
      checkoutRoot: "/tmp",
      reasoningEffort: "high",
    });
    expect(override(seen[0]?.params.args ?? [], "model_reasoning_effort=")).toBe('"high"');
    expect(codexEffort(undefined)).toBeUndefined();
    expect(() => codexEffort("maximum")).toThrow(/not supported by client codex/);
  });

  it("mounts no MCP server for a turn that has no tools", async () => {
    const seen: Recorded[] = [];
    const built = await backend(
      [
        [
          ...toolTurn("read_file", "1: a"),
          line({ type: "turn.failed", error: { message: "boom" } }),
        ],
        turn(JSON.stringify(batch)),
      ],
      seen,
    );
    const outcome = await runSinglePassReview(reviewInput(), {
      backend: built,
      checkoutRoot: "/tmp",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.partial).toBe(true);
    expect(override(seen[1]?.params.args ?? [], "mcp_servers.")).toBeUndefined();
    expect(seen[1]?.params.prompt).toContain("Do not call any tools");
  });
});

describe("codex structured output schema", () => {
  it("turns every optional field nullable and drops constraints the strict validator rejects", () => {
    const schema = codexReviewSchema(ReviewBatchSchema) as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["summary", "changes", "findings", "generalNotes"]);
    const serialized = JSON.stringify(schema);
    for (const keyword of ["maxLength", "maximum", "minimum", "maxItems", "$schema"])
      expect(serialized).not.toContain(`"${keyword}"`);
    const findings = schema.properties["findings"] as {
      items: { additionalProperties: boolean; required: string[] };
    };
    expect(findings.items.additionalProperties).toBe(false);
    expect(findings.items.required).toContain("startLine");
  });

  it("drops null optional fields before Hammer validates the answer", () => {
    const text = JSON.stringify({
      summary: "s",
      changes: null,
      findings: [{ path: "a.ts", startLine: null, line: 1 }],
      generalNotes: [],
    });
    expect(JSON.parse(dropNullOptionals(text))).toEqual({
      summary: "s",
      findings: [{ path: "a.ts", line: 1 }],
      generalNotes: [],
    });
    expect(dropNullOptionals("not json")).toBe("not json");
  });
});

describe("codex review backend", () => {
  it("returns a validated batch and maps turn usage into SinglePassUsage", async () => {
    const built = await backend([
      [...toolTurn("read_file", "1: export const retry = 1;"), ...turn(JSON.stringify(batch))],
    ]);
    const outcome = await runSinglePassReview(reviewInput(), {
      backend: built,
      checkoutRoot: "/tmp",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.batch.findings).toHaveLength(1);
      expect(outcome.usage).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    }
  });

  it("repairs a schema violation by replaying the transcript", async () => {
    const seen: Recorded[] = [];
    const built = await backend([turn("not json"), turn(JSON.stringify(batch))], seen);
    const outcome = await runSinglePassReview(reviewInput(), {
      backend: built,
      checkoutRoot: "/tmp",
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.params.prompt).toContain("Earlier in this review");
    expect(seen[1]?.params.prompt).toContain("not json");
    expect(seen[1]?.params.prompt).toContain("did not match the required JSON schema");
  });

  it("salvages a failed turn through the finalize prompt without tools", async () => {
    const seen: Recorded[] = [];
    const built = await backend(
      [
        [
          ...toolTurn("read_file", "1: const a = 1;"),
          line({ type: "turn.failed", error: { message: "context window exceeded" } }),
        ],
        turn(JSON.stringify(batch)),
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
      expect(outcome.note).toContain("model context limit reached");
    }
    expect(override(seen[1]?.params.args ?? [], "mcp_servers.")).toBeUndefined();
  });

  it("stops a turn at the max_turns limit and salvages what the review found", async () => {
    const seen: Recorded[] = [];
    const built = await backend(
      [
        [
          line({ type: "thread.started", thread_id: "t" }),
          line({ type: "turn.started" }),
          ...["a.ts", "b.ts", "c.ts"].flatMap((path, index) => [
            line({
              type: "item.started",
              item: { id: `t${index}`, type: "mcp_tool_call", server: "hammer", tool: "read_file" },
            }),
            line({
              type: "item.completed",
              item: {
                id: `t${index}`,
                type: "mcp_tool_call",
                server: "hammer",
                tool: "read_file",
                status: "completed",
                result: { content: [{ type: "text", text: path }] },
              },
            }),
          ]),
        ],
        turn(JSON.stringify(batch)),
      ],
      seen,
    );
    const outcome = await runSinglePassReview(reviewInput(), {
      backend: built,
      checkoutRoot: "/tmp",
      maxTurns: 2,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.partial).toBe(true);
      expect(outcome.note).toContain("turn limit reached");
      expect(outcome.batch.findings).toHaveLength(1);
    }
    expect(seen).toHaveLength(2);
  });

  it("names the device login when Codex reports an authentication failure", async () => {
    const built = await backend([
      [line({ type: "turn.failed", error: { message: "401 Unauthorized: not logged in" } })],
    ]);
    const outcome = await runSinglePassReview(reviewInput(), {
      backend: built,
      checkoutRoot: "/tmp",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("generate_failed");
      expect(outcome.issues[0]?.message).toContain("codex login --device-auth");
      expect(outcome.issues[0]?.message).toContain("codex-auth-json");
    }
  });

  it("keeps a runtime error that only mentions a line 401 out of the authentication message", async () => {
    const built = await backend([
      [
        line({
          type: "error",
          message: "TypeError: cannot read properties of undefined at a.ts:401",
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
      expect(outcome.issues[0]?.message).not.toContain("codex login --device-auth");
    }
  });

  it("fails with the missing-result code when a turn ends without a result", async () => {
    const built = await backend([[line({ type: "turn.started" })]]);
    const outcome = await runSinglePassReview(reviewInput(), {
      backend: built,
      checkoutRoot: "/tmp",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues[0]?.message).toContain("without a result");
  });

  it("maps a non-zero exit to its own code with the stderr tail", async () => {
    const seen: Recorded[] = [];
    const failing = createCodexBackend({
      model: "gpt-5.1-codex",
      executablePath: "/opt/hammer/bin/codex",
      cwd: "/tmp/hammer/head",
      workDirectory: await workDirectory(),
      env: {},
      exec: scriptedExec([new CodexError("exit", "Codex exited with code 2: boom")], seen),
    });
    const outcome = await runSinglePassReview(reviewInput(), {
      backend: failing,
      checkoutRoot: "/tmp",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues[0]?.message).toContain("exited with code 2");
  });

  it("stops a turn at the budget guard instead of starting it", async () => {
    const seen: Recorded[] = [];
    const built = await backend([turn(JSON.stringify(batch))], seen);
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
    const built = await backend(
      [
        turn(JSON.stringify(batch)),
        turn('{"scores":[{"id":"f1","score":9}]}'),
        turn('{"verdicts":[{"id":"t1","verdict":"fixed"}]}'),
      ],
      seen,
    );
    const request: ReviewPipelineInput = {
      title: "PR",
      files: reviewInput().files,
      config: resolveConfig(defaultRepoConfig(), { verify: true, max_comments: 5 }),
      checkoutRoot: "/tmp",
      discussion: {},
      modelRef: "codex/gpt-5.1-codex",
      backend: built,
      openThreads: [{ id: "thread-1", path: "a.ts", line: 2, body: "this loops forever" }],
    };
    const outcome = await runReviewPipeline(request);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.unverified).toBe(false);
    expect(outcome.judgements).toEqual([{ id: "thread-1", fixed: true, note: undefined }]);
    expect(seen).toHaveLength(3);
    expect(seen[1]?.params.args).not.toContain("--output-schema");
    expect(override(seen[1]?.params.args ?? [], "mcp_servers.hammer.required=")).toBe("true");
  });

  it("stops a turn that runs past its timeout", async () => {
    const hanging = createCodexBackend({
      model: "gpt-5.1-codex",
      executablePath: "/opt/hammer/bin/codex",
      cwd: "/tmp/hammer/head",
      workDirectory: await workDirectory(),
      env: {},
      turnTimeoutMs: 5,
      exec: () =>
        (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 50));
          yield line({ type: "turn.completed", usage: {} });
        })(),
    });
    const outcome = await runSinglePassReview(reviewInput(), {
      backend: hanging,
      checkoutRoot: "/tmp",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues[0]?.message).toContain("did not finish this turn");
  });
});
