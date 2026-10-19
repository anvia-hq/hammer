export const CORE_PACKAGE_NAME = "@anvia/hammer-core";

export type {
  BuildReviewPromptInput,
  PromptConfig,
  PromptGuidelines,
  ReviewPrompt,
} from "./agent/prompt";
export {
  approxTokens,
  buildReviewPrompt,
  CHARS_PER_TOKEN,
  MAX_GUIDANCE_TOKENS,
  MAX_HUNK_RENDER_LINES,
} from "./agent/prompt";
export type { AgentToolReason } from "./agent/tools";
export {
  getFileDiff,
  getPrDiscussion,
  listDir,
  MAX_DIR_ENTRIES,
  MAX_DISCUSSION_COMMENTS,
  MAX_SEARCH_HITS,
  MAX_SEARCH_LINE_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  readFile,
  search,
  truncateText,
} from "./agent/tools";
export type {
  DiscussionCommentInput,
  FileDiffResult,
  FileDiffSuccess,
  ListDirResult,
  ListDirSuccess,
  PrDiscussionInput,
  PrDiscussionResult,
  ReadFileResult,
  ReadFileSuccess,
  SearchHit,
  SearchResult,
  SearchSuccess,
  TruncatedText,
} from "./agent/tools";
export type { CheckoutPlanOptions, CheckoutResult, CheckoutStep, ExecFn } from "./checkout/git";
export {
  assertReadOnlySteps,
  CHECKOUT_ENV,
  checkoutArgs,
  checkoutSteps,
  fetchArgs,
  HOOKS_PATH,
  initArgs,
  remoteArgs,
  runCheckoutPlan,
} from "./checkout/git";
export type { PathGuardReason, PathGuardResult } from "./checkout/path-guard";
export {
  isDenylistedBasename,
  MAX_READABLE_FILE_BYTES,
  resolveInsideRoot,
} from "./checkout/path-guard";

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
