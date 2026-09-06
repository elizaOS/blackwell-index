import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { primeIntellect, PRIME_INTELLECT_GPU_TYPES } from "../src/collectors/prime-intellect";
import { collectorCatalog, createCollectors } from "../src/collectors";
import { defaultMethodology, defaultRegistry, parseConfig } from "../src/config";
import { runtimeConfig, type WorkerEnvironment } from "../src/cloudflare/config";
import { collectCycle } from "../src/cloudflare/collect";
import { generateIdentity, signBatch } from "../src/crypto";
import { allowedObservation, calculate } from "../src/engine";
import { OracleNode } from "../src/network";
import { Store } from "../src/store";
import type { CollectorContext, EvidenceRecord } from "../src/types";
import { observationSchema, parseRegistry } from "../src/validation";

// Synthetic parser fixtures only: none of these offers, prices or credentials are live provider evidence.
const NOW = Date.parse("2026-09-06T12:00:00Z"), KEY = "test-only-prime-intellect-key";
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
function context(handler: (url: URL, init?: RequestInit) => Response, env: Record<string, string> = { PRIME_INTELLECT_API_KEY: KEY }) {
  const requests: URL[] = [], evidence: EvidenceRecord[] = [];
  const ctx: CollectorContext = { now: () => NOW, env,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString()); requests.push(url); return handler(url, init);
    }, archive: async record => { evidence.push(record); } };
  return { ctx, requests, evidence };
}
function offer(model: "B200" | "B300" = "B200", cloudId = `test-${model}-node`) {
  const resource = (defaultCount: number, included = true, pricePerUnit = 0) => ({ defaultCount, minCount: defaultCount,
    maxCount: defaultCount + 1000, defaultIncludedInPrice: included, pricePerUnit, step: 1, additionalInfo: null });
  return { cloudId, gpuType: model === "B200" ? "B200_180GB" : "B300_262GB", gpuCount: 8, gpuMemory: model === "B200" ? 180 : 262,
    socket: "SXM6", provider: "testcloud", region: "united_states", dataCenter: "TEST-DC-1", country: "US", security: "secure_cloud",
    prices: { currency: "USD", onDemand: model === "B200" ? 64 : 80, isVariable: false, communityPrice: null },
    isSpot: false, prepaidTime: null, stockStatus: "High", images: ["test-only-image"],
    vcpu: resource(224), memory: resource(1920), disk: resource(100, false, 0.00014), sharedDisk: resource(0) };
}
function catalogFixture() {
  return { B200_180GB: [offer()], B300_262GB: [offer("B300")], GB200: [], GB300: [] } as Record<string, ReturnType<typeof offer>[]>;
}
function catalogContext(catalog = catalogFixture()) {
  return context((url, init) => {
    expect(url.origin).toBe("https://api.primeintellect.ai"); expect(url.pathname).toBe("/api/v1/availability/gpus");
    expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
    expect([...url.searchParams.keys()].sort()).toEqual(["gpu_type", "page", "page_size", "security"]);
    expect(url.searchParams.get("security")).toBe("secure_cloud"); expect(url.searchParams.get("page_size")).toBe("100");
    const rows = catalog[url.searchParams.get("gpu_type")!] ?? [], offset = (Number(url.searchParams.get("page")) - 1) * 100;
    return json({ items: rows.slice(offset, offset + 100), totalCount: rows.length });
  });
}
async function collect(ctx: CollectorContext) {
  const result = await primeIntellect.collect(ctx);
  for (const observation of result.observations) observationSchema.parse(observation);
  return result;
}

describe("Prime Intellect catalog and deployment integration", () => {
  test("registers one disabled descriptor, fixed host and unapproved source without changing public defaults", async () => {
    expect(collectorCatalog).toHaveLength(11);
    expect(collectorCatalog.filter(value => value.id === primeIntellect.id)).toEqual([{
      id: "prime-intellect-availability", provider: "prime-intellect", credentialEnv: "PRIME_INTELLECT_API_KEY",
      documentation: "https://docs.primeintellect.ai/api-reference/availability/get-gpu-availability", defaultEnabled: false,
    }]);
    expect(collectorCatalog.filter(value => value.defaultEnabled).map(value => value.id)).toEqual(["oracle-public", "azure-retail", "verda-public"]);
    expect(createCollectors([primeIntellect.id, primeIntellect.id])).toEqual([primeIntellect]);
    const registry = parseRegistry(defaultRegistry("prime-test"));
    expect(registry.version).toBe("0.3.0-draft"); expect(registry.providers).toHaveLength(11);
    expect(registry.providers.find(value => value.id === primeIntellect.provider)).toEqual({
      id: "prime-intellect", economicGroup: "prime-intellect", allowedHosts: ["api.primeintellect.ai"], sources: [primeIntellect.id],
      rights: { collect: false, derive: false, redistribute: false, evidence: "", expiresAt: null },
    });
    const catalog = await Bun.file(new URL("../config/catalog.json", import.meta.url)).json() as { providers: { id: string; collector: string | null; models: string[]; discoveryOnlyModels?: string[]; credentials: string[]; publicationRights: string }[] };
    expect(catalog.providers.filter(value => value.id === primeIntellect.provider)).toHaveLength(1);
    expect(catalog.providers.find(value => value.id === primeIntellect.provider)).toMatchObject({
      collector: primeIntellect.id, models: ["B200", "B300"], discoveryOnlyModels: ["GB200", "GB300"],
      credentials: ["PRIME_INTELLECT_API_KEY"], publicationRights: "WRITTEN_PERMISSION_REQUIRED",
    });
    expect(catalog.providers.some(value => value.id === "primeintellect")).toBe(false);
    expect(await Bun.file(new URL("../public/assets/index.js", import.meta.url)).text()).toContain('"prime-intellect": "Prime Intellect"');
  });

  test("CLI configuration recognizes the new source without any credentials or provider requests", async () => {
    const config = parseConfig({ schemaVersion: 1, network: "prime-test", identityPath: "data/identity.json", databasePath: "data/node.sqlite",
      registryPath: "config/registry.json", methodologyPath: "config/methodology.json", host: "127.0.0.1", port: 0, intervalMs: 300000,
      collectors: [primeIntellect.id], peers: [], allowLoopbackPeers: false });
    const { ctx, requests } = context(() => { throw new Error("must not fetch"); }, {});
    expect((await createCollectors(config.collectors)[0]!.collect(ctx)).errors[0]).toContain("NO_KEY"); expect(requests).toEqual([]);
  });

  test("hosted credentials are routed privately and registry permission blocks collection before fetch", async () => {
    const config = runtimeConfig({ SBX_NETWORK: "prime-test", SBX_OPERATOR_GROUP: "test-operator", SBX_COLLECTORS: primeIntellect.id,
      SBX_COLLECTION_INTERVAL_MS: "300000", PRIME_INTELLECT_API_KEY: KEY } as unknown as WorkerEnvironment);
    expect(config.credentials.PRIME_INTELLECT_API_KEY).toBe(KEY); expect(JSON.stringify(config.registry)).not.toContain(KEY);
    const store = new Store(":memory:"), node = new OracleNode({ identity: generateIdentity(), registry: config.registry, methodology: config.methodology, store });
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => { throw new Error("Unapproved provider request"); }, { preconnect: globalThis.fetch.preconnect }));
    try {
      const cycle = await collectCycle(config, node, store);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(cycle.sources).toEqual([{ collector: primeIntellect.id, status: "COLLECTION_NOT_APPROVED", observations: 0, errors: 0 }]);
      expect(cycle.realObservationCount).toBe(0); expect(cycle.sharedObservationCount).toBe(0);
      expect(store.counts().evidence).toBe(0); expect(node.publicReports()).toEqual([]);
      const snapshot = node.snapshot();
      expect(snapshot.feeds).toHaveLength(49); expect(snapshot.feeds.filter(value => value.kind === "PROVIDER")).toHaveLength(44);
      expect(snapshot.feeds.filter(value => value.provider === primeIntellect.provider).map(value => value.model)).toEqual(["B200", "B300", "GB200", "GB300"]);
      expect(snapshot.feeds.every(value => value.price === null && value.status === "UNAVAILABLE")).toBe(true);
      expect(snapshot.publishable).toBe(false); expect((await node.handle(new Request("https://node.test/v1/ready"))).status).toBe(503);
      expect(JSON.stringify([cycle, snapshot])).not.toContain(KEY);
    } finally { fetchMock.mockRestore(); store.close(); }
  });

  test("account-scoped fixture quotes remain ineligible even with test-only rights and independent quorum", async () => {
    const { observations } = await collect(catalogContext().ctx), registry = defaultRegistry("prime-test"), identities = Array.from({ length: 3 }, generateIdentity);
    expect(observations).toHaveLength(2);
    for (const observation of observations) {
      expect(allowedObservation(observation, registry, NOW, "share")).toBe(false);
      expect(allowedObservation(observation, registry, NOW, "derive")).toBe(false);
    }
    // Test-only approval provides a positive control; no production rights or local configuration are changed.
    registry.providers.find(value => value.id === primeIntellect.provider)!.rights = { collect: true, derive: true, redistribute: true, evidence: "Synthetic test-only permission", expiresAt: null };
    registry.operators = identities.map((identity, i) => ({ nodeId: identity.nodeId, publicKey: identity.publicKey, operatorGroup: `test-operator-${i}`, enabled: true }));
    const batches = (publicScope: boolean) => identities.map(identity => signBatch({ schemaVersion: 1, network: registry.network, nodeId: identity.nodeId,
      publicKey: identity.publicKey, sequence: 1, createdAt: NOW, observations: observations.map(value => publicScope ? { ...value, priceScope: "PUBLIC" as const } : value) }, identity));
    const excluded = calculate(batches(false), registry, defaultMethodology(), NOW);
    expect(excluded.feeds.every(value => value.price === null)).toBe(true); expect(excluded.publishable).toBe(false);
    const control = calculate(batches(true), registry, defaultMethodology(), NOW);
    expect(control.feeds.find(value => value.id === "SBX:prime-intellect:B200")!.price).toBe("8.001750");
    expect(control.feeds.find(value => value.id === "SBX:prime-intellect:B300")!.price).toBe("10.001750");
  });
});

describe("Prime Intellect read-only authenticated collection", () => {
  test("missing or blank key makes no request", async () => {
    for (const env of [{}, { PRIME_INTELLECT_API_KEY: "" }, { PRIME_INTELLECT_API_KEY: "  " }]) {
      const { ctx, requests, evidence } = context(() => { throw new Error("must not fetch"); }, env);
      expect((await collect(ctx)).errors[0]).toContain("NO_KEY"); expect(requests).toEqual([]); expect(evidence).toEqual([]);
    }
  });
  test("normalizes complete hourly bundles once, preserving reseller scope and exact original responses", async () => {
    const { ctx, requests, evidence } = catalogContext(), result = await collect(ctx);
    expect(result.observations.map(value => [value.model, value.instancePrice, value.price, value.gpuCount])).toEqual([
      ["B200", "64.014000", "8.001750", 8], ["B300", "80.014000", "10.001750", 8],
    ]);
    expect(result.observations.every(value => value.priceScope === "ACCOUNT_SPECIFIC" && value.priceBasis === "LIST" && value.procurement === "ON_DEMAND" && value.availableGpuCount === null && value.availability === "AVAILABLE")).toBe(true);
    expect(result.observations[0]!.includes).toContain("upstream-cloud:testcloud");
    expect(result.observations[0]!.sku).toContain("TEST-DC-1");
    expect(result.observations[0]).toMatchObject({ observedAt: NOW, priceEffectiveAt: null, expiresAt: null, topology: "UNKNOWN", minimumOrderGpuCount: 8 });
    expect(result.errors).toHaveLength(2); expect(result.errors.every(value => value.startsWith("NO_DATA"))).toBe(true);
    expect(requests).toHaveLength(4); expect(evidence).toHaveLength(6);
    expect(evidence[0]!.body).toEqual(new TextEncoder().encode(JSON.stringify({ items: [offer()], totalCount: 1 })));
    for (const record of evidence) expect(record.hash).toBe(createHash("sha256").update(record.body).digest("hex"));
    const receipt = JSON.parse(new TextDecoder().decode(evidence[4]!.body));
    expect(receipt).toMatchObject({ kind: "PRIME_INTELLECT_BUNDLE_COMPOSITION_V1", baseInstanceHourlyUsd: "64.000000",
      input: { evidenceHash: evidence[0]!.hash, observedAt: NOW }, offer: { upstreamProvider: "testcloud", cloudId: "test-B200-node", gpuCount: 8, dataCenter: "TEST-DC-1" } });
    expect(receipt.components.find((value: { name: string }) => value.name === "disk")).toEqual({ name: "disk", count: 100, includedInBase: false, hourlyUsd: "0.014000" });
    expect(result.observations[0]!.evidenceHash).toBe(evidence[4]!.hash);
    expect(JSON.stringify(result)).not.toContain(KEY); expect(JSON.stringify(evidence.map(record => ({ url: record.url, body: new TextDecoder().decode(record.body) })))).not.toContain(KEY);
  });
  test("enumerated GPU count is configuration size, never global inventory", async () => {
    const catalog = catalogFixture(); catalog.B200_180GB![0]!.stockStatus = "Unavailable";
    const result = await collect(catalogContext(catalog).ctx);
    expect(result.observations[0]).toMatchObject({ gpuCount: 8, availableGpuCount: null, availability: "UNAVAILABLE" });
  });
  test("all pages reconcile with totalCount without changing request origin or following arbitrary links", async () => {
    const catalog = catalogFixture(); catalog.B200_180GB = Array.from({ length: 101 }, (_, i) => offer("B200", `test-B200-node-${i}`));
    const { ctx, requests, evidence } = catalogContext(catalog), result = await collect(ctx);
    expect(result.observations).toHaveLength(102); expect(requests).toHaveLength(5);
    expect(requests.slice(0, 2).map(url => url.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(evidence.slice(0, 5).every(record => record.contentType === "application/json")).toBe(true);
  });
  test("GB200 and GB300 retain raw discovery but cannot normalize even plausible GPU counts", async () => {
    const { ctx, evidence, requests } = context(url => {
      const gpuType = url.searchParams.get("gpu_type"), gb = gpuType?.startsWith("GB");
      return json({ items: gb ? [{ ...offer(), gpuType, gpuCount: gpuType === "GB200" ? 4 : 72 }] : [], totalCount: gb ? 1 : 0 });
    });
    const result = await collect(ctx);
    expect(result.observations).toEqual([]); expect(result.errors.filter(value => value.startsWith("HARDWARE_METADATA_REQUIRED"))).toHaveLength(2);
    expect(requests).toHaveLength(4); expect(evidence).toHaveLength(4);
    expect(requests.map(url => url.searchParams.get("gpu_type"))).toEqual(PRIME_INTELLECT_GPU_TYPES.map(value => value.apiType));
  });
  test("no family becomes zero when the catalog is empty", async () => {
    const { ctx, evidence } = context(() => json({ items: [], totalCount: 0 })), result = await collect(ctx);
    expect(result.observations).toEqual([]); expect(result.errors).toHaveLength(4);
    expect(result.errors.every(value => value.startsWith("NO_DATA"))).toBe(true); expect(evidence).toHaveLength(4);
  });
});

describe("Prime Intellect fail-closed commercial and hardware semantics", () => {
  test("currency, unit, variable pricing, community and prepaid ambiguities reject the whole result", async () => {
    for (const change of [{ currency: "EUR" }, { currency: undefined }, { onDemand: null }, { onDemand: 0 }, { onDemand: 1.0000001 }, { isVariable: true }, { isVariable: null }, { communityPrice: 40 }, { unit: "USD_PER_GPU_HOUR" }]) {
      const catalog = catalogFixture(); Object.assign(catalog.B300_262GB![0]!.prices, change);
      const result = await collect(catalogContext(catalog).ctx);
      expect(result.observations).toEqual([]); expect(result.errors).toHaveLength(1);
    }
    for (const change of [{ isSpot: true }, { isSpot: null }, { isSpot: undefined }, { prepaidTime: 0 }, { prepaidTime: 1 }, { prepaidTime: undefined }]) {
      const catalog = catalogFixture(); Object.assign(catalog.B200_180GB![0]!, change);
      expect((await collect(catalogContext(catalog).ctx)).errors[0]).toContain("UNSUPPORTED_TERMS");
    }
  });
  test("fractional counts, insufficient GPU memory, old sockets and conflicting cloud identifiers fail", async () => {
    for (const change of [{ gpuCount: 0.5 }, { gpuCount: 0 }, { gpuCount: 100001 }, { gpuMemory: 90 }, { socket: "SXM5" }, { cloudId: "test-GB200-system" }, { cloudId: "test-B200-GB200" }, { cloudId: "test_B200_B300" }]) {
      const catalog = catalogFixture(); Object.assign(catalog.B200_180GB![0]!, change);
      expect((await collect(catalogContext(catalog).ctx)).observations).toEqual([]);
    }
  });
  test("opaque cloud identifiers and repeated matching family labels remain valid", async () => {
    for (const cloudId of ["opaque-configuration-123", "test-B200-B200"]) {
      const catalog = catalogFixture(); catalog.B200_180GB![0]!.cloudId = cloudId;
      const result = await collect(catalogContext(catalog).ctx);
      expect(result.observations).toHaveLength(2);
      expect(JSON.parse(result.observations[0]!.sku)).toEqual(["testcloud", cloudId, 8, "TEST-DC-1"]);
    }
  });
  test("a server ignoring model or secure-cloud filters is not silently accepted", async () => {
    for (const change of [{ gpuType: "B200" }, { gpuType: "GB200" }, { security: "community_cloud" }]) {
      const { ctx } = context(() => json({ items: [{ ...offer(), ...change }], totalCount: 1 }));
      expect((await collect(ctx)).errors[0]).toContain("FILTER_MISMATCH");
    }
  });
  test("missing resource inclusion and separately billed non-minimum defaults cannot underprice a bundle", async () => {
    for (const name of ["vcpu", "memory", "disk", "sharedDisk"] as const) {
      for (const change of [{ defaultIncludedInPrice: undefined }, { defaultIncludedInPrice: null }, { defaultCount: undefined }, { additionalInfo: "requires separate contract" }]) {
        const catalog = catalogFixture(); Object.assign(catalog.B200_180GB![0]![name], change);
        expect((await collect(catalogContext(catalog).ctx)).observations).toEqual([]);
      }
    }
    for (const change of [{ minCount: 50 }, { minCount: undefined }, { pricePerUnit: null }, { pricePerUnit: -1 }, { pricePerUnit: 0.0000001 }, { maxCount: 99 }]) {
      const catalog = catalogFixture(); Object.assign(catalog.B200_180GB![0]!.disk, change);
      expect((await collect(catalogContext(catalog).ctx)).observations).toEqual([]);
    }
    const omitted = offer();
    const { ctx } = context(() => json({ items: [{ ...omitted, sharedDisk: {} }], totalCount: 1 }));
    expect((await collect(ctx)).observations).toEqual([]);
  });
  test("resource costs are added once and included extras are not charged at the default", async () => {
    const catalog = catalogFixture(), item = catalog.B200_180GB![0]!;
    item.vcpu.defaultIncludedInPrice = false; item.vcpu.pricePerUnit = 0.01;
    item.memory.defaultIncludedInPrice = false; item.memory.pricePerUnit = 0.000001;
    item.disk.defaultIncludedInPrice = true; item.disk.pricePerUnit = 1;
    item.sharedDisk.defaultCount = 10; item.sharedDisk.minCount = 10;
    item.sharedDisk.defaultIncludedInPrice = false; item.sharedDisk.pricePerUnit = 0.0001;
    const result = await collect(catalogContext(catalog).ctx);
    expect(result.observations[0]).toMatchObject({ instancePrice: "66.242920", price: "8.280365" });
    expect(result.observations[0]!.includes).toContain("shared-storage");
  });
  test("duplicate configurations, invalid locations and unknown stock labels are rejected", async () => {
    const duplicate = catalogFixture(); duplicate.B200_180GB!.push(structuredClone(duplicate.B200_180GB![0]!));
    expect((await collect(catalogContext(duplicate).ctx)).errors[0]).toContain("AMBIGUOUS_CONFIGURATION");
    for (const change of [{ provider: "bad/provider" }, { region: "" }, { region: null }, { cloudId: "x".repeat(201) }, { dataCenter: "a\nb" }, { stockStatus: "Unknown" }]) {
      const catalog = catalogFixture(); Object.assign(catalog.B200_180GB![0]!, change);
      expect((await collect(catalogContext(catalog).ctx)).observations).toEqual([]);
    }
  });
  test("delimiter-bearing cloud and data-center identifiers do not merge distinct configurations", async () => {
    const catalog = catalogFixture(), first = offer("B200", "a:8:b"), second = offer("B200", "a");
    first.dataCenter = "c"; second.dataCenter = "b:8:c";
    catalog.B200_180GB = [first, second];
    const result = await collect(catalogContext(catalog).ctx), observations = result.observations.filter(value => value.model === "B200");
    expect(observations).toHaveLength(2);
    expect(new Set(observations.map(value => value.sku)).size).toBe(2);
    expect(new Set(observations.map(value => value.sourceRecordId)).size).toBe(2);
    expect(observations.map(value => JSON.parse(value.sku))).toEqual([["testcloud", "a:8:b", 8, "c"], ["testcloud", "a", 8, "b:8:c"]]);
  });
});

describe("Prime Intellect incomplete responses and transport boundaries", () => {
  test("malformed totals, short pages, unsupported pagination and bounded overflow fail before another request", async () => {
    for (const value of [{ items: [], totalCount: -1 }, { items: [], totalCount: 1.5 }, { items: [], totalCount: "0" },
      { items: [], totalCount: 1 }, { items: [offer()], totalCount: 0 }, { items: [], totalCount: 2001 },
      { items: [offer()], totalCount: 1, next: "https://untrusted.example.test/" }, { totalCount: 0 }]) {
      const { ctx, requests, evidence } = context(() => json(value)), result = await collect(ctx);
      expect(result.observations).toEqual([]); expect(result.errors).toHaveLength(1);
      expect(requests).toHaveLength(1); expect(evidence).toHaveLength(1);
    }
  });
  test("changing totalCount between pages never produces a partial price set", async () => {
    const first = Array.from({ length: 100 }, (_, i) => offer("B200", `test-B200-${i}`));
    const { ctx, requests, evidence } = context(url => url.searchParams.get("page") === "1" ? json({ items: first, totalCount: 101 }) : json({ items: [], totalCount: 100 }));
    const result = await collect(ctx);
    expect(result.observations).toEqual([]); expect(result.errors[0]).toContain("INCOMPLETE_COVERAGE");
    expect(requests).toHaveLength(2); expect(evidence).toHaveLength(2);
  });
  test("HTTP errors stop all pagination and never expose header credentials or response bodies", async () => {
    for (const status of [401, 403, 429, 503]) {
      const { ctx, requests, evidence } = context(() => new Response(`private body ${KEY}`, { status, headers: { "retry-after": KEY } }));
      const result = await collect(ctx);
      expect(result.observations).toEqual([]); expect(result.errors[0]).toContain(status === 429 ? "RATE_LIMITED" : "HTTP_ERROR");
      expect(JSON.stringify(result)).not.toContain(KEY); expect(requests).toHaveLength(1); expect(evidence).toHaveLength(0);
    }
  });
  test("a later failure keeps original evidence but returns no earlier normalized observations", async () => {
    const { ctx, evidence, requests } = context(url => url.searchParams.get("gpu_type") === "B200_180GB"
      ? json({ items: [offer()], totalCount: 1 }) : new Response("rate limited", { status: 429 }));
    expect((await collect(ctx)).observations).toEqual([]); expect(requests).toHaveLength(2); expect(evidence).toHaveLength(1);
  });
  test("invalid JSON and secret-bearing transport exceptions remain safe", async () => {
    const malformed = context(() => new Response("not JSON")), broken = context(() => { throw new Error(`private transport ${KEY}`); });
    expect((await collect(malformed.ctx)).errors[0]).toContain("INVALID_JSON"); expect(malformed.evidence).toHaveLength(1);
    expect((await collect(broken.ctx)).errors).toEqual(["COLLECTION_FAILED: prime-intellect-availability"]);
  });
  test("receipt archive failure cannot return unbound observations", async () => {
    const { ctx, evidence } = catalogContext(), archive = ctx.archive;
    ctx.archive = async record => { if (record.contentType !== "application/json") throw new Error(`private archive ${KEY}`); await archive(record); };
    const result = await collect(ctx);
    expect(result.observations).toEqual([]); expect(result.errors).toEqual(["COLLECTION_FAILED: prime-intellect-availability"]); expect(evidence).toHaveLength(4);
  });
});
