import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CODEX_AUTH_FILE_NAME = "auth.json";
export const CODEX_HOME_DIRECTORY = "codex-home";

export class CodexAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAuthError";
  }
}

export interface CodexCredentials {
  tokens: Record<string, unknown>;
}

export const CODEX_TOKEN_FIELDS = ["access_token", "refresh_token", "id_token"] as const;

export function codexTokenValues(credentials: CodexCredentials): string[] {
  return CODEX_TOKEN_FIELDS.flatMap((name) => {
    const value = credentials.tokens[name];
    return typeof value === "string" && value !== "" ? [value] : [];
  });
}

const SETUP =
  'Run "codex login --device-auth" on your own machine, store the ~/.codex/auth.json it writes as the repository secret behind the codex-auth-json input, and let the Codex CLI refresh it in place.';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

// Codex reads the tokens Codex wrote; anything else in the file stays out of the document Hammer
// writes, so a pasted literal never lands on the runner beyond the three fields it needs.
export function parseCodexAuth(raw: string): CodexCredentials {
  const trimmed = raw.trim();
  if (trimmed === "") throw new CodexAuthError(`codex-auth-json is empty. ${SETUP}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new CodexAuthError(
      `codex-auth-json is not valid JSON. Paste the whole ~/.codex/auth.json file. ${SETUP}`,
    );
  }
  if (!isObject(parsed))
    throw new CodexAuthError(`codex-auth-json must be a JSON object. ${SETUP}`);
  const tokens = parsed["tokens"];
  if (!isObject(tokens))
    throw new CodexAuthError(
      `codex-auth-json has no "tokens" object, so it is not the file "codex login --device-auth" writes. ${SETUP}`,
    );
  const missing = CODEX_TOKEN_FIELDS.filter((name) => !nonEmpty(tokens[name]));
  if (missing.length > 0)
    throw new CodexAuthError(
      `codex-auth-json is missing ${missing.join(", ")} under "tokens". ${SETUP}`,
    );
  return { tokens };
}

export interface CodexHome {
  directory: string;
  authPath: string;
}

// Writes the session into CODEX_HOME under RUNNER_TEMP with mode 0600 before Codex starts, so the
// CLI can refresh the tokens in place without touching the runner's home directory. The directory
// lives inside the per-run review directory, which the post step removes.
export async function seedCodexHome(
  parent: string,
  credentials: CodexCredentials,
): Promise<CodexHome> {
  const directory = join(parent, CODEX_HOME_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const authPath = join(directory, CODEX_AUTH_FILE_NAME);
  await rm(authPath, { force: true });
  const document = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: credentials.tokens,
    last_refresh: new Date().toISOString(),
  };
  await writeFile(authPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await chmod(authPath, 0o600);
  return { directory, authPath };
}
