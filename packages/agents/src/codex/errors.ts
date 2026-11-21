export type CodexErrorCode = "authentication" | "timeout" | "missing_result" | "exit" | "execution";

export class CodexError extends Error {
  readonly code: CodexErrorCode;

  constructor(code: CodexErrorCode, message: string) {
    super(message);
    this.name = "CodexError";
    this.code = code;
  }
}

export function isCodexError(error: unknown): error is CodexError {
  return error instanceof CodexError;
}

const SETUP =
  'Run "codex login --device-auth" on your own machine, store the ~/.codex/auth.json it writes as the repository secret behind the codex-auth-json input, and let the Codex CLI refresh it in place.';

// Only Codex's own authentication wording counts; a bare "401" also appears in ordinary runtime
// errors (a stack trace at "a.ts:401"), and those must keep their own message.
const AUTH_PATTERN =
  /authentication failed|not logged in|no credentials|unauthorized|invalid bearer token|invalid_grant|auth\.json|please.{0,20}codex login|token (?:is )?(?:invalid|expired)|refresh token/i;

export function codexAuthenticationError(detail: string): CodexError {
  const reason = detail.replace(/[.\s]+$/, "").slice(0, 600);
  return new CodexError(
    "authentication",
    `Codex rejected the ChatGPT login${reason === "" ? "" : `: ${reason}`}. ${SETUP}`,
  );
}

export function codexTimeoutError(timeoutMs: number): CodexError {
  return new CodexError(
    "timeout",
    `Codex did not finish this turn within ${Math.round(timeoutMs / 1000)} seconds and was stopped.`,
  );
}

export function codexExitError(code: number, stderr: string): CodexError {
  const detail = stderr.trim().slice(-600);
  if (AUTH_PATTERN.test(detail)) return codexAuthenticationError(detail);
  return new CodexError(
    "exit",
    `Codex exited with code ${code}${detail === "" ? "." : `: ${detail}`}`,
  );
}

export function describeCodexFailure(message: string): CodexError {
  const detail = message.trim().slice(0, 600);
  if (AUTH_PATTERN.test(detail)) return codexAuthenticationError(detail);
  return new CodexError("execution", `Codex reported an error: ${detail}`);
}
