import { z } from "zod";

export const PLATFORM_AUDIENCE = "hammer-platform";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// https is required. Plain http is allowed only for loopback, so the bundled smoke test can run the platform stub.
function secureOrLoopbackUrl(value: string): string {
  const url = new URL(z.url().parse(value));
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))
    return url.href;
  throw new Error("platform-url must use https");
}
const REQUEST_TIMEOUT_MS = 10_000;

const oidcSchema = z.object({ value: z.string().min(1) });
const tokenSchema = z.object({ token: z.string().min(1), botLogin: z.string().min(1) });
const errorSchema = z.object({ error: z.string(), installUrl: z.string().optional() });

export interface PlatformToken {
  token: string;
  login: string;
}

export type PlatformResult = { ok: true; value: PlatformToken } | { ok: false; reason: string };

export interface PlatformOptions {
  platformUrl: string;
  env: NodeJS.ProcessEnv;
  request: typeof globalThis.fetch;
  setSecret: (value: string) => void;
}

export async function requestPlatformToken(options: PlatformOptions): Promise<PlatformResult> {
  const { env, request } = options;
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return { ok: false, reason: "the workflow does not grant `id-token: write`" };
  }
  try {
    const endpoint = new URL("/api/token", secureOrLoopbackUrl(options.platformUrl));
    const oidcUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    oidcUrl.searchParams.set("audience", PLATFORM_AUDIENCE);
    const oidcResponse = await request(oidcUrl, {
      headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!oidcResponse.ok)
      return { ok: false, reason: `GitHub refused the OIDC request (${oidcResponse.status})` };
    const oidc = oidcSchema.parse(await oidcResponse.json());
    options.setSecret(oidc.value);
    const response = await request(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${oidc.value}` },
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
