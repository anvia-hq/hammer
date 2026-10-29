export const PULL_REQUEST_TRIGGER_ACTIONS = [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
] as const;

export type PullRequestTriggerAction = (typeof PULL_REQUEST_TRIGGER_ACTIONS)[number];

const RUN_PERMISSIONS = new Set(["admin", "maintain", "write"]);

export type EventSkipReason =
  | "unsupported_event"
  | "invalid_payload"
  | "unsupported_action"
  | "not_a_pull_request"
  | "not_a_command"
  | "unsupported_command"
  | "draft_pull_request"
  | "bot_sender"
  | "missing_permission_check"
  | "permission_check_failed"
  | "insufficient_permission";

export interface PermissionQuery {
  owner: string;
  repo: string;
  username: string;
}

export type GetCollaboratorPermission = (query: PermissionQuery) => Promise<string>;

export interface PullRequestRun {
  run: true;
  kind: "pull_request";
  owner: string;
  repo: string;
  prNumber: number;
  action: PullRequestTriggerAction;
  headSha: string | null;
  log: string;
}

export interface CommentRun {
  run: true;
  kind: "comment";
  owner: string;
  repo: string;
  prNumber: number;
  username: string;
  command: string;
  log: string;
}

export interface SkipDecision {
  run: false;
  reason: EventSkipReason;
  message: string;
  log: string;
}

export type EventDecision = PullRequestRun | CommentRun | SkipDecision;

export interface DecideEventOptions {
  eventName: string;
  payload: unknown;
  reviewDrafts?: boolean;
  getPermission?: GetCollaboratorPermission;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function skip(reason: EventSkipReason, message: string): SkipDecision {
  return { run: false, reason, message, log: `[hammer] skip: ${message}` };
}

function isBot(login: unknown, type: unknown): boolean {
  if (type === "Bot") return true;
  return typeof login === "string" && login.endsWith("[bot]");
}

function isTriggerAction(action: string): action is PullRequestTriggerAction {
  return (PULL_REQUEST_TRIGGER_ACTIONS as readonly string[]).includes(action);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

interface RepositoryRef {
  owner: string;
  repo: string;
}

function readRepository(payload: Record<string, unknown>): RepositoryRef | null {
  const repository = payload.repository;
  if (!isRecord(repository)) return null;
  const owner = repository.owner;
  const name = repository.name;
  if (
    isRecord(owner) &&
    typeof owner.login === "string" &&
    owner.login !== "" &&
    typeof name === "string" &&
    name !== ""
  ) {
    return { owner: owner.login, repo: name };
  }
  const fullName = repository.full_name;
  if (typeof fullName === "string") {
    const slash = fullName.indexOf("/");
    if (slash > 0 && slash < fullName.length - 1) {
      return {
        owner: fullName.slice(0, slash),
        repo: fullName.slice(slash + 1),
      };
    }
  }
  return null;
}

interface Sender {
  login: string;
  type: unknown;
}

function readSender(payload: Record<string, unknown>): Sender | null {
  const sender = payload.sender;
  if (!isRecord(sender) || typeof sender.login !== "string") return null;
  return { login: sender.login, type: sender.type };
}

function decidePullRequest(payload: Record<string, unknown>, reviewDrafts: boolean): EventDecision {
  const rawAction = payload.action;
  if (typeof rawAction !== "string" || !isTriggerAction(rawAction)) {
    const label = typeof rawAction === "string" ? rawAction : "unknown";
    return skip("unsupported_action", `pull_request action "${label}" is not a review trigger`);
  }
  const pullRequest = payload.pull_request;
  if (!isRecord(pullRequest)) {
    return skip("invalid_payload", "pull_request payload has no pull_request object");
  }
  const prNumber = pullRequest.number;
  if (!isPositiveInt(prNumber)) {
    return skip("invalid_payload", "pull_request payload has no pull request number");
  }
  const repo = readRepository(payload);
  if (repo === null) {
    return skip("invalid_payload", "pull_request payload has no repository");
  }
  if (pullRequest.draft === true && !reviewDrafts) {
    return skip(
      "draft_pull_request",
      `pull request #${prNumber} is a draft and review_drafts is off`,
    );
  }
  const head = pullRequest.head;
  const headSha = isRecord(head) && typeof head.sha === "string" ? head.sha : null;
  return {
    run: true,
    kind: "pull_request",
    owner: repo.owner,
    repo: repo.repo,
    prNumber,
    action: rawAction,
    headSha,
    log: `[hammer] trigger: pull_request "${rawAction}" on ${repo.owner}/${repo.repo}#${prNumber}`,
  };
}

function readCommand(body: string): string | null {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("/hammer")) return null;
  const rest = trimmed.slice("/hammer".length);
  if (rest !== "") {
    const next = rest[0];
    if (next !== " " && next !== "\t" && next !== "\n" && next !== "\r") {
      return null;
    }
  }
  return (rest.split("\n")[0] ?? "").trim();
}

function commandWord(command: string): string {
  const end = command.search(/[ \t\n\r]/);
  return end === -1 ? command : command.slice(0, end);
}

async function decideComment(
  payload: Record<string, unknown>,
  getPermission: GetCollaboratorPermission | undefined,
): Promise<EventDecision> {
  const rawAction = payload.action;
  if (rawAction !== "created") {
    const label = typeof rawAction === "string" ? rawAction : "unknown";
    return skip("unsupported_action", `issue_comment action "${label}" is not a review trigger`);
  }
  const issue = payload.issue;
  if (!isRecord(issue)) {
    return skip("invalid_payload", "issue_comment payload has no issue");
  }
  if (!isRecord(issue.pull_request)) {
    return skip("not_a_pull_request", "issue_comment is not on a pull request");
  }
  const prNumber = issue.number;
  if (!isPositiveInt(prNumber)) {
    return skip("invalid_payload", "issue_comment payload has no pull request number");
  }
  const comment = payload.comment;
  if (!isRecord(comment) || typeof comment.body !== "string") {
    return skip("invalid_payload", "issue_comment payload has no comment body");
  }
  const commentUser = comment.user;
  const username =
    isRecord(commentUser) && typeof commentUser.login === "string" ? commentUser.login : null;
  if (username === null) {
    return skip("invalid_payload", "issue_comment payload has no comment author");
  }
  const sender = readSender(payload);
  const commenterType = isRecord(commentUser) ? commentUser.type : undefined;
  if (isBot(username, commenterType) || (sender !== null && isBot(sender.login, sender.type))) {
    return skip("bot_sender", `ignoring comment trigger from bot "${username}"`);
  }
  const command = readCommand(comment.body);
  if (command === null) {
    return skip("not_a_command", "comment does not start with /hammer");
  }
  const word = commandWord(command);
  if (word !== "" && word.toLowerCase() !== "review" && word.toLowerCase() !== "help") {
    return skip(
      "unsupported_command",
      `command "/hammer ${word}" is not supported; only "/hammer review" runs a review`,
    );
  }
  const repo = readRepository(payload);
  if (repo === null) {
    return skip("invalid_payload", "issue_comment payload has no repository");
  }
  if (getPermission === undefined) {
    return skip(
      "missing_permission_check",
      "comment trigger needs a permission check, but none was provided",
    );
  }
  let permission: string;
  try {
    permission = await getPermission({
      owner: repo.owner,
      repo: repo.repo,
      username,
    });
  } catch {
    return skip(
      "permission_check_failed",
      `could not verify permission for "${username}", ignoring comment trigger`,
    );
  }
  if (!RUN_PERMISSIONS.has(permission.trim().toLowerCase())) {
    return skip(
      "insufficient_permission",
      `"${username}" has "${permission}" permission, comment triggers need write access or higher`,
    );
  }
  return {
    run: true,
    kind: "comment",
    owner: repo.owner,
    repo: repo.repo,
    prNumber,
    username,
    command,
    log: `[hammer] trigger: comment by "${username}" on ${repo.owner}/${repo.repo}#${prNumber}`,
  };
}

export async function decideEvent(options: DecideEventOptions): Promise<EventDecision> {
  const { eventName, payload } = options;
  if (!isRecord(payload)) {
    return skip("invalid_payload", `unsupported payload for event "${eventName}"`);
  }
  if (eventName === "pull_request") {
    return decidePullRequest(payload, options.reviewDrafts ?? false);
  }
  if (eventName === "issue_comment") {
    return decideComment(payload, options.getPermission);
  }
  return skip("unsupported_event", `event "${eventName}" is not a review trigger`);
}
