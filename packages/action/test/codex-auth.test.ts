import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_AUTH_FILE_NAME,
  CodexAuthError,
  parseCodexAuth,
  seedCodexHome,
} from "../src/codex-auth";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function authJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "id-token-value",
      access_token: "access-token-value",
      refresh_token: "refresh-token-value",
      account_id: "account-1",
    },
    last_refresh: "2026-11-20T00:00:00Z",
    ...overrides,
  });
}

describe("codex device login credentials", () => {
  it("accepts the auth.json that codex login --device-auth writes and keeps every token field", () => {
    const credentials = parseCodexAuth(authJson());
    expect(credentials.tokens).toMatchObject({
      access_token: "access-token-value",
      refresh_token: "refresh-token-value",
      account_id: "account-1",
    });
  });

  it("rejects an empty input with the device login instruction", () => {
    expect(() => parseCodexAuth("  ")).toThrow(CodexAuthError);
    expect(() => parseCodexAuth("")).toThrow(/codex login --device-auth/);
    expect(() => parseCodexAuth("")).toThrow(/codex-auth-json is empty/);
  });

  it("rejects input that is not JSON", () => {
    expect(() => parseCodexAuth("access-token")).toThrow(/not valid JSON/);
    expect(() => parseCodexAuth("[1, 2]")).toThrow(/must be a JSON object/);
  });

  it("rejects a document without tokens, and one missing a token", () => {
    expect(() => parseCodexAuth(JSON.stringify({ auth_mode: "chatgpt" }))).toThrow(
      /no "tokens" object/,
    );
    expect(() =>
      parseCodexAuth(authJson({ tokens: { access_token: "a", refresh_token: "r" } })),
    ).toThrow(/missing id_token/);
    expect(() =>
      parseCodexAuth(authJson({ tokens: { access_token: "", refresh_token: "r", id_token: "i" } })),
    ).toThrow(/missing access_token/);
  });

  it("writes the session to CODEX_HOME under the run directory with mode 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "hammer-codex-auth-"));
    roots.push(root);
    const home = await seedCodexHome(root, parseCodexAuth(authJson()));
    expect(home.directory).toBe(join(root, "codex-home"));
    expect(home.authPath).toBe(join(root, "codex-home", CODEX_AUTH_FILE_NAME));
    const mode = (await stat(home.authPath)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect((await stat(home.directory)).mode & 0o777).toBe(0o700);
    const written = JSON.parse(await readFile(home.authPath, "utf8")) as Record<string, unknown>;
    expect(written).toMatchObject({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { access_token: "access-token-value", refresh_token: "refresh-token-value" },
    });
    expect(typeof written["last_refresh"]).toBe("string");
  });

  it("rewrites an existing auth.json instead of keeping stale tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "hammer-codex-auth-"));
    roots.push(root);
    const first = await seedCodexHome(root, parseCodexAuth(authJson()));
    const second = await seedCodexHome(
      root,
      parseCodexAuth(
        authJson({ tokens: { access_token: "new", refresh_token: "r", id_token: "i" } }),
      ),
    );
    expect(second.authPath).toBe(first.authPath);
    const written = JSON.parse(await readFile(second.authPath, "utf8")) as {
      tokens: { access_token: string };
    };
    expect(written.tokens.access_token).toBe("new");
  });
});
