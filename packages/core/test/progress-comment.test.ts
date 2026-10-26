import { describe, expect, it } from "vitest";
import {
  applyProgressEvent,
  initialProgress,
  renderProgressBody,
  type ReviewEvent,
} from "../src/index";

describe("progress comment", () => {
  it("starts with a todo list that keeps the previous review's sha", () => {
    const body = renderProgressBody(
      initialProgress({ files: 3, verify: true, lastSha: "abc1234", runUrl: "https://x/run/1" }),
    );
    expect(body.startsWith("<!-- hammer:summary -->")).toBe(true);
    expect(body).toContain("- [ ] ⏳ Check out the PR head");
    expect(body).toContain("- [ ] Review 3 files");
    expect(body).toContain("- [ ] Verify findings");
    expect(body.trimEnd().endsWith("<!-- hammer:last-sha=abc1234 -->")).toBe(true);
    expect(body).toContain("[live log](https://x/run/1)");
  });

  it("omits the verify step when verification is off", () => {
    expect(renderProgressBody(initialProgress({ files: 1, verify: false }))).not.toContain(
      "Verify",
    );
  });

  it("tracks a single batch", () => {
    let state = initialProgress({ files: 2, verify: true });
    const events: ReviewEvent[] = [
      { type: "plan", files: 2, batches: 1, batchList: [{ id: "single", files: 2 }] },
      { type: "batch_start", batch: "single", files: 2 },
      { type: "batch_end", batch: "single", ok: true, findings: 1 },
      { type: "verify_start", findings: 1 },
      { type: "verify_end", kept: 1, dropped: 0 },
      { type: "done", inline: 1, notes: 0 },
    ];
    for (const event of events) state = applyProgressEvent(state, event);
    const body = renderProgressBody(state);
    expect(body).toContain("- [x] Check out the PR head");
    expect(body).toContain("- [x] Review 2 files (1 finding)");
    expect(body).toContain("- [x] Verify findings (kept 1, dropped 0)");
    expect(body).toContain("- [ ] ⏳ Post the review");
  });

  it("expands to one step per batch and marks failures", () => {
    let state = initialProgress({ files: 5, verify: false });
    state = applyProgressEvent(state, {
      type: "plan",
      files: 5,
      batches: 2,
      batchList: [
        { id: "src", files: 3 },
        { id: "doc`s", files: 2 },
      ],
    });
    state = applyProgressEvent(state, { type: "batch_start", batch: "src", files: 3 });
    state = applyProgressEvent(state, {
      type: "batch_end",
      batch: "doc`s",
      ok: false,
      findings: 0,
      error: "x",
    });
    const body = renderProgressBody(state);
    expect(body).toContain("- [ ] ⏳ Review batch `src` (3 files)");
    expect(body).toContain("- [ ] ❌ Review batch `doc's` (2 files) (failed)");
    expect(body).not.toContain("- [ ] Review 5 files");
  });
});
