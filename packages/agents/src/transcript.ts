export interface TranscriptEntry {
  role: "assistant" | "tool";
  text: string;
}

export const TRANSCRIPT_ENTRY_LIMIT = 4_000;
export const TRANSCRIPT_CHAR_LIMIT = 120_000;

export function renderTranscript(entries: readonly TranscriptEntry[], limit: number): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const text =
      entry.text.length <= limit ? entry.text : `${entry.text.slice(0, limit)}\n[truncated]`;
    lines.push(entry.role === "assistant" ? `Assistant: ${text}` : `Tool result: ${text}`);
  }
  return lines.join("\n\n");
}

export function withTranscript(
  transcript: readonly TranscriptEntry[],
  prompt: string,
  entryLimit = TRANSCRIPT_ENTRY_LIMIT,
): string {
  if (transcript.length === 0) return prompt;
  const rendered = renderTranscript(transcript, entryLimit);
  const clipped =
    rendered.length <= TRANSCRIPT_CHAR_LIMIT
      ? rendered
      : `[earlier transcript truncated]\n${rendered.slice(rendered.length - TRANSCRIPT_CHAR_LIMIT)}`;
  return `## Earlier in this review\n\n<transcript>\n${clipped}\n</transcript>\n\n${prompt}`;
}
