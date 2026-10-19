import { describe, expect, it } from "vitest";

import {
  postPullReview,
  renderJobSummaryMarkdown,
  renderSummaryBody,
  resolveObservability,
  traceUrlForRun,
  type CreateReviewPayload,
} from "../src/index";

describe("resolveObservability", () => {
  it("is disabled when both endpoints are unset", () => {
    expect(resolveObservability({})).toEqual({ ok: true, config: { enabled: false } });
    expect(resolveObservability({ lensEndpoint: undefined, otelEndpoint: undefined })).toEqual({
      ok: true,
      config: { enabled: false },
    });
  });

  it("treats blank strings as unset", () => {
    expect(resolveObservability({ lensEndpoint: "  ", otelEndpoint: "" })).toEqual({
      ok: true,
      config: { enabled: false },
    });
  });

  it("enables observability for a valid https endpoint", () => {
    const result = resolveObservability({ lensEndpoint: "https://lens.example.test/ingest" });
    expect(result).toEqual({
      ok: true,
      config: { enabled: true, lensEndpoint: "https://lens.example.test/ingest" },
    });
  });

  it("returns invalid_endpoint for an invalid URL", () => {
    const result = resolveObservability({ otelEndpoint: "not-a-url" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_endpoint");
  });

  it("rejects plain http unless it targets localhost", () => {
    expect(resolveObservability({ otelEndpoint: "http://otel.internal/v1" }).ok).toBe(false);
    const local = resolveObservability({ otelEndpoint: "http://localhost:4318/v1/traces" });
    expect(local).toEqual({
      ok: true,
      config: { enabled: true, otelEndpoint: "http://localhost:4318/v1/traces" },
    });
  });
});

describe("traceUrlForRun", () => {
  it("returns undefined when observability is disabled", () => {
    expect(traceUrlForRun({ enabled: false }, "run-1")).toBeUndefined();
  });

  it("returns undefined without a lens endpoint", () => {
    const resolved = resolveObservability({ otelEndpoint: "https://otel.example.test/v1" });
    expect(resolved.ok).toBe(true);
    if (resolved.ok && resolved.config.enabled) {
      expect(traceUrlForRun(resolved.config, "run-1")).toBeUndefined();
    }
  });

  it("builds a trace link string when lens is enabled", () => {
    const resolved = resolveObservability({ lensEndpoint: "https://lens.example.test/" });
    expect(resolved.ok).toBe(true);
    if (resolved.ok && resolved.config.enabled) {
      expect(traceUrlForRun(resolved.config, "run-1")).toBe(
        "https://lens.example.test/traces/run-1",
      );
    }
  });
});

describe("job summary trace line", () => {
  it("omits the trace line when traceUrl is absent", () => {
    const markdown = renderJobSummaryMarkdown({ postedInline: 1 });
    expect(markdown).not.toContain("Trace");
  });

  it("includes one trace line when traceUrl is provided", () => {
    const markdown = renderJobSummaryMarkdown({
      postedInline: 1,
      traceUrl: "https://lens.example.test/traces/run-1",
    });
    expect(markdown).toContain("| Trace | https://lens.example.test/traces/run-1 |");
  });
});

describe("posted review bodies exclude endpoint strings", () => {
  it("never includes the endpoint strings in the review payload", async () => {
    const resolved = resolveObservability({
      lensEndpoint: "https://lens.example.test/ingest",
      otelEndpoint: "https://otel.example.test/v1/traces",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("observability should resolve");
    const lensEndpoint = resolved.config.enabled ? resolved.config.lensEndpoint : undefined;
    const otelEndpoint = resolved.config.enabled ? resolved.config.otelEndpoint : undefined;
    const seen: CreateReviewPayload[] = [];
    const result = await postPullReview(
      {
        owner: "octo",
        repo: "hello",
        pullNumber: 7,
        commitId: "abc123",
        inline: [{ path: "src/app.ts", line: 4, body: "fix the retry logic" }],
        body: "review summary",
      },
      {
        createReview: async (payload) => {
          seen.push(payload);
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).not.toContain(lensEndpoint);
    expect(seen[0]!.body).not.toContain(otelEndpoint);
    for (const comment of seen[0]!.comments) {
      expect(comment.body).not.toContain(lensEndpoint);
      expect(comment.body).not.toContain(otelEndpoint);
    }
    const summary = renderSummaryBody({
      files: [{ path: "src/app.ts", status: "modified" }],
      headSha: "abc123",
    });
    expect(summary).not.toContain(lensEndpoint);
    expect(summary).not.toContain(otelEndpoint);
  });
});
