import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createCollectors, collectorCatalog } from "../src/collectors/index";
import { ORACLE_PARTS } from "../src/collectors/oracle";
import { blackwellModel } from "../src/collectors/models";
import { jsonRequest } from "../src/collectors/http";
import type { CollectorContext, EvidenceRecord } from "../src/types";
import { observationSchema } from "../src/validation";

const NOW = Date.parse("2026-09-06T12:00:00Z");
function context(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>, env: Record<string, string> = {}) {
  const evidence: EvidenceRecord[] = [];
  const requests: URL[] = [];
  const ctx: CollectorContext = {
    now: () => NOW, env,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push(url); return handler(url, init);
    }) as typeof fetch,
    archive: async record => { evidence.push(record); },
  };
  return { ctx, evidence, requests };
}
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
async function collect(id: string, ctx: CollectorContext) {
  const result = await createCollectors([id])[0]!.collect(ctx);
  for (const observation of result.observations) observationSchema.parse(observation);
  return result;
}

describe("public pricing collectors", () => {
  test("Oracle normalizes captured per-GPU rates exactly once and archives original bytes", async () => {
    const prices: Record<string, number> = { B110978: 14, B112237: 15, B110979: 16, B112140: 18 };
    const { ctx, evidence, requests } = context(url => json({ lastUpdated: "2026-09-01T14:26:53.943Z", items: [{ partNumber: url.searchParams.get("partNumber"), metricName: "GPU Per Hour", currencyCodeLocalizations: [{ currencyCode: "USD", prices: [{ model: "PAY_AS_YOU_GO", value: prices[url.searchParams.get("partNumber")!] }] }] }] }));
    const result = await collect("oracle-public", ctx);
    expect(result.errors).toEqual([]);
    expect(result.observations.map(x => [x.model, x.price, x.instancePrice, x.gpuCount])).toEqual([
      ["B200", "14.000000", "112.000000", 8], ["B300", "15.000000", "120.000000", 8],
      ["GB200", "16.000000", "64.000000", 4], ["GB300", "18.000000", "72.000000", 4],
    ]);
    expect(requests).toHaveLength(4);
    expect(evidence).toHaveLength(4);
    for (const record of evidence) expect(record.hash).toBe(createHash("sha256").update(record.body).digest("hex"));
    expect(result.observations.every(x => x.priceBasis === "LIST" && x.availableGpuCount === null && x.priceEffectiveAt === null)).toBe(true);
  });
  test("Oracle missing products, wrong units and absent prices never become zero rates", async () => {
    const { ctx } = context(url => json({ items: url.searchParams.get("partNumber") === ORACLE_PARTS[0]!.part ? [{ partNumber: ORACLE_PARTS[0]!.part, metricName: "Instance Per Hour" }] : [] }));
    const result = await collect("oracle-public", ctx);
    expect(result.observations).toEqual([]);
    expect(result.errors).toHaveLength(4);
    expect(result.errors[0]).toContain("UNSUPPORTED_UNIT");
  });
  test("Oracle stops immediately on HTTP 429 without parsing non-JSON response", async () => {
    const { ctx, requests, evidence } = context(() => new Response("Too many requests", { status: 429, headers: { "Retry-After": "60" } }));
    const result = await collect("oracle-public", ctx);
    expect(result.errors).toEqual(["RATE_LIMITED: oracle-public HTTP 429; Retry-After=60"]);
    expect(requests).toHaveLength(1);
    expect(evidence).toHaveLength(0);
  });

  const azureRow = {
    armSkuName: "Standard_ND128isr_NDR_GB200_v6", productName: "Virtual Machines NDsrGB200NDRv6 Series",
    meterName: "ND128isrNDRGB200v6", meterId: "test-meter", retailPrice: 108.16, currencyCode: "USD", type: "Consumption",
    isPrimaryMeterRegion: true, tierMinimumUnits: 0, unitOfMeasure: "1 Hour", armRegionName: "westus3", effectiveStartDate: "2025-04-01T00:00:00Z",
  };
  test("Azure follows each page and preserves spot vs regular prices and old effective dates", async () => {
    const { ctx, requests } = context(url => url.searchParams.has("$skip") ? json({ Items: [{ ...azureRow, meterName: `${azureRow.meterName} Spot`, meterId: "test-spot", retailPrice: 40 }], NextPageLink: null }) : json({ Items: [azureRow, { ...azureRow, productName: `${azureRow.productName} Windows` }, { ...azureRow, type: "DevTestConsumption" }], NextPageLink: "https://prices.azure.com:443/api/retail/prices?$skip=1000" }));
    const result = await collect("azure-retail", ctx);
    expect(result.errors).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(result.observations.map(x => [x.model, x.procurement, x.price])).toEqual([["GB200", "ON_DEMAND", "27.040000"], ["GB200", "SPOT", "10.000000"]]);
    expect(result.observations[0]!.observedAt).toBe(NOW);
    expect(result.observations[0]!.priceEffectiveAt).toBe(Date.parse("2025-04-01T00:00:00Z"));
  });
  test("Azure rejects external pagination and discards incomplete result sets", async () => {
    const { ctx, requests } = context(() => json({ Items: [azureRow], NextPageLink: "http://127.0.0.1/secrets" }));
    const result = await collect("azure-retail", ctx);
    expect(result.observations).toEqual([]);
    expect(result.errors[0]).toContain("INVALID_PAGINATION");
    expect(requests).toHaveLength(1);
  });
  test("Azure refuses unsupported units and unmatched SKU substitution", async () => {
    const { ctx } = context(() => json({ Items: [{ ...azureRow, armSkuName: "Unknown_GB200_4x" }, { ...azureRow, unitOfMeasure: "1 Month" }], NextPageLink: null }));
    const result = await collect("azure-retail", ctx);
    expect(result.observations).toEqual([]);
    expect(result.errors[0]).toContain("UNSUPPORTED_UNIT");
  });
  test("Azure empty data is an explicit missing feed", async () => {
    const { ctx } = context(() => json({ Items: [], NextPageLink: null }));
    expect((await collect("azure-retail", ctx)).errors[0]).toContain("NO_DATA");
  });
});

describe("authenticated pricing collectors", () => {
  test("missing keys make no HTTP calls", async () => {
    const { ctx, requests } = context(() => { throw new Error("must not fetch"); });
    for (const id of ["lambda-cloud", "runpod-secure", "vast-offers", "google-billing", "aws-pricing"]) {
      const result = await collect(id, ctx);
      expect(result.observations).toEqual([]); expect(result.errors[0]).toContain("NO_KEY");
    }
    expect(requests).toHaveLength(0);
  });
  test("Lambda converts instance cents and reports capacity without inventing fleet size", async () => {
    const { ctx } = context((_url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer unit-test-key");
      return json({ data: { gpu_8x_b200: { instance_type: { name: "gpu_8x_b200", gpu_description: "NVIDIA B200 SXM6", price_cents_per_hour: 5352, specs: { gpus: 8 } }, regions_with_capacity_available: [{ name: "us-west-1" }] } } });
    }, { LAMBDA_API_KEY: "unit-test-key" });
    const result = await collect("lambda-cloud", ctx);
    expect(result.errors).toEqual([]);
    expect(result.observations[0]).toMatchObject({ price: "6.690000", instancePrice: "53.520000", gpuCount: 8, availableGpuCount: null, availability: "AVAILABLE" });
  });
  test("Runpod keeps API keys out of observation and evidence URLs", async () => {
    const { ctx, evidence } = context(url => {
      expect(url.searchParams.get("api_key")).toBe("unit-test-secret");
      return json({ data: { gpuTypes: [{ id: "NVIDIA B200", secureCloud: true, lowestPrice: { stockStatus: "High", uninterruptablePrice: 5.89, availableGpuCounts: [1, 2, 4] } }] } });
    }, { RUNPOD_API_KEY: "unit-test-secret" });
    const result = await collect("runpod-secure", ctx);
    expect(result.errors).toEqual([]);
    expect(result.observations[0]!.price).toBe("5.890000");
    expect(result.observations[0]!.availableGpuCount).toBeNull();
    expect(JSON.stringify(result)).not.toContain("unit-test-secret");
    expect(evidence[0]!.url).toBe("https://api.runpod.io/graphql");
  });
  test("Runpod does not turn minimum multi-GPU inventory into one available GPU", async () => {
    const { ctx } = context(() => json({ data: { gpuTypes: [{ id: "NVIDIA B300", secureCloud: true, lowestPrice: { stockStatus: "Low", uninterruptablePrice: 7.39, availableGpuCounts: [8] } }] } }), { RUNPOD_API_KEY: "test" });
    expect((await collect("runpod-secure", ctx)).observations[0]).toMatchObject({ availability: "UNAVAILABLE", minimumOrderGpuCount: 8 });
  });
  test("Vast rejects fractional/unverified offers and deduplicates source offer ids", async () => {
    const offer = { id: 1, gpu_name: "B200", rentable: true, rented: false, is_bid: false, verification: "verified", num_gpus: 8, gpu_frac: 1, dph_total: 24, machine_id: 2, host_id: 3, geolocation: "Virginia, US" };
    const { ctx } = context(() => json({ offers: [offer, offer, { ...offer, id: 4, gpu_frac: 0.5 }, { ...offer, id: 5, verification: "unverified" }] }), { VAST_API_KEY: "test" });
    const result = await collect("vast-offers", ctx);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ price: "3.000000", availableGpuCount: 8, sourceRecordId: "host:3:offer:1" });
    expect(result.errors[0]).toContain("UNVERIFIED_TENANCY");
  });
});

describe("AWS official SDK transport", () => {
  function pricingRequest(init?: RequestInit) {
    const body = typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as Uint8Array);
    return JSON.parse(body) as { Filters: { Field: string; Value: string }[]; NextToken?: string };
  }
  function awsContext(gpuCount = "8") {
    return context((_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
      expect(headers.get("x-amz-security-token")).toBe("unit-test-session-token");
      const body = pricingRequest(init);
      const sku = body.Filters.find(filter => filter.Field === "instanceType")!.Value;
      if (sku !== "p6-b200.48xlarge") return json({ PriceList: [] });
      return json({ PriceList: [JSON.stringify({ product: { sku: "test-product", attributes: { instanceType: sku, operatingSystem: "Linux", tenancy: "Shared", preInstalledSw: "NA", gpu: gpuCount, regionCode: "us-east-1", marketoption: "CapacityBlock" } }, terms: { OnDemand: { "test-term": { effectiveDate: "2026-01-01T00:00:00Z", priceDimensions: { "test-rate": { unit: "Hrs", beginRange: "0", endRange: "Inf", description: "Capacity Block reservation", pricePerUnit: { USD: "98.8400000000" } } } } } } })] });
    }, { AWS_ACCESS_KEY_ID: "unit-test-access-key", AWS_SECRET_ACCESS_KEY: "unit-test-secret-key", AWS_SESSION_TOKEN: "unit-test-session-token" });
  }
  test("signs read-only requests, archives raw response, preserves capacity-block terms", async () => {
    const { ctx, evidence } = awsContext();
    const result = await collect("aws-pricing", ctx);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ model: "B200", price: "12.355000", instancePrice: "98.840000", procurement: "CAPACITY_BLOCK", availability: "UNKNOWN" });
    expect(result.errors).toHaveLength(4);
    expect(result.errors.every(error => error.startsWith("NO_DATA"))).toBe(true);
    expect(evidence).toHaveLength(5);
    expect(JSON.stringify(result)).not.toContain("unit-test-secret");
    expect(JSON.stringify(evidence.map(x => ({ url: x.url, body: new TextDecoder().decode(x.body) })))).not.toContain("unit-test-session-token");
  });
  test("rejects changed accelerator count instead of publishing incorrect normalization", async () => {
    const { ctx } = awsContext("4");
    const result = await collect("aws-pricing", ctx);
    expect(result.observations).toEqual([]);
    expect(result.errors[0]).toContain("HARDWARE_MISMATCH");
  });
  test("archives every GB300 discovery page without inventing its physical GPU denominator", async () => {
    const { ctx, evidence, requests } = context((_url, init) => {
      const request = pricingRequest(init), sku = request.Filters.find(filter => filter.Field === "instanceType")!.Value;
      if (!sku.startsWith("p6e-gb300.")) return json({ PriceList: [] });
      return json({ PriceList: [JSON.stringify({ product: { sku: `test-gb300-${request.NextToken ?? "first"}`, attributes: {
        instanceType: sku, operatingSystem: "Linux", tenancy: "Shared", preInstalledSw: "NA", gpu: request.NextToken ? "72" : "4",
      } } })], ...(request.NextToken ? {} : { NextToken: "second-page" }) });
    }, { AWS_ACCESS_KEY_ID: "unit-test-access-key", AWS_SECRET_ACCESS_KEY: "unit-test-secret-key" });
    const result = await collect("aws-pricing", ctx);
    expect(result.observations).toEqual([]);
    expect(result.errors.filter(error => error.startsWith("HARDWARE_METADATA_REQUIRED"))).toHaveLength(2);
    expect(evidence).toHaveLength(7); expect(requests).toHaveLength(7);
    expect(evidence.every(record => record.hash === createHash("sha256").update(record.body).digest("hex"))).toBe(true);
  });
  test("GB300 discovery stops on a throttled later page without claiming complete discovery", async () => {
    const { ctx, evidence, requests } = context((_url, init) => {
      const request = pricingRequest(init), sku = request.Filters.find(filter => filter.Field === "instanceType")!.Value;
      if (!sku.startsWith("p6e-gb300.")) return json({ PriceList: [] });
      if (request.NextToken) return new Response("private provider error details", { status: 429, headers: { "retry-after": "60" } });
      return json({ PriceList: [JSON.stringify({ product: { sku: "test-gb300-product", attributes: { instanceType: sku,
        operatingSystem: "Linux", tenancy: "Shared", preInstalledSw: "NA", gpu: "4" } } })], NextToken: "second-page" });
    }, { AWS_ACCESS_KEY_ID: "unit-test-access-key", AWS_SECRET_ACCESS_KEY: "unit-test-secret-key" });
    const result = await collect("aws-pricing", ctx);
    expect(result.observations).toEqual([]); expect(result.errors.at(-1)).toContain("RATE_LIMITED");
    expect(result.errors.some(error => error.startsWith("HARDWARE_METADATA_REQUIRED"))).toBe(false);
    expect(requests).toHaveLength(5); expect(evidence).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain("private provider error details");
  });
  test("SDK transport failures never expose credential-bearing exception messages", async () => {
    const { ctx, evidence } = context(() => { throw new Error("unit-test-secret-key unit-test-session-token"); }, {
      AWS_ACCESS_KEY_ID: "unit-test-access-key", AWS_SECRET_ACCESS_KEY: "unit-test-secret-key", AWS_SESSION_TOKEN: "unit-test-session-token",
    });
    const result = await collect("aws-pricing", ctx);
    expect(result.observations).toEqual([]); expect(evidence).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every(error => error === "COLLECTION_FAILED: aws-pricing")).toBe(true);
  });
});

describe("Google billing composition", () => {
  const mapping = { model: "B200", sku: "a4-highgpu-8g", gpuCount: 8, region: "us-central1", procurement: "ON_DEMAND", includes: ["gpu", "cpu"], components: [
    { skuId: "test-gpu", quantity: 8, usageUnit: "h", usageType: "OnDemand" },
    { skuId: "test-cpu", quantity: 224, usageUnit: "h", usageType: "OnDemand" },
  ] };
  const sku = (id: string, units: string, nanos: number) => ({ skuId: id, category: { usageType: "OnDemand" }, serviceRegions: ["us-central1"], pricingInfo: [{ effectiveTime: "2026-01-01T00:00:00Z", pricingExpression: { usageUnit: "h", tieredRates: [{ startUsageAmount: 0, unitPrice: { currencyCode: "USD", units, nanos } }] } }] });
  function googleContext(map: unknown = [mapping], missingCpu = false) {
    return context(url => {
      if (url.pathname === "/v1/services") return json({ services: [{ displayName: "Compute Engine", name: "services/TEST-COMPUTE" }] });
      if (url.searchParams.get("pageToken") === "second") return json({ skus: missingCpu ? [] : [sku("test-cpu", "0", 40_000_000)] });
      return json({ skus: [sku("test-gpu", "5", 500_000_000)], nextPageToken: "second" });
    }, { GOOGLE_CLOUD_BILLING_API_KEY: "unit-test-google-secret", ...(map ? { GOOGLE_BILLING_SKU_MAP_JSON: JSON.stringify(map) } : {}) });
  }
  test("composes all documented instance components and links every raw response", async () => {
    const { ctx, evidence } = googleContext();
    const result = await collect("google-billing", ctx);
    expect(result.errors).toEqual([]);
    expect(result.observations[0]).toMatchObject({ instancePrice: "52.960000", price: "6.620000", gpuCount: 8, availability: "UNKNOWN" });
    expect(evidence).toHaveLength(4);
    const receipt = JSON.parse(new TextDecoder().decode(evidence[3]!.body));
    expect(receipt.type).toBe("GOOGLE_BILLING_COMPOSITION_V1");
    expect(receipt.components.map((x: { responseHash: string }) => x.responseHash)).toEqual([evidence[1]!.hash, evidence[2]!.hash]);
    expect(evidence.every(x => !x.url.includes("unit-test-google-secret"))).toBe(true);
  });
  test("catalog discovery without a reviewed map produces evidence and no assumed GPU price", async () => {
    const { ctx, evidence } = googleContext(null);
    const result = await collect("google-billing", ctx);
    expect(result.observations).toEqual([]);
    expect(result.errors[0]).toContain("NO_MAPPING");
    expect(evidence).toHaveLength(3);
  });
  test("an absent component prevents publishing a partial bundle", async () => {
    const { ctx } = googleContext([mapping], true);
    const result = await collect("google-billing", ctx);
    expect(result.observations).toEqual([]);
    expect(result.errors[0]).toContain("NO_DATA");
  });
  test("a model/count mismatch fails before network access", async () => {
    const { ctx, requests } = googleContext([{ ...mapping, model: "B300" }]);
    const result = await collect("google-billing", ctx);
    expect(result.observations).toEqual([]);
    expect(result.errors[0]).toContain("INVALID_MAPPING");
    expect(requests).toHaveLength(0);
  });
});

test("model recognition never classifies GB systems as standalone B chips", () => {
  expect(blackwellModel("NVIDIA_GB200")).toBe("GB200");
  expect(blackwellModel("NVIDIA GB300 NVL72")).toBe("GB300");
  expect(blackwellModel("B200 / GB200")).toBeNull();
  expect(blackwellModel("B2000")).toBeNull();
  expect(blackwellModel("RTX PRO 6000 Blackwell")).toBeNull();
});
test("collector selection rejects unknown ids and duplicates do not increase source influence", () => {
  expect(createCollectors(["oracle-public", "oracle-public"])).toHaveLength(1);
  expect(() => createCollectors(["unknown"])).toThrow("Unknown collector");
  expect(collectorCatalog.filter(x => x.defaultEnabled).map(x => x.id)).toEqual(["oracle-public", "azure-retail", "verda-public"]);
});
test("invalid JSON is archived but never converted into an observation", async () => {
  const { ctx, evidence } = context(() => new Response("invalid", { headers: { "content-type": "text/plain" } }));
  await expect(jsonRequest(ctx, "test", new URL("https://example.com"))).rejects.toThrow("INVALID_JSON");
  expect(evidence).toHaveLength(1);
});
