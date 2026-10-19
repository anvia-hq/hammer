import { describe, expect, it } from "vitest";

import { type EventDecision, decideEvent, type GetCollaboratorPermission } from "../src/event";

function pullRequestPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    sender: { login: "octocat", type: "User" },
    repository: {
      name: "hello-world",
      owner: { login: "octocat" },
    },
    pull_request: {
      number: 42,
      draft: false,
      head: { sha: "abc123" },
    },
    ...overrides,
  };
}

function commentPayload(overrides: Record<string, unknown> = {}) {
  const comment = isRecord(overrides.comment)
    ? overrides.comment
    : {
        body: "/hammer review",
        user: { login: "octocat", type: "User" },
      };
  const { comment: _ignored, ...rest } = overrides;
  return {
    action: "created",
    sender: { login: "octocat", type: "User" },
    repository: {
      name: "hello-world",
      owner: { login: "octocat" },
    },
    issue: {
      number: 42,
      pull_request: { url: "https://api.github.com/repos/o/r/pulls/42" },
    },
    comment,
    ...rest,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function allow(permission: string): GetCollaboratorPermission {
  return async () => permission;
}

describe("pull_request triggers", () => {
  for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
    it(`runs on ${action}`, async () => {
      const decision = await decideEvent({
        eventName: "pull_request",
        payload: pullRequestPayload({ action }),
      });

      expect(decision.run).toBe(true);
      if (decision.run) {
        expect(decision.kind).toBe("pull_request");
      }
    });
  }

  it("skips non-trigger actions", async () => {
    for (const action of ["closed", "labeled", "assigned", "edited"]) {
      const decision: EventDecision = await decideEvent({
        eventName: "pull_request",
        payload: pullRequestPayload({ action }),
      });

      expect(decision.run).toBe(false);
      if (!decision.run) {
        expect(decision.log).toMatch(/skip/i);
      }
    }
  });

  it("skips draft PRs unless review_drafts is true", async () => {
    const payload = pullRequestPayload({
      pull_request: { number: 42, draft: true, head: { sha: "abc123" } },
    });

    const skipped = await decideEvent({
      eventName: "pull_request",
      payload,
    });
    expect(skipped.run).toBe(false);
    if (!skipped.run) {
      expect(skipped.log).toMatch(/skip/i);
      expect(skipped.log).toMatch(/draft/i);
    }

    const runs = await decideEvent({
      eventName: "pull_request",
      payload,
      reviewDrafts: true,
    });
    expect(runs.run).toBe(true);
  });

  it("runs non-draft PRs with the default options", async () => {
    const decision = await decideEvent({
      eventName: "pull_request",
      payload: pullRequestPayload(),
    });

    expect(decision).toMatchObject({
      run: true,
      kind: "pull_request",
      owner: "octocat",
      repo: "hello-world",
      prNumber: 42,
    });
  });

  it("denies pull_request events from bots", async () => {
    for (const sender of [
      { login: "dependabot[bot]", type: "Bot" },
      { login: "renovate[bot]", type: "Bot" },
      { login: "some-bot[bot]", type: "User" },
    ]) {
      const decision = await decideEvent({
        eventName: "pull_request",
        payload: pullRequestPayload({ sender }),
      });

      expect(decision.run).toBe(false);
    }
  });
});

describe("issue_comment triggers", () => {
  it("runs on /hammer comments from collaborators with write access", async () => {
    const decision = await decideEvent({
      eventName: "issue_comment",
      payload: commentPayload(),
      getPermission: allow("write"),
    });

    expect(decision).toMatchObject({
      run: true,
      kind: "comment",
      owner: "octocat",
      repo: "hello-world",
      prNumber: 42,
      username: "octocat",
    });
  });

  it("runs on comments with leading whitespace before /hammer", async () => {
    const decision = await decideEvent({
      eventName: "issue_comment",
      payload: commentPayload({
        comment: {
          body: "  /hammer review focus on migrations",
          user: { login: "octocat", type: "User" },
        },
      }),
      getPermission: allow("write"),
    });

    expect(decision.run).toBe(true);
    if (decision.run && decision.kind === "comment") {
      expect(decision.command).toBe("review focus on migrations");
    }
  });

  it("skips comments without the /hammer prefix", async () => {
    for (const body of [
      "please /hammer review this",
      "lgtm, nice work",
      "/hammering away at this",
    ]) {
      const decision = await decideEvent({
        eventName: "issue_comment",
        payload: commentPayload({
          comment: {
            body,
            user: { login: "octocat", type: "User" },
          },
        }),
        getPermission: allow("write"),
      });

      expect(decision.run).toBe(false);
      if (!decision.run) {
        expect(decision.log).toMatch(/skip/i);
      }
    }
  });

  it("skips comments on plain issues", async () => {
    const decision = await decideEvent({
      eventName: "issue_comment",
      payload: commentPayload({ issue: { number: 7 } }),
      getPermission: allow("write"),
    });

    expect(decision.run).toBe(false);
  });

  it("skips non-created comment actions", async () => {
    const decision = await decideEvent({
      eventName: "issue_comment",
      payload: commentPayload({ action: "edited" }),
      getPermission: allow("write"),
    });

    expect(decision.run).toBe(false);
  });

  it("allows admin, maintain and write", async () => {
    for (const permission of ["admin", "maintain", "write"]) {
      const decision = await decideEvent({
        eventName: "issue_comment",
        payload: commentPayload(),
        getPermission: allow(permission),
      });

      expect(decision.run).toBe(true);
    }
  });

  it("denies read and none", async () => {
    for (const permission of ["read", "none", "triage"]) {
      const decision = await decideEvent({
        eventName: "issue_comment",
        payload: commentPayload(),
        getPermission: allow(permission),
      });

      expect(decision.run).toBe(false);
      if (!decision.run) {
        expect(decision.log).toMatch(/skip/i);
      }
    }
  });

  it("denies bots", async () => {
    const payloads = [
      commentPayload({
        sender: { login: "github-actions[bot]", type: "Bot" },
      }),
      commentPayload({
        comment: {
          body: "/hammer review",
          user: { login: "dependabot[bot]", type: "Bot" },
        },
      }),
    ];

    for (const payload of payloads) {
      const decision = await decideEvent({
        eventName: "issue_comment",
        payload,
        getPermission: allow("write"),
      });

      expect(decision.run).toBe(false);
    }
  });

  it("skips when the permission check fails or is missing", async () => {
    const failing: GetCollaboratorPermission = async () => {
      throw new Error("network down");
    };

    const onError = await decideEvent({
      eventName: "issue_comment",
      payload: commentPayload(),
      getPermission: failing,
    });
    expect(onError.run).toBe(false);

    const withoutChecker = await decideEvent({
      eventName: "issue_comment",
      payload: commentPayload(),
    });
    expect(withoutChecker.run).toBe(false);
  });
});

describe("other events", () => {
  it("skips unsupported events without throwing", async () => {
    for (const eventName of ["push", "pull_request_review", "workflow_dispatch"]) {
      const decision = await decideEvent({
        eventName,
        payload: { action: "opened" },
      });

      expect(decision.run).toBe(false);
      if (!decision.run) {
        expect(decision.log).toMatch(/skip/i);
      }
    }
  });
});
