import { readFileSync } from "node:fs";

type JsonObject = Record<string, unknown>;

function load(name: string): JsonObject {
  const url = new URL(`${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as JsonObject;
}

function clone(value: JsonObject): JsonObject {
  return structuredClone(value);
}

export interface PullRequestEventPatch {
  action?: string;
  draft?: boolean;
  sender?: JsonObject;
}

export function pullRequestEvent(patch: PullRequestEventPatch = {}): JsonObject {
  const payload = clone(load("pull-request-opened"));
  payload.action = patch.action ?? "opened";
  const pullRequest = payload.pull_request as JsonObject;
  if (patch.draft !== undefined) {
    pullRequest.draft = patch.draft;
  }
  if (patch.sender) {
    payload.sender = patch.sender;
  }
  return payload;
}

export interface IssueCommentEventPatch {
  action?: string;
  body?: string | null;
  authorLogin?: string;
  authorType?: string;
  senderLogin?: string;
  senderType?: string;
  onPullRequest?: boolean;
}

export function issueCommentEvent(patch: IssueCommentEventPatch = {}): JsonObject {
  const payload = clone(load("issue-comment-created"));
  payload.action = patch.action ?? "created";
  const issue = payload.issue as JsonObject;
  const comment = payload.comment as JsonObject;
  const sender = payload.sender as JsonObject;

  if (patch.onPullRequest === false) {
    delete issue.pull_request;
  }
  if (patch.body !== undefined) {
    comment.body = patch.body;
  }
  comment.user = {
    ...(comment.user as JsonObject),
    login: patch.authorLogin ?? (comment.user as JsonObject).login,
    type: patch.authorType ?? (comment.user as JsonObject).type,
  };
  payload.sender = {
    ...sender,
    login: patch.senderLogin ?? sender.login,
    type: patch.senderType ?? sender.type,
  };
  return payload;
}
