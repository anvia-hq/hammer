import {
  fingerprints,
  formatInlineBody,
  postPullReview,
  renderReviewBody,
  renderSummaryBody,
  upsertSummaryComment,
  type Finding,
  type ReviewPlan,
} from "@anvia/hammer-core";
import type { ReviewPipelineResult } from "@anvia/hammer-agents";
import type { GitHubPort } from "./github";

export interface PublishTarget {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  repoUrl?: string;
  runUrl?: string;
}

export interface RunComment {
  write(body: string): Promise<void>;
}

export function createRunComment(
  github: GitHubPort,
  target: PublishTarget,
  secrets: readonly string[] = [],
  existingId?: number,
): RunComment {
  let id = existingId;
  return {
    async write(body) {
      const written = await upsertSummaryComment(
        id,
        (text) => github.createSummary(target.owner, target.repo, target.number, text),
        (commentId, text) => github.updateSummary(target.owner, target.repo, commentId, text),
        body,
        { sanitizeOptions: { owner: target.owner, repo: target.repo, secrets } },
      );
      id = written.id;
    },
  };
}

export async function publishReview(
  github: GitHubPort,
  target: PublishTarget,
  runComment: RunComment,
  plan: ReviewPlan,
  result: ReviewPipelineResult,
  model: string,
  secrets: readonly string[] = [],
  resolveFixed: () => Promise<number> = async () => 0,
): Promise<{ findings: Finding[]; reviewUrl: string; postedInline: number }> {
  const placed = [...result.inline, ...result.single];
  const notes = [...result.generalNotes];
  let reviewUrl = "";
  let postedInline = placed.length;
  if (placed.length) {
    const posted = await postPullReview(
      {
        owner: target.owner,
        repo: target.repo,
        pullNumber: target.number,
        commitId: target.headSha,
        body: renderReviewBody({
          findings: placed.map((entry) => entry.finding),
          changes: result.changes,
          summary: result.summary,
          model,
          runUrl: target.runUrl,
        }),
        inline: placed.map((entry) => {
          const finding = entry.finding;
          const suggestion = entry.suggestionKept ? finding.suggestion : undefined;
          return {
            path: finding.path,
            line: entry.line,
            ...(entry.startLine < entry.line ? { start_line: entry.startLine } : {}),
            body: formatInlineBody(finding, suggestion),
            fingerprints: fingerprints(finding.path, finding.body, finding.suggestion),
          };
        }),
      },
      {
        sanitizeOptions: { owner: target.owner, repo: target.repo, secrets },
        createReview: async (payload) => {
          reviewUrl = (await github.review(payload)).html_url;
        },
      },
    );
    if (!posted.ok) throw new Error(posted.message);
    postedInline -= posted.movedToSummary.length;
    for (const entry of posted.movedToSummary) {
      notes.push(`${entry.path}:${entry.line}: ${entry.body}`);
    }
  }
  const findings = result.findings;
  const resolvedThreads = await resolveFixed();
  await runComment.write(
    renderSummaryBody({
      files: plan.reviewFiles.map((file) => ({
        path: file.filename,
        status: file.status,
        previousPath: file.previous_filename,
      })),
      skipped: plan.skippedFiles,
      notReviewed: plan.notReviewed,
      ...(result.dropped.length > 0
        ? {
            filtered: result.dropped
              .filter(
                (entry) =>
                  entry.reason === "below_min_severity" || entry.reason === "low_confidence",
              )
              .map((entry) => ({
                path: `${entry.finding.path}:${entry.finding.line}`,
                reason: `${entry.reason === "below_min_severity" ? "below min severity" : "low confidence"}: ${entry.finding.title}`,
              })),
          }
        : {}),
      ...(result.duplicates > 0 ? { duplicates: result.duplicates } : {}),
      ...(resolvedThreads > 0 ? { resolvedThreads } : {}),
      ...(result.partial || plan.partial ? {} : { headSha: target.headSha }),
      ...(target.repoUrl !== undefined ? { repoUrl: target.repoUrl } : {}),
      findings,
      summary: result.summary,
      generalNotes: notes,
      model,
      tokens: result.usage.tokens,
      costUsd: result.usage.costUsd,
      partial: result.partial || plan.partial,
      unverified: result.unverified,
      ...(result.reviewError !== undefined
        ? {
            reviewError: result.reviewError,
            ...(result.finishReason !== undefined ? { finishReason: result.finishReason } : {}),
            ...(result.outputChars !== undefined ? { outputChars: result.outputChars } : {}),
            ...(result.repairAttempted === true ? { repairOutcome: "repair attempted" } : {}),
          }
        : {
            ...(result.finishReason !== undefined ? { finishReason: result.finishReason } : {}),
            ...(result.outputChars !== undefined ? { outputChars: result.outputChars } : {}),
            ...(result.reviewNote !== undefined ? { repairOutcome: result.reviewNote } : {}),
          }),
    }),
  );
  return { findings, reviewUrl, postedInline };
}
