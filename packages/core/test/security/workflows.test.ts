import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const REPO = new URL("../../../../", import.meta.url);

function read(rel: string): string {
  return readFileSync(new URL(rel, REPO), "utf8");
}

function workflows(): string[] {
  return readdirSync(new URL(".github/workflows/", REPO)).filter((f) => f.endsWith(".yml"));
}

describe("workflows", () => {
  it("every workflow parses as YAML", () => {
    const files = workflows();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(() => parseYaml(read(`.github/workflows/${file}`)), file).not.toThrow();
    }
  });

  it("no live workflow uses pull_request_target; fork auto-review is opt-in only", async () => {
    for (const file of workflows()) {
      expect(read(`.github/workflows/${file}`), file).not.toContain("pull_request_target");
    }
    expect(() => read("docs/examples/hammer-fork-review.yml")).not.toThrow();
  });

  it("PR-triggered workflows never check out PR head code", () => {
    const texts = [
      read("docs/examples/hammer-fork-review.yml"),
      read(".github/workflows/hammer-review.yml"),
    ];
    for (const text of texts) {
      const doc = parseYaml(text) as {
        jobs?: Record<string, { steps?: { uses?: string; run?: string }[] }>;
      };
      for (const job of Object.values(doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          expect(step.uses ?? "", "checkout of PR head code").not.toContain("actions/checkout");
        }
      }
    }
  });

  it("runner-matrix covers the PRD §8.9 labels", () => {
    const text = read(".github/workflows/runner-matrix.yml");
    const doc = parseYaml(text) as {
      on: unknown;
      jobs: Record<string, { ["runs-on"]: unknown; ["continue-on-error"]?: unknown; if?: unknown }>;
    };
    expect(doc.on).not.toHaveProperty("pull_request_target");
    const labels = JSON.stringify(doc.jobs);
    for (const label of [
      "ubuntu-latest",
      "ubuntu-24.04-arm",
      "blacksmith-2vcpu-ubuntu-2404",
      "blacksmith-2vcpu-ubuntu-2404-arm",
      "self-hosted",
    ]) {
      expect(labels, label).toContain(label);
    }
    expect(text).toContain("continue-on-error");
    expect(text).toContain("if: false");
  });
});
