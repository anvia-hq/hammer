export type ReviewEvent =
  | { type: "plan"; files: number; batches: number }
  | { type: "batch_start"; batch: string; files: number }
  | { type: "tool"; batch: string; name: string; detail: string }
  | { type: "turn"; tokens: number; costUsd: number | null }
  | { type: "batch_end"; batch: string; ok: boolean; findings: number; error?: string }
  | { type: "verify_start"; findings: number }
  | { type: "verify_end"; kept: number; dropped: number }
  | { type: "done"; inline: number; notes: number };

export type ReviewEventSink = (event: ReviewEvent) => void;

const MAX_DETAIL_CHARS = 160;

function oneLine(value: string): string {
  const flat = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : char;
  })
    .join("")
    .trim();
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS)}…` : flat;
}

function plural(count: number, word: string): string {
  if (count === 1) return `1 ${word}`;
  return `${count} ${word.endsWith("ch") ? `${word}es` : `${word}s`}`;
}

// Every line carries the "[hammer]" prefix so model- or PR-controlled text can never start a
// line with "::" and be read by the runner as a workflow command.
export function formatReviewEvent(event: ReviewEvent): string {
  switch (event.type) {
    case "plan":
      return `[hammer] reviewing ${plural(event.files, "file")} in ${plural(event.batches, "batch")}`;
    case "batch_start":
      return `[hammer] batch ${oneLine(event.batch)}: started, ${plural(event.files, "file")}`;
    case "tool": {
      const detail = oneLine(event.detail);
      return `[hammer] batch ${oneLine(event.batch)}: ${oneLine(event.name)}${detail ? ` ${detail}` : ""}`;
    }
    case "turn": {
      const cost = event.costUsd === null ? "" : `, $${event.costUsd.toFixed(4)}`;
      return `[hammer] model call done: ${event.tokens} tokens used so far${cost}`;
    }
    case "batch_end": {
      const batch = oneLine(event.batch);
      return event.ok
        ? `[hammer] batch ${batch}: done, ${plural(event.findings, "finding")}`
        : `[hammer] batch ${batch}: failed${event.error ? `: ${oneLine(event.error)}` : ""}`;
    }
    case "verify_start":
      return `[hammer] verifying ${plural(event.findings, "finding")}`;
    case "verify_end":
      return `[hammer] verification kept ${event.kept}, dropped ${event.dropped}`;
    case "done":
      return `[hammer] review ready: ${plural(event.inline, "inline comment")}, ${plural(event.notes, "general note")}`;
  }
}
