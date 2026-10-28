import { withRetry } from "../a/retry";
import { TtlCache } from "./cache";

const cache = new TtlCache<string>(60_000);

export async function fetchText(url: string): Promise<string> {
  const hit = cache.get(url);
  if (hit !== undefined) return hit;
  const text = await withRetry(500, 3, async () => (await fetch(url)).text());
  cache.set(url, text);
  return text;
}
