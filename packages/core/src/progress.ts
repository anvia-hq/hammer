import { redactSecrets } from "./github/sanitize";

export type ReviewEvent =
  | { type: "plan"; files: number }
  | { type: "tool"; name: string; detail: string }
  | { type: "turn"; tokens: number; costUsd: number | null }
  | { type: "text"; kind: "text" | "reasoning"; text: string }
  | { type: "review_end"; ok: boolean; findings: number; error?: string }
  | { type: "verify_start"; findings: number }
  | { type: "verify_end"; kept: number; dropped: number }
  | { type: "done"; inline: number; notes: number };

export type ReviewEventSink = (event: ReviewEvent) => void;

const MAX_DETAIL_CHARS = 160;
const MAX_TEXT_CHARS = 400;

function oneLine(value: string, limit = MAX_DETAIL_CHARS): string {
  const flat = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : char;
  })
    .join("")
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
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
      return `[hammer] reviewing ${plural(event.files, "file")}`;
    case "tool": {
      const detail = oneLine(event.detail);
      return `[hammer] ${oneLine(event.name)}${detail ? ` ${detail}` : ""}`;
    }
    case "text": {
      const label = event.kind === "reasoning" ? "thinking" : "says";
      return `[hammer] ${label}: ${oneLine(redactSecrets(event.text), MAX_TEXT_CHARS)}`;
    }
    case "turn": {
      const cost = event.costUsd === null ? "" : `, $${event.costUsd.toFixed(4)}`;
      return `[hammer] model call done: ${event.tokens} tokens used so far${cost}`;
    }
    case "review_end":
      return event.ok
        ? `[hammer] review done, ${plural(event.findings, "finding")}`
        : `[hammer] review failed${event.error ? `: ${oneLine(event.error)}` : ""}`;
    case "verify_start":
      return `[hammer] verifying ${plural(event.findings, "finding")}`;
    case "verify_end":
      return `[hammer] verification kept ${event.kept}, dropped ${event.dropped}`;
    case "done":
      return `[hammer] review ready: ${plural(event.inline, "inline comment")}, ${plural(event.notes, "general note")}`;
  }
}

export type ProgressStatus = "pending" | "running" | "done" | "failed";

export interface ProgressStep {
  id: string;
  label: string;
  status: ProgressStatus;
  detail?: string;
}

export interface ProgressState {
  steps: ProgressStep[];
  runUrl?: string;
  lastSha?: string;
}

export interface InitialProgressOptions {
  files: number;
  verify: boolean;
  runUrl?: string | undefined;
  lastSha?: string | undefined;
}

export function initialProgress(options: InitialProgressOptions): ProgressState {
  const steps: ProgressStep[] = [
    { id: "checkout", label: "Check out the PR head", status: "running" },
    { id: "review", label: `Review ${plural(options.files, "file")}`, status: "pending" },
  ];
  if (options.verify) steps.push({ id: "verify", label: "Verify findings", status: "pending" });
  steps.push({ id: "post", label: "Post the review", status: "pending" });
  return {
    steps,
    ...(options.runUrl ? { runUrl: options.runUrl } : {}),
    ...(options.lastSha ? { lastSha: options.lastSha } : {}),
  };
}

function setStep(
  state: ProgressState,
  id: string,
  status: ProgressStatus,
  detail?: string,
): ProgressState {
  return {
    ...state,
    steps: state.steps.map((step) => {
      if (step.id !== id) return step;
      const { detail: _previous, ...rest } = step;
      return { ...rest, status, ...(detail ? { detail } : {}) };
    }),
  };
}

export function applyProgressEvent(state: ProgressState, event: ReviewEvent): ProgressState {
  switch (event.type) {
    case "plan":
      return setStep(setStep(state, "checkout", "done"), "review", "running");
    case "review_end":
      return setStep(
        state,
        "review",
        event.ok ? "done" : "failed",
        event.ok ? plural(event.findings, "finding") : "failed",
      );
    case "verify_start":
      return setStep(state, "verify", "running");
    case "verify_end":
      return setStep(state, "verify", "done", `kept ${event.kept}, dropped ${event.dropped}`);
    case "done":
      return setStep(state, "post", "running");
    default:
      return state;
  }
}

const STEP_MARK: Record<ProgressStatus, string> = {
  pending: "- [ ]",
  running: "- [ ] ⏳",
  done: "- [x]",
  failed: "- [ ] ❌",
};

export function renderProgressBody(state: ProgressState): string {
  const lines = [
    "<!-- hammer:summary -->",
    "### Hammer Review",
    "",
    `${PROGRESS_MARKER} This comment updates as work completes${state.runUrl ? ` ([live log](${state.runUrl}))` : ""}.`,
    "",
    ...state.steps.map(
      (step) => `${STEP_MARK[step.status]} ${step.label}${step.detail ? ` (${step.detail})` : ""}`,
    ),
  ];
  if (state.lastSha) lines.push("", `<!-- hammer:last-sha=${state.lastSha} -->`);
  return `${lines.join("\n")}\n`;
}

export const PROGRESS_MARKER = "Review in progress.";

export function isProgressBody(body: string | null | undefined): boolean {
  return body?.includes(PROGRESS_MARKER) === true;
}

export function renderInterruptedBody(options: {
  reason: string;
  lastSha?: string | undefined;
}): string {
  const lines = [
    "<!-- hammer:summary -->",
    "### Hammer Review",
    "",
    `The previous review did not finish, and this update was not reviewed: ${options.reason}.`,
  ];
  if (options.lastSha) {
    lines.push("", `Last reviewed commit: \`${options.lastSha.slice(0, 7)}\``);
    lines.push("", `<!-- hammer:last-sha=${options.lastSha} -->`);
  }
  return `${lines.join("\n")}\n`;
}
