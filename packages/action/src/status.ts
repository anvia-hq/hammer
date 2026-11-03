import type { CommitStatusState, GitHubPort } from "./github";

export interface CommentStatus {
  set(state: CommitStatusState, description: string): Promise<void>;
}

const MAX_DESCRIPTION = 140;

export function createCommentStatus(options: {
  github: Pick<GitHubPort, "commitStatus">;
  owner: string;
  repo: string;
  sha: string;
  runUrl?: string;
  warn: (message: string) => void;
}): CommentStatus {
  let enabled = true;
  return {
    async set(state, description) {
      if (!enabled) return;
      try {
        await options.github.commitStatus(options.owner, options.repo, options.sha, {
          state,
          description: description.slice(0, MAX_DESCRIPTION),
          ...(options.runUrl ? { targetUrl: options.runUrl } : {}),
        });
      } catch {
        enabled = false;
        options.warn(
          "[hammer] Could not set a commit status for this comment-triggered review. Add `statuses: write` to the workflow permissions to show it in the PR checks.",
        );
      }
    },
  };
}
