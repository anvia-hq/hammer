import { describe, expect, it, vi } from "vitest";

import { requestPlatformToken } from "../src/platform";

const env = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token?api-version=2",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
};

function options(request: typeof globalThis.fetch, overrides: Partial<NodeJS.ProcessEnv> = {}) {
  const setSecret = vi.fn();
  return {
    setSecret,
    options: {
      platformUrl: "https://platform.example",
      env: { ...env, ...overrides },
      request,
      setSecret,
    },
  };
}

describe("requestPlatformToken", () => {
  it("exchanges the OIDC token for an app token and masks both", async () => {
    const request = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).startsWith("https://actions.example")
        ? Response.json({ value: "oidc-jwt" })
        : Response.json({ token: "ghs_app", botLogin: "anvia-hammer[bot]" }),
    );
    const { options: o, setSecret } = options(request as typeof globalThis.fetch);
    expect(await requestPlatformToken(o)).toEqual({
      ok: true,
      value: { token: "ghs_app", login: "anvia-hammer[bot]" },
    });
    const first = new URL(String(request.mock.calls[0]?.[0]));
    expect(first.searchParams.get("audience")).toBe("hammer-platform");
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: "Bearer request-token" },
    });
    expect(String(request.mock.calls[1]?.[0])).toBe("https://platform.example/api/token");
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: { authorization: "Bearer oidc-jwt" },
    });
    expect(setSecret).toHaveBeenCalledWith("oidc-jwt");
    expect(setSecret).toHaveBeenCalledWith("ghs_app");
  });

  it("reports a missing id-token permission without any request", async () => {
    const request = vi.fn();
    const { options: o } = options(request as unknown as typeof globalThis.fetch, {
      ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
    });
    const result = await requestPlatformToken(o);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("id-token") });
    expect(request).not.toHaveBeenCalled();
  });

  it("explains a missing app installation", async () => {
    const request = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith("https://actions.example")
        ? Response.json({ value: "oidc-jwt" })
        : Response.json(
            {
              error: "app_not_installed",
              installUrl: "https://github.com/apps/x/installations/new",
            },
            { status: 404 },
          ),
    );
    const result = await requestPlatformToken(options(request as typeof globalThis.fetch).options);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("not installed") });
  });

  it("never throws on http errors, bad bodies, network failures or a non-https platform", async () => {
    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(
      (await requestPlatformToken(options(failing as unknown as typeof globalThis.fetch).options))
        .ok,
    ).toBe(false);
    const garbage = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(
      (await requestPlatformToken(options(garbage as unknown as typeof globalThis.fetch).options))
        .ok,
    ).toBe(false);
    const request = vi.fn();
    const { options: o } = options(request as unknown as typeof globalThis.fetch);
    expect((await requestPlatformToken({ ...o, platformUrl: "http://insecure.example" })).ok).toBe(
      false,
    );
    expect(request).not.toHaveBeenCalled();
  });
  it("accepts plain http only for loopback, the local test stub", async () => {
    const request = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).startsWith("https://actions.example")
        ? Response.json({ value: "oidc-jwt" })
        : Response.json({ token: "ghs_app", botLogin: "anvia-hammer[bot]" }),
    );
    const { options: o } = options(request as typeof globalThis.fetch);
    expect((await requestPlatformToken({ ...o, platformUrl: "http://127.0.0.1:8080" })).ok).toBe(
      true,
    );
    expect(String(request.mock.calls[1]?.[0])).toBe("http://127.0.0.1:8080/api/token");
  });
});
