import { defaultRepoConfig } from "./config";

export const SKIP_LABEL = "hammer:skip";
export const SKIP_TITLE_MARKER = "[skip review]";

export interface SkipSender {
  login: string;
  type?: string;
}

export interface SkipInput {
  labels: string[];
  title: string;
  authorLogin: string;
  sender: SkipSender;
  isMergeFromBase: boolean;
  remainingFileCount: number;
  ignoreAuthors?: string[];
}

export interface SkipResult {
  skip: boolean;
  reason?: string;
}

function isBot(login: string, type: string | undefined): boolean {
  return type === "Bot" || login.endsWith("[bot]");
}

export function decideSkip(input: SkipInput): SkipResult {
  if (input.labels.includes(SKIP_LABEL)) {
    return { skip: true, reason: `PR has the "${SKIP_LABEL}" label` };
  }
  // Case-sensitive substring on purpose: "[skip review]" is a deliberate opt-out
  // marker, and matching it exactly avoids skipping PRs that merely mention a skip.
  if (input.title.includes(SKIP_TITLE_MARKER)) {
    return { skip: true, reason: `PR title contains "${SKIP_TITLE_MARKER}"` };
  }
  const ignoreAuthors = input.ignoreAuthors ?? defaultRepoConfig().ignore_authors;
  if (ignoreAuthors.includes(input.authorLogin)) {
    return { skip: true, reason: `PR author "${input.authorLogin}" is in ignore_authors` };
  }
  if (isBot(input.sender.login, input.sender.type)) {
    return { skip: true, reason: `event sender "${input.sender.login}" is a bot` };
  }
  if (input.isMergeFromBase) {
    return { skip: true, reason: "push is a merge commit from the base branch" };
  }
  if (input.remainingFileCount === 0) {
    return { skip: true, reason: "no files remain after filtering" };
  }
  return { skip: false };
}
