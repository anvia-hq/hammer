import { z } from "zod";

export const PLATFORM_AUDIENCE = "hammer-platform";
const REQUEST_TIMEOUT_MS = 10_000;

const oidcSchema = z.object({ value: z.string().min(1) });
const tokenSchema = z.object({ token: z.string().min(1), botLogin: z.string().min(1) });
const errorSchema = z.object({
  error: z.string(),
  installUrl: z.string().optional(),
  registerUrl: z.string().optional(),
});

export interface PlatformToken {
  token: string;
  login: string;
}

export type PlatformResult = { ok: true; value: PlatformToken } | { ok: false; reason: string };

export interface PlatformOptions {
  platformUrl: string;
  /** Per-repository key from the Hammer platform. When set, it replaces the OIDC exchange. */
  apiKey?: string | undefined;
  env: NodeJS.ProcessEnv;
  request: typeof globalThis.fetch;
  setSecret: (value: string) => void;
}

export async function requestPlatformToken(options: PlatformOptions): Promise<PlatformResult> {
  const { env, request } = options;
  if (
    !options.apiKey &&
    (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
  ) {
    return {
      ok: false,
      reason: "no `hammer-api-key` was given and the workflow does not grant `id-token: write`",
    };
  }
  try {
    const endpoint = new URL(
      "/api/token",
      z.url({ protocol: /^https$/ }).parse(options.platformUrl),
    );
    let credential = options.apiKey;
    if (!credential) {
      const oidcUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL as string);
      oidcUrl.searchParams.set("audience", PLATFORM_AUDIENCE);
      const oidcResponse = await request(oidcUrl, {
        headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!oidcResponse.ok)
        return { ok: false, reason: `GitHub refused the OIDC request (${oidcResponse.status})` };
      credential = oidcSchema.parse(await oidcResponse.json()).value;
      options.setSecret(credential);
    }
    const response = await request(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const failure = errorSchema.safeParse(body);
      if (failure.success && failure.data.error === "app_not_installed") {
        return {
          ok: false,
          reason: `the Hammer GitHub App is not installed on this repository (${failure.data.installUrl ?? "install it to post as the bot"})`,
        };
      }
      if (failure.success && failure.data.error === "not_registered") {
        return {
          ok: false,
          reason: `this repository is not registered with the Hammer platform (${failure.data.registerUrl ?? "register it to post as the bot"})`,
        };
      }
      if (options.apiKey && response.status === 401) {
        return {
          ok: false,
          reason: "the platform rejected `hammer-api-key`; regenerate it on the Hammer platform",
        };
      }
      return { ok: false, reason: `the platform answered ${response.status}` };
    }
    const minted = tokenSchema.parse(body);
    options.setSecret(minted.token);
    return { ok: true, value: { token: minted.token, login: minted.botLogin } };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
          ? `the platform request failed (${error.name})`
          : "the platform request failed",
    };
  }
}
