import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const REPO = new URL("../../../../", import.meta.url);

function read(rel: string): string {
  return readFileSync(new URL(rel, REPO), "utf8");
}

function blessedExample(): string {
  return read("docs/examples/hammer-fork-review.yml");
}

const BLESSED_TRIGGERS = ["opened", "synchronize", "reopened", "ready_for_review"];

function pullRequestTargetWorkflows(): { file: string; doc: unknown; text: string }[] {
  const found: { file: string; doc: unknown; text: string }[] = [];
  for (const file of readdirSync(new URL(".github/workflows/", REPO)).filter((f) =>
    f.endsWith(".yml"),
  )) {
    const text = read(`.github/workflows/${file}`);
    const doc = parseYaml(text) as { on?: unknown };
    if (JSON.stringify(doc.on ?? {}).includes("pull_request_target")) {
      found.push({ file, doc, text });
    }
  }
  return found;
}

describe("S2 pull_request_target allowlist", () => {
  it("action.yml never uses pull_request_target", () => {
    expect(read("action.yml")).not.toContain("pull_request_target");
  });

  it("README never uses pull_request_target in a workflow snippet", () => {
    for (const line of read("README.md").split("\n")) {
      if (line.includes("pull_request_target")) {
        expect(line.toLowerCase(), `unexpected pull_request_target line: ${line}`).toContain(
          "pull_request_target`",
        );
      }
    }
    expect(read("README.md")).not.toContain("pull_request_target:");
  });

  it("ci workflow never uses pull_request_target", () => {
    expect(read(".github/workflows/ci.yml")).not.toContain("pull_request_target");
  });

  it("no live workflow under .github/workflows uses pull_request_target", () => {
    expect(pullRequestTargetWorkflows()).toEqual([]);
  });

  it("the blessed opt-in example has the exact safe shape", () => {
    const text = blessedExample();
    const doc = parseYaml(text) as {
      on: { pull_request_target: { types: string[] } };
      permissions: Record<string, string>;
      jobs: Record<
        string,
        {
          concurrency?: { "cancel-in-progress"?: boolean };
          if?: string;
          steps: { uses?: string; run?: string }[];
          [key: string]: unknown;
        }
      >;
    };
    expect(Object.keys(doc.on)).toEqual(["pull_request_target"]);
    expect([...doc.on.pull_request_target.types].sort()).toEqual([...BLESSED_TRIGGERS].sort());
    expect(doc.permissions).toEqual({ contents: "read", "pull-requests": "write" });
    for (const [name, job] of Object.entries(doc.jobs)) {
      expect(job.concurrency?.["cancel-in-progress"], name).toBe(true);
      expect(job.if ?? "", name).toContain("head.repo.full_name");
      expect(job.if ?? "", name).toContain("!=");
      expect(job.steps.length, name).toBeGreaterThan(0);
      for (const step of job.steps) {
        expect(step.run ?? "", name).toBe("");
        expect(step.uses ?? "", name).toMatch(/^anvia-hq\/hammer@/);
        expect(step.uses ?? "", name).not.toContain("actions/checkout");
      }
      const stepWith = job.steps.map((step) => (step as { with?: unknown }).with);
      expect(JSON.stringify(stepWith), name).toContain("max_cost_usd");
      expect(JSON.stringify(stepWith), name).toContain("fail_on_error");
    }
    expect(text).not.toContain("pull_request:");
    expect(text, "must pin the action").toMatch(/anvia-hq\/hammer@(v1|[0-9a-f]{40})/);
  });

  it("the opt-in ADR defines the allowlist and points at the blessed example", () => {
    expect(read("docs/decision/0018-opt-in-fork-auto-review.md")).toContain(
      "docs/examples/hammer-fork-review.yml",
    );
  });

  it("docs mention pull_request_target only as a prohibition, opt-in, allowlist or table entry", () => {
    const blessed = blessedExample();
    expect(blessed).toContain("pull_request_target");
    const docs = readdirSync(new URL("docs/", REPO)).filter((f) => f.endsWith(".md"));
    for (const file of docs) {
      const text = read(`docs/${file}`);
      for (const line of text.split("\n")) {
        if (!line.includes("pull_request_target")) continue;
        const context = line.toLowerCase();
        const ok =
          context.includes("never") ||
          context.includes("no ") ||
          context.includes("without") ||
          context.includes("instead") ||
          context.includes("reject") ||
          context.includes("banned") ||
          context.includes("only") ||
          context.includes("opt-in") ||
          context.includes("opt in") ||
          context.includes("allowlist") ||
          context.includes("allow-list") ||
          context.includes("safe only") ||
          line.startsWith("|");
        expect(ok, `unexpected pull_request_target line in docs/${file}: ${line}`).toBe(true);
      }
    }
    for (const doc of [
      "docs/PRD.md",
      "docs/decision/0005-fork-prs-by-comment-trigger.md",
      "docs/security-coverage.md",
      "docs/archive/PRD-v0-agent-for-github.md",
    ]) {
      let text = "";
      try {
        text = read(doc);
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.includes("pull_request_target")) continue;
        const context = line.toLowerCase();
        const ok =
          context.includes("never") ||
          context.includes("no ") ||
          context.includes("without") ||
          context.includes("instead") ||
          context.includes("reject") ||
          context.includes("safe only if no one ever") ||
          context.includes("opt-in") ||
          context.includes("opt in") ||
          context.includes("allowlist") ||
          context.includes("allow-list") ||
          context.includes("banned") ||
          context.includes("only") ||
          line.startsWith("|");
        expect(ok, `unexpected pull_request_target line in ${doc}: ${line}`).toBe(true);
      }
    }
  });
});
