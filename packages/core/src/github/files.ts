export const PULL_FILES_PER_PAGE = 100;

export const MAX_PULL_FILES = 3000;

export type PullFileStatus =
  | "added"
  | "removed"
  | "modified"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

export interface PullFileEntry {
  sha: string;
  filename: string;
  status: PullFileStatus;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string | undefined;
  previous_filename?: string | undefined;
}

export type FetchFilesPage = (page: number, perPage: number) => Promise<PullFileEntry[]>;

export interface FetchPullFilesOptions {
  perPage?: number;
  maxFiles?: number;
}

export async function fetchPullFiles(
  fetchPage: FetchFilesPage,
  options: FetchPullFilesOptions = {},
): Promise<PullFileEntry[]> {
  const perPage = Math.max(1, Math.floor(options.perPage ?? PULL_FILES_PER_PAGE));
  const maxFiles = Math.max(0, Math.floor(options.maxFiles ?? MAX_PULL_FILES));
  const files: PullFileEntry[] = [];
  let page = 1;
  while (files.length < maxFiles) {
    const entries = await fetchPage(page, perPage);
    files.push(...entries.slice(0, maxFiles - files.length));
    if (entries.length < perPage) break;
    page += 1;
  }
  return files;
}
