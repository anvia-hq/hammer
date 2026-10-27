import { parseGatewayCatalog, type PriceCatalog } from "@anvia/hammer-core";

const GATEWAY_TIMEOUT_MS = 5_000;

export async function fetchGatewayCatalog(
  baseUrl: string,
  apiKey: string,
  request: typeof globalThis.fetch = fetch,
): Promise<PriceCatalog> {
  try {
    const response = await request(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    if (!response.ok) return {};
    return parseGatewayCatalog(await response.json());
  } catch {
    return {};
  }
}
