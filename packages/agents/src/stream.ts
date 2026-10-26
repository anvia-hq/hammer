export type StreamedTextKind = "text" | "reasoning";
export type StreamedTextSink = (kind: StreamedTextKind, text: string) => void;

const MAX_LINE_CHARS = 240;

interface Channel {
  buffer: string;
  suppressed: boolean;
}

export interface TextStreamer {
  delta(kind: StreamedTextKind, turn: number, delta: string): void;
  toolCall(turn: number): void;
  turnEnd(turn: number): void;
  end(): void;
}

// Turns whose text opens with "{" or a code fence are the model's final JSON answer, not
// commentary, so they are never streamed. Other text is emitted a line at a time; the unfinished
// tail is kept only when the turn went on to call a tool.
export function createTextStreamer(emit: StreamedTextSink): TextStreamer {
  let turn = -1;
  let calledTool = false;
  const channels: Record<StreamedTextKind, Channel> = {
    text: { buffer: "", suppressed: false },
    reasoning: { buffer: "", suppressed: false },
  };

  const drain = (kind: StreamedTextKind, final: boolean): void => {
    const channel = channels[kind];
    if (channel.suppressed) {
      channel.buffer = "";
      return;
    }
    for (;;) {
      const newline = channel.buffer.indexOf("\n");
      let cut = newline;
      if (cut < 0 && channel.buffer.length > MAX_LINE_CHARS)
        cut = Math.max(channel.buffer.lastIndexOf(" ", MAX_LINE_CHARS), MAX_LINE_CHARS);
      if (cut < 0) break;
      const line = channel.buffer.slice(0, cut).trim();
      channel.buffer = channel.buffer.slice(cut + 1);
      if (line) emit(kind, line);
    }
    if (final) {
      const rest = channel.buffer.trim();
      channel.buffer = "";
      if (rest && (kind === "reasoning" || calledTool)) emit(kind, rest);
    }
  };

  const finishTurn = (): void => {
    drain("text", true);
    drain("reasoning", true);
    for (const channel of Object.values(channels)) channel.suppressed = false;
    calledTool = false;
  };

  const enter = (next: number): void => {
    if (next === turn) return;
    if (turn >= 0) finishTurn();
    turn = next;
  };

  return {
    delta(kind, next, delta) {
      enter(next);
      const channel = channels[kind];
      channel.buffer += delta;
      if (kind === "text" && !channel.suppressed) {
        const first = channel.buffer.trimStart()[0];
        if (first === "{" || first === "`") channel.suppressed = true;
      }
      if (kind === "text" && !calledTool && channel.buffer.trimStart() === "") return;
      drain(kind, false);
    },
    toolCall(next) {
      enter(next);
      calledTool = true;
    },
    turnEnd(next) {
      enter(next);
      finishTurn();
    },
    end() {
      if (turn >= 0) finishTurn();
      turn = -1;
    },
  };
}
