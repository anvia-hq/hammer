import { describe, expect, it } from "vitest";
import { createTextStreamer } from "../src/stream";

function collect() {
  const lines: string[] = [];
  return { lines, streamer: createTextStreamer((kind, text) => lines.push(`${kind}:${text}`)) };
}

describe("text streamer", () => {
  it("emits complete lines as deltas arrive and keeps the tail when a tool follows", () => {
    const { lines, streamer } = collect();
    streamer.delta("text", 1, "Checking the ");
    streamer.delta("text", 1, "helper.\nThen the cal");
    expect(lines).toEqual(["text:Checking the helper."]);
    streamer.delta("text", 1, "ler");
    streamer.toolCall(1);
    streamer.turnEnd(1);
    expect(lines).toEqual(["text:Checking the helper.", "text:Then the caller"]);
  });

  it("never streams the final JSON answer", () => {
    const { lines, streamer } = collect();
    streamer.delta("text", 2, '{"summary":"x",\n"findings":[]}');
    streamer.turnEnd(2);
    streamer.delta("text", 3, "```json\n{}\n```");
    streamer.end();
    expect(lines).toEqual([]);
  });

  it("drops unfinished commentary on a turn that ends without a tool call", () => {
    const { lines, streamer } = collect();
    streamer.delta("text", 1, "All done");
    streamer.turnEnd(1);
    expect(lines).toEqual([]);
  });

  it("streams reasoning on its own channel and splits very long lines", () => {
    const { lines, streamer } = collect();
    streamer.delta("reasoning", 1, "Considering the null case.");
    streamer.turnEnd(1);
    expect(lines).toEqual(["reasoning:Considering the null case."]);
    const long = `${"word ".repeat(100)}end`;
    streamer.delta("reasoning", 2, long);
    streamer.end();
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.slice(1).every((line) => line.length < 260)).toBe(true);
  });
});
