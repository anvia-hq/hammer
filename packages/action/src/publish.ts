import {
  fingerprints,
  formatInlineBody,
  postPullReview,
  renderReviewBody,
  renderSummaryBody,
  upsertSummaryComment,
  type Finding,
  type ReviewPlan,
  type RenderSummaryOptions,
} from "@anvia/hammer-core";
import type { ReviewPipelineResult } from "@anvia/hammer-agents";
import type { GitHubPort, IssueComment } from "./github";

export interface PublishTarget {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  repoUrl?: string;
}

export async function writeSummary(
  github: GitHubPort,
  target: PublishTarget,
  comments: IssueComment[],
  identity: string,
  options: RenderSummaryOptions,
  secrets: readonly string[] = [],
): Promise<void> {
  await upsertSummaryComment(
    async (page) =>
      page === 1 ? comments.filter((comment) => comment.user?.login === identity) : [],
    (body) => github.createSummary(target.owner, target.repo, target.number, body),
    (id, body) => github.updateSummary(target.owner, target.repo, id, body),
    renderSummaryBody(options),
    {
      perPage: comments.length + 1,
      sanitizeOptions: { owner: target.owner, repo: target.repo, secrets },
    },
  );
}

export async function publishReview(
  github: GitHubPort,
  target: PublishTarget,
  comments: IssueComment[],
  identity: string,
  plan: ReviewPlan,
  result: ReviewPipelineResult,
  model: string,
  secrets: readonly string[] = [],
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
  await writeSummary(
    github,
    target,
    comments,
    identity,
    {
      files: plan.reviewFiles.map((file) => ({
        path: file.filename,
        status: file.status,
        previousPath: file.previous_filename,
      })),
      skipped: plan.skippedFiles,
      notReviewed: plan.notReviewed,
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
    },
    secrets,
  );
  return { findings, reviewUrl, postedInline };
}
