import type { AgentObserver } from "@anvia/core/observability";

export type ObservabilityErrorCode = "invalid_endpoint";

export interface ResolveObservabilityInput {
  lensEndpoint?: string | null | undefined;
  otelEndpoint?: string | null | undefined;
}

export interface ObservabilityDisabled {
  enabled: false;
}

export interface ObservabilityEnabled {
  enabled: true;
  lensEndpoint?: string | undefined;
  otelEndpoint?: string | undefined;
}

export type ObservabilityConfig = ObservabilityDisabled | ObservabilityEnabled;

export type ResolveObservabilityResult =
  | { ok: true; config: ObservabilityConfig }
  | { ok: false; error: ObservabilityErrorCode; message: string };

export interface ObserverFactory {
  createLensObserver?: (endpoint: string) => AgentObserver;
  createOtelObserver?: (endpoint: string) => AgentObserver;
}

function normalizeEndpoint(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isLocalhostHostname(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  return lowered === "localhost" || lowered === "127.0.0.1" || lowered === "::1";
}

export function isValidObservabilityEndpoint(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:" && isLocalhostHostname(parsed.hostname)) return true;
  return false;
}

export function resolveObservability(
  input: ResolveObservabilityInput = {},
): ResolveObservabilityResult {
  const lensEndpoint = normalizeEndpoint(input.lensEndpoint);
  const otelEndpoint = normalizeEndpoint(input.otelEndpoint);
  if (lensEndpoint === undefined && otelEndpoint === undefined) {
    return { ok: true, config: { enabled: false } };
  }
  for (const endpoint of [lensEndpoint, otelEndpoint]) {
    if (endpoint !== undefined && !isValidObservabilityEndpoint(endpoint)) {
      return {
        ok: false,
        error: "invalid_endpoint",
        message: `Invalid observability endpoint ${JSON.stringify(endpoint)}: expected an https URL or http://localhost for local testing.`,
      };
    }
  }
  const config: ObservabilityEnabled = { enabled: true };
  if (lensEndpoint !== undefined) config.lensEndpoint = lensEndpoint;
  if (otelEndpoint !== undefined) config.otelEndpoint = otelEndpoint;
  return { ok: true, config };
}

export interface BuildObserversInput {
  config: ObservabilityConfig;
  factory: ObserverFactory;
}

export function buildObservers(input: BuildObserversInput): Record<string, AgentObserver> {
  if (!input.config.enabled) return {};
  const observers: Record<string, AgentObserver> = {};
  if (input.config.lensEndpoint !== undefined && input.factory.createLensObserver !== undefined) {
    observers["lens"] = input.factory.createLensObserver(input.config.lensEndpoint);
  }
  if (input.config.otelEndpoint !== undefined && input.factory.createOtelObserver !== undefined) {
    observers["otel"] = input.factory.createOtelObserver(input.config.otelEndpoint);
  }
  return observers;
}

// TODO(@anvia/lens, @anvia/otel): the real observer constructors are not
// wired here yet. `resolveObservability` validates the endpoints and
// `buildObservers` accepts an injected factory so the action can attach the
// published `LensClient(...).observer()` / `createOtelObserver(...)` without
// this module importing them directly.
export function traceUrlForRun(
  config: ObservabilityConfig,
  runId: string | null | undefined,
): string | undefined {
  if (!config.enabled) return undefined;
  if (config.lensEndpoint === undefined) return undefined;
  const trimmed = (runId ?? "").trim();
  if (trimmed === "") return undefined;
  const base = config.lensEndpoint.replace(/\/+$/, "");
  return `${base}/traces/${encodeURIComponent(trimmed)}`;
}
