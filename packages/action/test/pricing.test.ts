import { describe, expect, it, vi } from "vitest";

import { fetchGatewayCatalog } from "../src/pricing";

const payload = {
  data: [{ id: "vendor/m", pricing: { prompt: "0.000001", completion: "0.000002" } }],
};

describe("fetchGatewayCatalog", () => {
  it("requests <base>/models with the api key and parses prices", async () => {
    const request = vi.fn(async () => Response.json(payload));
    const catalog = await fetchGatewayCatalog("https://gw.example/v1/", "key", request);
    expect(request).toHaveBeenCalledWith(
      "https://gw.example/v1/models",
      expect.objectContaining({ headers: { authorization: "Bearer key" } }),
    );
    expect(catalog).toEqual({ "vendor/m": { input: 1, output: 2 } });
  });

  it("returns an empty catalog on http errors, bad json and network failures", async () => {
    expect(
      await fetchGatewayCatalog(
        "https://gw.example",
        "k",
        async () => new Response("", { status: 500 }),
      ),
    ).toEqual({});
    expect(
      await fetchGatewayCatalog("https://gw.example", "k", async () => new Response("not json")),
    ).toEqual({});
    expect(
      await fetchGatewayCatalog("https://gw.example", "k", async () => {
        throw new Error("offline");
      }),
    ).toEqual({});
  });
});
