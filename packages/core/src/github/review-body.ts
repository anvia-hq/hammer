import type { Finding } from "../schema";

export const SEVERITY_ICON: Record<Finding["severity"], string> = {
  high: "🔴",
  medium: "🟡",
  low: "🔵",
};

const SEVERITY_ALERT: Record<Finding["severity"], string> = {
  high: "CAUTION",
  medium: "WARNING",
  low: "NOTE",
};

export interface ReviewBodyInput {
  findings: readonly Finding[];
  changes?: readonly string[];
  summary?: string | undefined;
  model?: string | undefined;
  runUrl?: string | undefined;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function closeOpenFence(text: string): string {
  const fences = text.match(/^```/gm)?.length ?? 0;
  return fences % 2 === 0 ? text : `${text}\n\`\`\``;
}

export function formatInlineBody(finding: Finding, suggestion?: string): string {
  const severity = `${finding.severity[0]?.toUpperCase() ?? ""}${finding.severity.slice(1)}`;
  const attribution = finding.ruleId ? `Rule: \`${finding.ruleId}\` · Hammer` : "Hammer";
  const suggestionBlock =
    suggestion === undefined
      ? ""
      : `\n\n\`\`\`suggestion\n${suggestion.replace(/```/g, "ˋˋˋ")}\n\`\`\``;
  const details = finding.details?.trim();
  const detailsBlock = details
    ? `\n\n<details>\n<summary>Technical details</summary>\n\n${closeOpenFence(details)}\n\n</details>`
    : "";
  return `> [!${SEVERITY_ALERT[finding.severity]}]\n> **${severity} · ${finding.category}** — ${finding.title}\n\n${finding.body}${suggestionBlock}${detailsBlock}\n\n<sub>${attribution}</sub>`;
}

export function renderReviewBody(input: ReviewBodyInput): string {
  const count = (severity: Finding["severity"]): number =>
    input.findings.filter((finding) => finding.severity === severity).length;
  const high = count("high");
  const medium = count("medium");
  const low = count("low");
  const callout =
    high > 0
      ? `> [!CAUTION]\n> ${plural(high, "high-severity finding")}, fix before merging.`
      : medium > 0
        ? `> [!IMPORTANT]\n> ${plural(medium, "medium-severity finding")} worth addressing before merging.`
        : `> ℹ️ No critical issues — ${plural(low, "minor suggestion")} inline.`;
  const blocks = [callout];
  const changes = (input.changes ?? [])
    .map((change) => change.replace(/\s+/g, " ").trim())
    .filter((change) => change !== "");
  const intro = input.summary?.replace(/\s+/g, " ").trim() ?? "";
  if (changes.length > 0 || intro !== "") {
    blocks.push(
      [
        "**Reviewed changes**",
        ...(intro !== "" ? ["", intro] : []),
        ...(changes.length > 0 ? ["", ...changes.map((change) => `- ${change}`)] : []),
      ].join("\n"),
    );
  }
  const counts = (["high", "medium", "low"] as const)
    .map((severity) => (count(severity) > 0 ? `${count(severity)} ${severity}` : ""))
    .filter((part) => part !== "")
    .join(", ");
  const footer = ["🔨 **Hammer**", `${plural(input.findings.length, "finding")} (${counts})`];
  if (input.runUrl) footer.push(`[View workflow run](${input.runUrl})`);
  if (input.model) footer.push(`Using \`${input.model.replace(/`/g, "")}\``);
  blocks.push(footer.join(" | "));
  return blocks.join("\n\n");
}
