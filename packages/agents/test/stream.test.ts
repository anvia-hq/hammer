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

  it("breaks very long commentary at a space, not in the middle of a word", () => {
    const { lines, streamer } = collect();
    const long = `${"word ".repeat(100)}end`;
    streamer.delta("text", 1, long);
    streamer.toolCall(1);
    streamer.turnEnd(1);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines)
      expect(
        line
          .slice("text:".length)
          .split(" ")
          .every((word) => word === "word" || word === "end"),
      ).toBe(true);
  });
});
