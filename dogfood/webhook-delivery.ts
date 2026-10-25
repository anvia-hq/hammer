import { createHmac } from "node:crypto";

export function verifyWebhookSignature(
  secret: string,
  payload: string,
  signature: string,
): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  return expected === signature;
}

export async function deliverWebhook(
  url: string,
  payload: string,
  maxRetries: number,
): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    if (response.ok) {
      return;
    }
  }
  throw new Error(`webhook delivery failed after ${maxRetries} attempts`);
}
