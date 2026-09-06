import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { hyperstack } from "../src/collectors/hyperstack";
import { shadeform } from "../src/collectors/shadeform";
import type { Collector, CollectorContext, EvidenceRecord } from "../src/types";
import { observationSchema } from "../src/validation";

// Synthetic parser fixtures only. No provider account or live response is represented here.
const NOW = Date.parse("2026-09-06T12:00:00Z");
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
function context(handler: (url: URL, init?: RequestInit) => Response, env: Record<string, string> = {}) {
  const evidence: EvidenceRecord[] = [], requests: URL[] = [];
  const ctx: CollectorContext = { now: () => NOW, env,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString()); requests.push(url); return handler(url, init);
    }) as typeof fetch,
    archive: async record => { evidence.push(record); },
  };
  return { ctx, requests, evidence };
}
async function collect(collector: Collector, ctx: CollectorContext) {
  const result = await collector.collect(ctx);
  for (const observation of result.observations) observationSchema.parse(observation);
  return result;
}
function hyperFixture() {
  const price = (id: number, name: string, value: string) => ({ id, name, value, original_value: value, discount_applied: false, start_time: null as string | null, end_time: null as string | null });
  const flavor = (id: number, model: string) => ({ id, name: `n3-${model}-SXM6x8`, gpu: `${model}-SXM`, gpu_count: 8,
    region_name: "CANADA-1", cpu: 224, ram: 1920, disk: 1000, ephemeral: 40000, stock_available: true });
  return {
    prices: [price(1, "vCPU", "0E-9"), price(2, "RAM", "0.000000000"), price(3, "hypervisor-local-storage", "0E-9"),
      price(4, "B200-SXM", "6.750000000"), price(5, "B300-SXM", "8.125000000")],
    flavors: { status: true, data: ["B200", "B300"].map((model, index) => ({ gpu: `${model}-SXM`, region_name: "CANADA-1", flavors: [flavor(10 + index, model)] })) },
    stocks: { stocks: [{ region: "CANADA-1", "stock-type": "GPU", models: ["B200", "B300"].map(model => ({ model: `${model}-SXM`, available: "10+", configurations: { "1x": 24, "2x": 4, "4x": 0, "8x": 2 } })) }] },
  };
}
function hyperContext(fixture = hyperFixture(), failStock = false) {
  return context((url, init) => {
    expect(new Headers(init?.headers).get("api_key")).toBe("test-only-hyperstack-key");
    expect(url.origin).toBe("https://infrahub-api.nexgencloud.com");
    expect(url.search).toBe("");
    if (url.pathname === "/v1/pricebook") return json(fixture.prices);
    if (url.pathname === "/v1/core/flavors") return json(fixture.flavors);
    if (url.pathname === "/v1/core/stocks") return failStock ? new Response("rate limited", { status: 429 }) : json(fixture.stocks);
    throw new Error("Unexpected test request");
  }, { HYPERSTACK_API_KEY: "test-only-hyperstack-key" });
}
const SHADE_ENV = { SHADEFORM_API_KEY: "test-only-shadeform-key", SHADEFORM_BILLING_CURRENCY: "USD", SHADEFORM_BILLING_EVIDENCE: "test-fixture-unit-confirmation-not-a-real-provider-agreement" };
function shadeFixture() {
  return { instance_types: [{ cloud: "testcloud", shade_instance_type: "B200x8", cloud_instance_type: "test-B200-node",
    configuration: { num_gpus: 8, gpu_type: "B200", gpu_manufacturer: "nvidia", memory_in_gb: 2048, storage_in_gb: 1000, vcpus: 224, vram_per_gpu_in_gb: 192 },
    hourly_price: 8001, deployment_type: "vm", availability: [{ region: "test-region-a", available: true }, { region: "test-region-b", available: false }] }] };
}
function shadeContext(fixture: unknown = shadeFixture()) {
  return context((url, init) => {
    expect(url.toString()).toBe("https://api.shadeform.ai/v1/instances/types");
    expect(new Headers(init?.headers).get("X-API-KEY")).toBe(SHADE_ENV.SHADEFORM_API_KEY);
    return json(fixture);
  }, SHADE_ENV);
}

describe("additional collectors remain key-gated and fail closed", () => {
  test("missing keys never make requests", async () => {
    const { ctx, requests } = context(() => { throw new Error("must not fetch"); });
    for (const collector of [hyperstack, shadeform]) {
      expect((await collect(collector, ctx)).errors[0]).toContain("NO_KEY");
    }
    expect(requests).toHaveLength(0);
  });
  test("Shadeform requires reviewed currency and evidence before requesting any account data", async () => {
    for (const env of [{ SHADEFORM_API_KEY: "test-only" }, { ...SHADE_ENV, SHADEFORM_BILLING_CURRENCY: "EUR" }, { ...SHADE_ENV, SHADEFORM_BILLING_EVIDENCE: "" }]) {
      const { ctx, requests } = context(() => { throw new Error("must not fetch"); }, env);
      expect((await collect(shadeform, ctx)).errors[0]).toContain("UNCONFIRMED_CURRENCY");
      expect(requests).toHaveLength(0);
    }
  });
  test("both collectors report throttling without parsing error payloads or inventing data", async () => {
    for (const [collector, env] of [[hyperstack, { HYPERSTACK_API_KEY: "test-only" }], [shadeform, SHADE_ENV]] as const) {
      const { ctx, requests, evidence } = context(() => new Response("not-json", { status: 429, headers: { "Retry-After": "90" } }), env);
      const result = await collect(collector, ctx);
      expect(result.observations).toEqual([]); expect(result.errors[0]).toContain("RATE_LIMITED");
      expect(requests).toHaveLength(1); expect(evidence).toHaveLength(0);
    }
  });
});

describe("Hyperstack pricebook, flavor and stock composition", () => {
  test("preserves exact per-GPU rates and archives each original response plus labeled composition receipts", async () => {
    const { ctx, evidence } = hyperContext();
    const result = await collect(hyperstack, ctx);
    expect(result.errors).toEqual([]);
    expect(result.observations.map(value => [value.model, value.price, value.instancePrice, value.gpuCount]))
      .toEqual([["B200", "6.750000", "54.000000", 8], ["B300", "8.125000", "65.000000", 8]]);
    expect(result.observations.every(value => value.priceScope === "PUBLIC" && value.availableGpuCount === null && value.availability === "AVAILABLE")).toBe(true);
    expect(evidence).toHaveLength(5);
    for (const record of evidence) expect(record.hash).toBe(createHash("sha256").update(record.body).digest("hex"));
    const receipt = JSON.parse(new TextDecoder().decode(evidence[3]!.body));
    expect(receipt.kind).toBe("HYPERSTACK_PRICEBOOK_COMPOSITION_V1");
    expect(receipt.inputs.map((value: { evidenceHash: string }) => value.evidenceHash)).toEqual(evidence.slice(0, 3).map(record => record.hash));
    expect(JSON.stringify(result)).not.toContain("test-only-hyperstack-key");
  });
  test("zero stock is unavailable while lower-bound stock never becomes a fabricated quantity", async () => {
    const fixture = hyperFixture();
    fixture.stocks.stocks[0]!.models[0]!.configurations["8x"] = 0;
    fixture.flavors.data[0]!.flavors[0]!.stock_available = false;
    const result = await collect(hyperstack, hyperContext(fixture).ctx);
    expect(result.errors).toEqual([]);
    expect(result.observations[0]).toMatchObject({ availableGpuCount: null, availability: "UNAVAILABLE", minimumOrderGpuCount: 8 });
  });
  test("discounted, dated and contradictory list rates are not mislabeled on-demand", async () => {
    for (const change of [{ discount_applied: true }, { start_time: "2026-01-01T00:00:00Z" }, { end_time: "2027-01-01T00:00:00Z" }, { original_value: "9" }]) {
      const fixture = hyperFixture(); Object.assign(fixture.prices[4]!, change);
      const result = await collect(hyperstack, hyperContext(fixture).ctx);
      expect(result.observations).toEqual([]);
      expect(result.errors[0]).toMatch(/UNSUPPORTED_TERMS|AMBIGUOUS_PRICE/);
    }
  });
  test("wrong GPU count or unknown system flavor discards a partial valid result", async () => {
    for (const change of [{ gpu_count: 4 }, { gpu: "GB300" }, { name: "n3-GB300x4" }]) {
      const fixture = hyperFixture(); Object.assign(fixture.flavors.data[1]!.flavors[0]!, change);
      const result = await collect(hyperstack, hyperContext(fixture).ctx);
      expect(result.observations).toEqual([]); expect(result.errors[0]).toMatch(/HARDWARE_MISMATCH|UNSUPPORTED_SKU/);
    }
  });
  test("missing join, stock conflict, failed stock request and unsupported pagination never emit partial observations", async () => {
    const missing = hyperFixture(); missing.stocks.stocks[0]!.models.pop();
    const conflict = hyperFixture(); conflict.flavors.data[1]!.flavors[0]!.stock_available = false;
    const paged = hyperFixture(); Object.assign(paged.flavors, { next_page: 2 });
    for (const fixture of [missing, conflict, paged]) {
      const result = await collect(hyperstack, hyperContext(fixture).ctx);
      expect(result.observations).toEqual([]); expect(result.errors).toHaveLength(1);
    }
    const failed = hyperContext(hyperFixture(), true);
    expect((await collect(hyperstack, failed.ctx)).observations).toEqual([]);
    expect(failed.evidence).toHaveLength(2);
  });
  test("unsupported currency, price units, bundle charges and duplicate price rows fail closed", async () => {
    for (const change of [{ currency: "EUR" }, { unit: "GPU Month" }]) {
      const fixture = hyperFixture(); Object.assign(fixture.prices[3]!, change);
      expect((await collect(hyperstack, hyperContext(fixture).ctx)).errors[0]).toMatch(/UNSUPPORTED_CURRENCY|UNSUPPORTED_UNIT/);
    }
    const charged = hyperFixture(); charged.prices[0]!.value = "0.1";
    expect((await collect(hyperstack, hyperContext(charged).ctx)).errors[0]).toContain("UNSUPPORTED_BUNDLE");
    const duplicate = hyperFixture(); duplicate.prices.push(duplicate.prices[3]!);
    expect((await collect(hyperstack, hyperContext(duplicate).ctx)).errors[0]).toContain("AMBIGUOUS_PRICE");
  });
  test("account-discounted or dated host components cannot become a public list-price bundle", async () => {
    for (const index of [0, 1, 2]) {
      for (const change of [{ original_value: "0.25" }, { discount_applied: true }, { start_time: "2026-01-01T00:00:00Z" }, { end_time: "2027-01-01T00:00:00Z" }, { original_value: undefined }]) {
        const fixture = hyperFixture(); Object.assign(fixture.prices[index]!, change);
        const { ctx, evidence } = hyperContext(fixture), result = await collect(hyperstack, ctx);
        expect(result.observations).toEqual([]); expect(result.errors[0]).toMatch(/UNSUPPORTED_BUNDLE|UNSUPPORTED_TERMS/);
        expect(evidence).toHaveLength(3);
      }
    }
  });
});

describe("Shadeform account-scoped reseller quotes", () => {
  test("normalizes integer instance cents, preserves underlying cloud and qualitative regional availability", async () => {
    const { ctx, evidence } = shadeContext();
    const result = await collect(shadeform, ctx);
    expect(result.errors).toEqual([]); expect(result.observations).toHaveLength(2);
    expect(result.observations[0]).toMatchObject({ model: "B200", price: "10.001250", instancePrice: "80.010000", gpuCount: 8,
      priceScope: "ACCOUNT_SPECIFIC", procurement: "ON_DEMAND", priceBasis: "LIST", availableGpuCount: null, availability: "AVAILABLE" });
    expect(result.observations[0]!.includes).toContain("upstream-cloud:testcloud");
    expect(result.observations[0]!.sourceRecordId).toBe("cloud:testcloud:type:test-B200-node");
    expect(result.observations[1]!.availability).toBe("UNAVAILABLE");
    expect(evidence).toHaveLength(2);
    expect(evidence[0]!.body).toEqual(new TextEncoder().encode(JSON.stringify(shadeFixture())));
    const receipt = JSON.parse(new TextDecoder().decode(evidence[1]!.body));
    expect(receipt).toMatchObject({ kind: "SHADEFORM_ACCOUNT_PRICE_NORMALIZATION_V1", currency: "USD", currencySource: "OPERATOR_REVIEWED_ACCOUNT_BILLING",
      priceUnit: "INTEGER_CENTS_PER_INSTANCE_HOUR", billingEvidenceReferenceHash: createHash("sha256").update(SHADE_ENV.SHADEFORM_BILLING_EVIDENCE).digest("hex"),
      input: { url: "https://api.shadeform.ai/v1/instances/types", evidenceHash: evidence[0]!.hash, observedAt: NOW } });
    expect(evidence[1]!.hash).toBe(createHash("sha256").update(evidence[1]!.body).digest("hex"));
    expect(result.observations.every(observation => observation.evidenceHash === evidence[1]!.hash)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SHADE_ENV.SHADEFORM_API_KEY);
    expect(new TextDecoder().decode(evidence[1]!.body)).not.toContain(SHADE_ENV.SHADEFORM_API_KEY);
    expect(new TextDecoder().decode(evidence[1]!.body)).not.toContain(SHADE_ENV.SHADEFORM_BILLING_EVIDENCE);
  });
  test("a different protected currency-review reference changes the evidence commitment, not the price", async () => {
    const first = shadeContext(), second = shadeContext();
    second.ctx.env = { ...SHADE_ENV, SHADEFORM_BILLING_EVIDENCE: "different-private-review-reference" };
    const a = await collect(shadeform, first.ctx), b = await collect(shadeform, second.ctx);
    expect(a.errors).toEqual([]); expect(b.errors).toEqual([]);
    expect(first.evidence[0]!.hash).toBe(second.evidence[0]!.hash);
    expect(a.observations[0]!.price).toBe(b.observations[0]!.price);
    expect(a.observations[0]!.evidenceHash).not.toBe(b.observations[0]!.evidenceHash);
  });
  test("failure to archive the currency receipt prevents returning unbound observations", async () => {
    const { ctx, evidence } = shadeContext(), archive = ctx.archive;
    ctx.archive = async record => {
      if (record.contentType === "application/vnd.sbx.account-price-normalization+json") throw new Error(`archive failed: ${SHADE_ENV.SHADEFORM_API_KEY}`);
      await archive(record);
    };
    const result = await collect(shadeform, ctx);
    expect(result.observations).toEqual([]); expect(result.errors).toEqual(["COLLECTION_FAILED: shadeform-instances"]);
    expect(evidence).toHaveLength(1);
  });
  test("B300 is distinct, and exact duplicates do not multiply inventory", async () => {
    const fixture = shadeFixture(), instance = fixture.instance_types[0]!;
    instance.configuration.gpu_type = "B300"; instance.shade_instance_type = "B300x8"; instance.cloud_instance_type = "test-B300-node";
    fixture.instance_types.push(structuredClone(instance));
    const result = await collect(shadeform, shadeContext(fixture).ctx);
    expect(result.errors).toEqual([]); expect(result.observations).toHaveLength(2);
    expect(result.observations.every(value => value.model === "B300")).toBe(true);
  });
  test("fractional or mismatched counts, GB systems and container tenancy are rejected", async () => {
    for (const change of [{ num_gpus: 0.5 }, { num_gpus: 4 }, { gpu_type: "GB200" }, { gpu_manufacturer: "amd" }]) {
      const fixture = shadeFixture(); Object.assign(fixture.instance_types[0]!.configuration, change);
      expect((await collect(shadeform, shadeContext(fixture).ctx)).observations).toEqual([]);
    }
    const container = shadeFixture(); container.instance_types[0]!.deployment_type = "container";
    expect((await collect(shadeform, shadeContext(container).ctx)).errors[0]).toContain("UNVERIFIED_TENANCY");
    const relabeled = shadeFixture(); relabeled.instance_types[0]!.cloud_instance_type = "test-GB200-node";
    expect((await collect(shadeform, shadeContext(relabeled).ctx)).errors[0]).toContain("HARDWARE_MISMATCH");
  });
  test("non-integer cents, new unit/currency and procurement metadata require review", async () => {
    for (const change of [{ hourly_price: 80.01 }, { hourly_price: 0 }, { currency: "CAD" }, { unit: "GPU_HOUR" }, { procurement: "RESERVED" }]) {
      const fixture = shadeFixture(); Object.assign(fixture.instance_types[0]!, change);
      const result = await collect(shadeform, shadeContext(fixture).ctx);
      expect(result.observations).toEqual([]); expect(result.errors).toHaveLength(1);
    }
  });
  test("incomplete regions, conflicting duplicates, pagination and empty catalogs never become zero prices", async () => {
    const missing = shadeFixture(); missing.instance_types[0]!.availability = [];
    const conflicting = shadeFixture(); conflicting.instance_types.push({ ...structuredClone(conflicting.instance_types[0]!), hourly_price: 123 });
    const paged = { ...shadeFixture(), next_cursor: "next-page" };
    for (const fixture of [missing, conflicting, paged, { instance_types: [] }]) {
      const result = await collect(shadeform, shadeContext(fixture).ctx);
      expect(result.observations).toEqual([]); expect(result.errors).toHaveLength(1);
    }
  });
});
