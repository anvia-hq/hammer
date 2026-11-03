import { describe, expect, it } from "vitest";
import {
  cancelsInProgress,
  isProgressBody,
  renderInterruptedBody,
  renderProgressBody,
} from "../src";

describe("cancelsInProgress", () => {
  it("detects cancel-in-progress on the job", () => {
    const workflow =
      "jobs:\n  review:\n    concurrency:\n      group: g\n      cancel-in-progress: true\n";
    expect(cancelsInProgress(workflow)).toBe(true);
  });
  it("detects cancel-in-progress on the workflow", () => {
    expect(
      cancelsInProgress("concurrency:\n  group: g\n  cancel-in-progress: true\njobs: {}\n"),
    ).toBe(true);
  });
  it("treats an expression as cancelling", () => {
    const workflow =
      "concurrency:\n  group: g\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n";
    expect(cancelsInProgress(workflow)).toBe(true);
  });
  it("reports a workflow without it", () => {
    expect(cancelsInProgress("jobs:\n  review:\n    concurrency:\n      group: g\n")).toBe(false);
    expect(cancelsInProgress("jobs:\n  review:\n    runs-on: ubuntu-latest\n")).toBe(false);
  });
  it("returns undefined for unreadable YAML", () => {
    expect(cancelsInProgress("a: [")).toBeUndefined();
    expect(cancelsInProgress("just text")).toBeUndefined();
  });
});

describe("interrupted body", () => {
  it("is not a progress body and keeps the last reviewed sha", () => {
    const sha = "a".repeat(40);
    const body = renderInterruptedBody({ reason: "event sender is a bot", lastSha: sha });
    expect(isProgressBody(body)).toBe(false);
    expect(body).toContain("event sender is a bot");
    expect(body).toContain("Last reviewed commit: `aaaaaaa`");
    expect(body.trimEnd().endsWith(`<!-- hammer:last-sha=${sha} -->`)).toBe(true);
  });
  it("recognises a progress body", () => {
    expect(isProgressBody(renderProgressBody({ steps: [] }))).toBe(true);
  });
});
