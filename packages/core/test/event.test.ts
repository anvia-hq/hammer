import { describe, expect, it } from "vitest";

import { type EventDecision, decideEvent, type GetCollaboratorPermission } from "../src/event";
import { issueCommentEvent, pullRequestEvent } from "./fixtures/index";

function allow(permission: string): GetCollaboratorPermission {
  return async () => permission;
}

describe("pull_request triggers", () => {
  for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
    it(`runs on ${action}`, async () => {
      const decision = await decideEvent({
        eventName: "pull_request",
        payload: pullRequestEvent({ action }),
      });

      expect(decision).toMatchObject({
        run: true,
        kind: "pull_request",
        owner: "anvia-hq",
        repo: "hammer",
        prNumber: 7,
        action,
        headSha: "9f2c1cd9e3d0c2b7d63f6e57eac0e1d4a51c3b6f",
      });
    });
  }

  it("skips non-trigger actions with a coded reason", async () => {
    for (const action of ["closed", "labeled", "assigned", "edited"]) {
      const decision: EventDecision = await decideEvent({
        eventName: "pull_request",
        payload: pullRequestEvent({ action }),
      });

      expect(decision.run).toBe(false);
      if (!decision.run) {
        expect(decision.reason).toBe("unsupported_action");
        expect(decision.message.length).toBeGreaterThan(0);
        expect(decision.log).toMatch(/^\[hammer\] skip: /);
      }
    }
  });

  it("skips draft PRs unless review_drafts is true", async () => {
    const skipped = await decideEvent({
      eventName: "pull_request",
      payload: pullRequestEvent({ draft: true }),
    });
    expect(skipped.run).toBe(false);
    if (!skipped.run) {
      expect(skipped.reason).toBe("draft_pull_request");
      expect(skipped.log).toMatch(/draft/i);
    }

    const runs = await decideEvent({
      eventName: "pull_request",
      payload: pullRequestEvent({ draft: true }),
      reviewDrafts: true,
    });
    expect(runs.run).toBe(true);
  });

  it("runs non-draft PRs with the default options", async () => {
    const decision = await decideEvent({
      eventName: "pull_request",
      payload: pullRequestEvent(),
    });

    expect(decision).toMatchObject({
      run: true,
      kind: "pull_request",
      owner: "anvia-hq",
      repo: "hammer",
      prNumber: 7,
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
        payload: pullRequestEvent({ sender }),
      });

      expect(decision.run).toBe(false);
      if (!decision.run) {
        expect(decision.reason).toBe("bot_sender");
      }
    }
  });
});

describe("issue_comment triggers", () => {
  it("runs on /hammer review from collaborators with write access", async () => {
    const decision = await decideEvent({
      eventName: "issue_comment",
      payload: issueCommentEvent({ body: "/hammer review" }),
      getPermission: allow("write"),
    });

    expect(decision).toMatchObject({
      run: true,
      kind: "comment",
      owner: "anvia-hq",
      repo: "hammer",
      prNumber: 7,
      username: "maintainer",
      command: "review",
    });
  });

  it("runs on /hammer review with trailing text and carries the text", async () => {
    const decision = await decideEvent({
      eventName: "issue_comment",
      payload: issueCommentEvent({ body: "  /hammer review focus on migrations" }),
      getPermission: allow("write"),
    });

    expect(decision.run).toBe(true);
    if (decision.run && decision.kind === "comment") {
      expect(decision.command).toBe("review focus on migrations");
    }
  });

  it("skips /hammer help with unsupported_command", async () => {
    const decision = await decideEvent({
      eventName: "issue_comment",
      payload: issueCommentEvent({ body: "/hammer help" }),
      getPermission: allow("write"),
    });

    expect(decision.run).toBe(false);
    if (!decision.run) {
      expect(decision.reason).toBe("unsupported_command");
      expect(decision.message.length).toBeGreaterThan(0);
      expect(decision.log).toMatch(/^\[hammer\] skip: /);
    }
  });

  it("runs on a bare /hammer with no command word", async () => {
    const decision = await decideEvent({
      eventName: "issue_comment",
      payload: issueCommentEvent({ body: "/hammer" }),
      getPermission: allow("write"),
    });

    expect(decision.run).toBe(true);
  });

  it("skips out-of-scope and unknown commands with unsupported_command", async () => {
    for (const body of ["/hammer resolve", "/hammer explain", "/hammer frobnicate"]) {
      const decision = await decideEvent({
        eventName: "issue_comment",
        payload: issueCommentEvent({ body }),
        getPermission: allow("write"),
      });

      expect(decision.run).toBe(false);
      if (!decision.run) {
        expect(decision.reason).toBe("unsupported_command");
        expect(decision.log).toMatch(/skip/i);
      }
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
        payload: issueCommentEvent({ body }),
        getPermission: allow("write"),
      });

      expect(decision.run).toBe(false);
      if (!decision.run) {
        expect(decision.reason).toBe("not_a_command");
        expect(decision.log).toMatch(/skip/i);
      }
    }
  });

  it("skips comments on plain issues", async () => {
    const decision = await decideEvent({
      eventName: "issue_comment",
      payload: issueCommentEvent({ body: "/hammer review", onPullRequest: false }),
      getPermission: allow("write"),
    });

    expect(decision.run).toBe(false);
    if (!decision.run) {
      expect(decision.reason).toBe("not_a_pull_request");
    }
  });

  it("skips non-created comment actions", async () => {
    const decision = await decideEvent({
      eventName: "issue_comment",
      payload: issueCommentEvent({ body: "/hammer review", action: "edited" }),
      getPermission: allow("write"),
    });

    expect(decision.run).toBe(false);
    if (!decision.run) {
      expect(decision.reason).toBe("unsupported_action");
    }
  });

  it("allows admin, maintain and write", async () => {
    for (const permission of ["admin", "maintain", "write"]) {
      const decision = await decideEvent({
        eventName: "issue_comment",
        payload: issueCommentEvent({ body: "/hammer review" }),
        getPermission: allow(permission),
      });

      expect(decision.run).toBe(true);
    }
  });

  it("denies read and none", async () => {
    for (const permission of ["read", "none", "triage"]) {
      const decision = await decideEvent({
        eventName: "issue_comment",
        payload: issueCommentEvent({ body: "/hammer review" }),
        getPermission: allow(permission),
      });

      expect(decision.run).toBe(false);
      if (!decision.run) {
        expect(decision.reason).toBe("insufficient_permission");
        expect(decision.log).toMatch(/skip/i);
      }
    }
  });

  it("denies bots", async () => {
    const payloads = [
      issueCommentEvent({
        body: "/hammer review",
        senderLogin: "github-actions[bot]",
        senderType: "Bot",
      }),
      issueCommentEvent({
        body: "/hammer review",
        authorLogin: "dependabot[bot]",
        authorType: "Bot",
      }),
    ];

    for (const payload of payloads) {
      const decision = await decideEvent({
        eventName: "issue_comment",
        payload,
        getPermission: allow("write"),
      });

      expect(decision.run).toBe(false);
      if (!decision.run) {
        expect(decision.reason).toBe("bot_sender");
      }
    }
  });

  it("skips when the permission check fails or is missing", async () => {
    const failing: GetCollaboratorPermission = async () => {
      throw new Error("network down");
    };

    const onError = await decideEvent({
      eventName: "issue_comment",
      payload: issueCommentEvent({ body: "/hammer review" }),
      getPermission: failing,
    });
    expect(onError.run).toBe(false);
    if (!onError.run) {
      expect(onError.reason).toBe("permission_check_failed");
    }

    const withoutChecker = await decideEvent({
      eventName: "issue_comment",
      payload: issueCommentEvent({ body: "/hammer review" }),
    });
    expect(withoutChecker.run).toBe(false);
    if (!withoutChecker.run) {
      expect(withoutChecker.reason).toBe("missing_permission_check");
    }
  });
});

describe("other events", () => {
  it("skips unsupported events with a coded reason", async () => {
    for (const eventName of ["push", "pull_request_review", "workflow_dispatch"]) {
      const decision = await decideEvent({
        eventName,
        payload: pullRequestEvent(),
      });

      expect(decision.run).toBe(false);
      if (!decision.run) {
        expect(decision.reason).toBe("unsupported_event");
        expect(decision.log).toMatch(/skip/i);
      }
    }
  });
});
