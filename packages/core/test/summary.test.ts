import { describe, expect, it } from "vitest";

import {
  renderSummaryBody,
  SUMMARY_MARKER,
  upsertSummaryComment,
  type ListedComment,
} from "../src/index";

describe("renderSummaryBody", () => {
  it("starts with the marker and includes a last-sha line when a sha is given", () => {
    const body = renderSummaryBody({
      files: [{ path: "src/app.ts", status: "modified" }],
      headSha: "a1b2c3d",
    });
    expect(body.startsWith(`${SUMMARY_MARKER}\n`)).toBe(true);
    expect(body).toContain("<!-- hammer:last-sha=a1b2c3d -->");
    expect(body).toContain("### Hammer Review");
    expect(body).toContain("Files in scope");
  });

  it("omits the last-sha line when no sha is given", () => {
    const body = renderSummaryBody({ files: [{ path: "src/app.ts", status: "added" }] });
    expect(body).toContain(SUMMARY_MARKER);
    expect(body).not.toContain("hammer:last-sha");
  });

  it("renders renamed and removed files", () => {
    const body = renderSummaryBody({
      files: [
        { path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" },
        { path: "src/gone.ts", status: "removed" },
      ],
    });
    expect(body).toContain("`src/old.ts` → `src/new.ts` — renamed");
    expect(body).toContain("`src/gone.ts` — removed");
  });

  it("renders skipped files with reasons", () => {
    const body = renderSummaryBody({
      files: [{ path: "src/app.ts", status: "modified" }],
      skipped: [{ path: "pnpm-lock.yaml", reason: "lockfile" }],
    });
    expect(body).toContain("Skipped files");
    expect(body).toContain("`pnpm-lock.yaml` — lockfile");
  });

  it("neutralises mentions and strips raw html while keeping the hidden markers", () => {
    const body = renderSummaryBody({
      files: [{ path: "src/@evil.ts", status: "<b>modified</b>" }],
      skipped: [{ path: "@attacker", reason: "ping <img src=x> @attacker" }],
      headSha: "abc1234",
    });
    const markerLines = body.split("\n").filter((line) => line.startsWith("<!-- hammer:"));
    expect(markerLines).toEqual([SUMMARY_MARKER, "<!-- hammer:last-sha=abc1234 -->"]);
    const content = body
      .split("\n")
      .filter((line) => !line.startsWith("<!-- hammer:"))
      .join("\n");
    expect(content).not.toContain("<b>");
    expect(content).not.toContain("<img");
    expect(content).not.toContain("@evil");
    expect(content).not.toContain("@attacker");
    expect(content).toContain("@‍evil");
  });
});

describe("upsertSummaryComment", () => {
  it("creates a comment when no marker comment exists", async () => {
    const created: string[] = [];
    const result = await upsertSummaryComment(
      async () => [{ id: 1, body: "hello" }],
      async (body) => {
        created.push(body);
        return { id: 10 };
      },
      async () => {
        throw new Error("update should not be called");
      },
      `${SUMMARY_MARKER}\nbody\n`,
    );
    expect(result).toEqual({ id: 10, action: "created" });
    expect(created).toHaveLength(1);
  });

  it("updates the existing comment instead of creating a second one", async () => {
    const updated: Array<{ id: number; body: string }> = [];
    let created = 0;
    const pages: ListedComment[][] = [
      [{ id: 5, body: "other" }],
      [{ id: 7, body: `note\n${SUMMARY_MARKER}\nmore` }],
    ];
    const result = await upsertSummaryComment(
      async (page) => pages[page - 1] ?? [],
      async () => {
        created += 1;
        return { id: 99 };
      },
      async (commentId, body) => {
        updated.push({ id: commentId, body });
      },
      `${SUMMARY_MARKER}\nnew body\n`,
      { perPage: 1 },
    );
    expect(result).toEqual({ id: 7, action: "updated" });
    expect(created).toBe(0);
    expect(updated).toEqual([{ id: 7, body: `${SUMMARY_MARKER}\nnew body\n` }]);
    const rerun = await upsertSummaryComment(
      async (page) => pages[page - 1] ?? [],
      async () => {
        created += 1;
        return { id: 99 };
      },
      async (commentId, body) => {
        updated.push({ id: commentId, body });
      },
      `${SUMMARY_MARKER}\nnew body\n`,
      { perPage: 1 },
    );
    expect(rerun.action).toBe("updated");
    expect(created).toBe(0);
    expect(updated).toHaveLength(2);
  });

  it("finds the marker on the second page", async () => {
    const updated: number[] = [];
    const result = await upsertSummaryComment(
      async (page) =>
        page === 1
          ? [
              { id: 1, body: "one" },
              { id: 2, body: "two" },
            ]
          : [{ id: 3, body: `x ${SUMMARY_MARKER} y` }],
      async () => ({ id: 42 }),
      async (commentId) => {
        updated.push(commentId);
      },
      `${SUMMARY_MARKER}\nbody\n`,
      { perPage: 2 },
    );
    expect(result).toEqual({ id: 3, action: "updated" });
    expect(updated).toEqual([3]);
  });
});
