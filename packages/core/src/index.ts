export const CORE_PACKAGE_NAME = "@anvia/hammer-core";

export type { SkipInput, SkipResult, SkipSender } from "./skip";
export { decideSkip, SKIP_LABEL, SKIP_TITLE_MARKER } from "./skip";

export type {
  FetchFilesPage,
  FetchPullFilesOptions,
  PullFileEntry,
  PullFileStatus,
} from "./github/files";
export { fetchPullFiles, MAX_PULL_FILES, PULL_FILES_PER_PAGE } from "./github/files";

export type {
  CreateIssueComment,
  ListedComment,
  ListCommentPage,
  RenderSummaryOptions,
  SkippedSummaryFile,
  SummaryScopeFile,
  UpdateComment,
  UpsertSummaryOptions,
  UpsertSummaryResult,
} from "./github/summary";
export {
  renderSummaryBody,
  sanitizeSummaryText,
  SUMMARY_MARKER,
  upsertSummaryComment,
} from "./github/summary";

export type { IncrementalScope, PatchHunk, PatchLine, ReviewScopeOptions } from "./github/patch";
export { commentableLines, decideReviewScope, extractLastSha, parsePatch } from "./github/patch";

export type { PlanOptions, ReviewPlan, SkippedPlanFile } from "./plan";
export { buildReviewPlan, isTestPath, matchesGlob } from "./plan";

export type {
  CommentRun,
  DecideEventOptions,
  EventDecision,
  GetCollaboratorPermission,
  PermissionQuery,
  PullRequestRun,
  PullRequestTriggerAction,
  SkipDecision,
} from "./event";
export { decideEvent, PULL_REQUEST_TRIGGER_ACTIONS } from "./event";
export type {
  ConfigInputOverrides,
  ConfigRule,
  EffectiveConfig,
  FailOn,
  LoadConfigOptions,
  PathInstruction,
  RepoConfig,
  Severity,
} from "./config";
export {
  ConfigError,
  DEFAULT_CAPS,
  DEFAULT_CONFIG_PATH,
  defaultRepoConfig,
  loadConfig,
  resolveConfig,
} from "./config";
