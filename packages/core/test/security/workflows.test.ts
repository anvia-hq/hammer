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

  it("no workflow uses pull_request_target", () => {
    for (const file of workflows()) {
      expect(read(`.github/workflows/${file}`), file).not.toContain("pull_request_target");
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
