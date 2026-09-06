import { describe, expect, test } from "bun:test";
import { runpod } from "../src/collectors/runpod";
import { observationSchema } from "../src/validation";

// Isolated test prices, not retained production quotes. The nullable inventory
// shape matches the bounded live B200/B300 pricing check on 2026-09-06.
const NOW = Date.parse("2026-09-06T21:55:18.451Z");
const offer = { stockStatus: "Low", uninterruptablePrice: 2.5, availableGpuCounts: [1, 2, 4] };
async function collect(patch: Record<string, unknown>, model = "B200") {
  const result = await runpod.collect({
    now: () => NOW, env: { RUNPOD_API_KEY: "isolated-runpod-test-key" },
    fetch: async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string).query).toBe("query { gpuTypes { id displayName secureCloud lowestPrice(input: { gpuCount: 1, secureCloud: true }) { stockStatus uninterruptablePrice availableGpuCounts } } }");
      return new Response(JSON.stringify({ data: { gpuTypes: [{ id: `NVIDIA ${model}`, secureCloud: true, lowestPrice: { ...offer, ...patch } }] } }), { headers: { "content-type": "application/json" } });
    },
    archive: async record => {
      expect(record.url).toBe("https://api.runpod.io/graphql");
    },
  });
  for (const observation of result.observations) observationSchema.parse(observation);
  return result;
}

describe("Runpod nullable inventory", () => {
  test.each(["B200", "B300"])("retains the live %s nullable-size shape as a list quote, not available inventory", async model => {
    const result = await collect({ availableGpuCounts: null }, model);
    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ model, price: "2.500000", instancePrice: "2.500000", gpuCount: 1,
      availability: "UNKNOWN", minimumOrderGpuCount: null, availableGpuCount: null,
      priceBasis: "LIST", priceScope: "PUBLIC", procurement: "ON_DEMAND", currency: "USD", unit: "USD_PER_GPU_HOUR", observedAt: NOW });
  });
  test.each(["High", "Medium", "Low", null])("stock case %# cannot supply missing deployment sizes", async stockStatus => {
    const result = await collect({ stockStatus, availableGpuCounts: null });
    expect(result.errors).toEqual([]);
    expect(result.observations[0]).toMatchObject({ availability: "UNKNOWN", minimumOrderGpuCount: null, availableGpuCount: null });
  });
  test("explicitly empty stock is unavailable even when sizes are unknown", async () => {
    const result = await collect({ stockStatus: "None", availableGpuCounts: null });
    expect(result.errors).toEqual([]);
    expect(result.observations[0]).toMatchObject({ availability: "UNAVAILABLE", minimumOrderGpuCount: null });
  });
  test("known one-GPU size with null stock remains unknown", async () => {
    const result = await collect({ stockStatus: null, availableGpuCounts: [1, 2] });
    expect(result.errors).toEqual([]);
    expect(result.observations[0]).toMatchObject({ availability: "UNKNOWN", minimumOrderGpuCount: 1, availableGpuCount: null });
  });
  test.each([{ availableGpuCounts: [] }, { availableGpuCounts: [8] }])("known ineligible sizes %# remain unavailable with null stock", async ({ availableGpuCounts }) => {
    const result = await collect({ stockStatus: null, availableGpuCounts });
    expect(result.errors).toEqual([]);
    expect(result.observations[0]).toMatchObject({ availability: "UNAVAILABLE", minimumOrderGpuCount: availableGpuCounts.length ? 8 : null });
  });
  test.each(["High", "Medium", "Low"])("known one-GPU size with %s stock remains available", async stockStatus => {
    const result = await collect({ stockStatus });
    expect(result.errors).toEqual([]);
    expect(result.observations[0]).toMatchObject({ availability: "AVAILABLE", minimumOrderGpuCount: 1, availableGpuCount: null });
  });
  test.each([undefined, "1", 1, true, {}, [null], [0], [-1], [1.5], ["1"], [1, null], [Number.MAX_SAFE_INTEGER + 1]].map(availableGpuCounts => ({ availableGpuCounts })))("rejects absent or malformed deployment sizes %#", async ({ availableGpuCounts }) => {
    const result = await collect({ availableGpuCounts });
    expect(result.observations).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toStartWith("INVALID_SCHEMA:");
  });
  test.each([undefined, "", "Unknown", "high", 1, true, {}, []].map(stockStatus => ({ stockStatus })))("rejects absent or malformed stock status %#", async ({ stockStatus }) => {
    const result = await collect({ stockStatus, availableGpuCounts: null });
    expect(result.observations).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toStartWith("INVALID_SCHEMA:");
  });
  test.each([0, -1, "not-a-price", "1.0000001"])("unknown inventory does not bypass price validation %#", async uninterruptablePrice => {
    const result = await collect({ uninterruptablePrice, availableGpuCounts: null });
    expect(result.observations).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toStartWith("INVALID_PRICE:");
  });
});
