import { describe, expect, it } from "vitest";

import { decideEvent, type GetCollaboratorPermission } from "../../src/event";
import { issueCommentEvent } from "../fixtures/index";

function permission(value: string): GetCollaboratorPermission {
  return async () => value;
}

describe("S1 comment trigger permission", () => {
  for (const role of ["write", "maintain", "admin"]) {
    it(`allows ${role}`, async () => {
      const decision = await decideEvent({
        eventName: "issue_comment",
        payload: issueCommentEvent({ body: "/hammer review" }),
        getPermission: permission(role),
      });
      expect(decision).toMatchObject({ run: true, kind: "comment" });
    });
  }

  it("is case-insensitive for permission values", async () => {
    const decision = await decideEvent({
      eventName: "issue_comment",
      payload: issueCommentEvent({ body: "/hammer review" }),
      getPermission: permission("Write"),
    });
    expect(decision.run).toBe(true);
  });

  for (const role of ["read", "none", "triage", ""]) {
    it(`denies "${role === "" ? "(empty)" : role}"`, async () => {
      const decision = await decideEvent({
        eventName: "issue_comment",
        payload: issueCommentEvent({ body: "/hammer review" }),
        getPermission: permission(role),
      });
      expect(decision.run).toBe(false);
      if (!decision.run) expect(decision.reason).toBe("insufficient_permission");
    });
  }

  it("denies when the permission check fails", async () => {
    const decision = await decideEvent({
      eventName: "issue_comment",
      payload: issueCommentEvent({ body: "/hammer review" }),
      getPermission: async () => {
        throw new Error("api down");
      },
    });
    expect(decision.run).toBe(false);
    if (!decision.run) expect(decision.reason).toBe("permission_check_failed");
  });

  it("denies bots before any permission check", async () => {
    let called = false;
    const decision = await decideEvent({
      eventName: "issue_comment",
      payload: issueCommentEvent({ body: "/hammer review", authorLogin: "renovate[bot]" }),
      getPermission: async () => {
        called = true;
        return "admin";
      },
    });
    expect(decision.run).toBe(false);
    if (!decision.run) expect(decision.reason).toBe("bot_sender");
    expect(called).toBe(false);
  });

  it("documents the fork no-secret notice boundary", async () => {
    const decision = await decideEvent({
      eventName: "pull_request",
      payload: (await import("../fixtures/index")).pullRequestEvent({}),
    });
    expect(decision.run).toBe(true);
    expect(decision.run && decision.kind === "pull_request").toBe(true);
  });
});
