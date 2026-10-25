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
export type {
  BatchValidationIssue,
  BatchValidationResult,
  Finding,
  RepairFailureCode,
  ReviewBatch,
  RunWithRepairOptions,
  RunWithRepairResult,
} from "./agent/schema";
export {
  buildRepairPrompt,
  FindingSchema,
  ReviewBatchSchema,
  runWithRepair,
  validateBatchOutput,
} from "./agent/schema";
export type {
  ModelClientOptions,
  ModelParseErrorCode,
  ModelParseIssue,
  ParsedModelRef,
  ParseModelOptions,
  ParseModelResult,
  SupportedModelProvider,
} from "./agent/model";
export {
  createAnthropicModel,
  createCompletionModel,
  createGeminiModel,
  createOpenAICompatibleModel,
  createOpenAIModel,
  parseModelRef,
  parseModelRefWithBase,
  SUPPORTED_MODEL_PROVIDERS,
} from "./agent/model";
export type {
  SinglePassErrorCode,
  SinglePassFailure,
  SinglePassResult,
  SinglePassRunInput,
  SinglePassRunOptions,
  SinglePassSuccess,
  SinglePassUsage,
} from "./agent/run";
export { buildReviewerTools, DEFAULT_SINGLE_PASS_TOKENS, runSinglePassReview } from "./agent/run";
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

export type {
  ActionOutputFinding,
  ActionOutputs,
  BuildActionOutputsInput,
  JobSummaryNotReviewedFile,
  JobSummarySkipped,
  RenderJobSummaryInput,
  WriteFileFn,
} from "./outputs";
export { buildActionOutputs, renderJobSummaryMarkdown, writeResultJson } from "./outputs";
export type {
  DecideExitCodeInput,
  DecideExitCodeResult,
  GateErrorCode,
  GateFailOn,
  GateFinding,
  GateSeverity,
} from "./gate";
export { decideExitCode } from "./gate";

export type {
  BatchRunEntry,
  BatchUsage,
  FileBatch,
  MergedBatches,
  PlanBatchesInput,
  PlanBatchesResult,
  RunBatchesInput,
  RunBatchesResult,
  RunBatchResult,
} from "./batching";
export {
  DEFAULT_BATCH_TOKENS,
  DEFAULT_MAX_CONCURRENT,
  mergeBatchResults,
  planBatches,
  runBatches,
} from "./batching";
export type {
  BatchGate,
  Budget,
  BudgetCapReason,
  BudgetSummary,
  BudgetUsageInput,
  CreateBudgetInput,
  PricingFn,
} from "./budget";
export { clampTurns, createBudget, DEFAULT_MAX_TURNS } from "./budget";
export type { SkipInput, SkipResult, SkipSender } from "./skip";
export { decideSkip, SKIP_LABEL, SKIP_TITLE_MARKER } from "./skip";
export type {
  BuildObserversInput,
  ObservabilityConfig,
  ObservabilityDisabled,
  ObservabilityEnabled,
  ObserverFactory,
  ObservabilityErrorCode,
  ResolveObservabilityInput,
  ResolveObservabilityResult,
} from "./observe";
export {
  buildObservers,
  isValidObservabilityEndpoint,
  resolveObservability,
  traceUrlForRun,
} from "./observe";

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

export type {
  CreateReviewFn,
  CreateReviewPayload,
  MovedToSummaryNote,
  PostPullReviewDeps,
  PostPullReviewInput,
  PostPullReviewResult,
  PostPullReviewSuccess,
  PullReviewInlineInput,
  ReviewApiComment,
  ReviewCommentEvent,
  ReviewPostErrorCode,
  ReviewPostFailure,
  SleepFn,
} from "./github/review";
export {
  assertCommentEvent,
  formatAnchoredNote,
  GENERIC_RETRY_SLEEPS_MS,
  postPullReview,
} from "./github/review";

export type { SanitizeCommentOptions } from "./github/sanitize";
export {
  MAX_COMMENT_CHARS,
  REDACTED,
  redactSecrets,
  sanitizeComment,
  sanitizeForPosting,
} from "./github/sanitize";
export type { DedupeFinding, FindingFingerprints, PriorFinding } from "./dedupe";
export {
  buildPriorFindingsContext,
  filterDuplicates,
  fingerprints,
  formatFingerprintComment,
  isDuplicate,
  MAX_PRIOR_FINDINGS_CHARS,
  parsePriorFingerprints,
} from "./dedupe";
export type { IncrementalScope, PatchHunk, PatchLine, ReviewScopeOptions } from "./github/patch";
export { commentableLines, decideReviewScope, extractLastSha, parsePatch } from "./github/patch";
export type {
  DecideIncrementalScopeOptions,
  IncrementalScopeDecision,
  IncrementalScopeReason,
} from "./github/scope";
export { decideIncrementalScope } from "./github/scope";

export type {
  GeneralNoteReason,
  ValidateDropped,
  ValidateDropReason,
  ValidatedInlineComment,
  ValidatedSingleComment,
  ValidateFindingsOptions,
  ValidateFindingsResult,
  ValidateGeneralNote,
} from "./validate";
export {
  DEFAULT_MAX_COMMENTS,
  DEFAULT_MIN_SEVERITY,
  MIN_FINDING_CONFIDENCE,
  validateFindings,
} from "./validate";

export type {
  ApplyVerificationInput,
  ApplyVerificationResult,
  BuildVerificationPromptInput,
  RunVerifierFn,
  VerificationResult,
  VerificationScore,
  VerifyDropped,
  VerifyDropReason,
  VerifyStatus,
} from "./verify";
export {
  applyVerification,
  buildVerificationPrompt,
  DEFAULT_VERIFY_MAX_RATIO,
  DEFAULT_VERIFY_THRESHOLD,
  MAX_VERIFICATION_SCORES,
  verificationId,
  VerificationResultSchema,
  VerificationScoreSchema,
  verifyCostOk,
} from "./verify";

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

export { runReviewPipeline } from "./pipeline";
export type { ReviewPipelineInput, ReviewPipelineResult } from "./pipeline";

export { resolvePricing } from "./pricing";
