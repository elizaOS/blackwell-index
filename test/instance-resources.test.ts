// Resource entitlements and approvals are synthetic. These fixtures activate no live source.
import { expect, test } from "bun:test";
import { defaultMethodology, defaultRegistry } from "../src/config";
import { canonical, hash, signBatch } from "../src/crypto";
import { calculate } from "../src/engine";
import { preparePythPublication, PYTH_PROTOCOL, type PythManifest } from "../src/pyth";
import { operatingStudy, studyTerms } from "../src/study";
import { Store } from "../src/store";
import type { Observation } from "../src/types";
import { observationSchema, parseMethodology } from "../src/validation";
import { environment, NOW } from "./helpers";

type Resources = NonNullable<Observation["instanceResources"]>;
const resources = (): Resources => ({ schemaVersion: 1, scope: "FULL_INSTANCE", vcpus: 180, memoryGiB: 1536, storageGiB: 22000 });
const quantities = ["vcpus", "memoryGiB", "storageGiB"] as const;
function fixture() {
  const e = environment();
  e.methodology.publicationScope = { kind: "MODEL", model: "B200", approvalEvidence: "Synthetic resource scope approval" };
  for (const model of ["B300", "GB200", "GB300"] as const) e.methodology.providerWeights[model] = {};
  e.observations = e.observations.filter(o => o.model === "B200").map(o => ({ ...o, priceScope: "PUBLIC", topology: "HGX",
    minimumOrderGpuCount: 8, sourceRecordId: `record:${o.provider}:${o.sku}`, instanceResources: resources() }));
  e.methodology.offerSchedule = { schemaVersion: 1, model: "B200", approvalEvidence: "Synthetic resource entitlement approval",
    offers: e.observations.map(o => ({ provider: o.provider, source: o.source, sku: o.sku, region: o.region, gpuCount: 8, topology: "HGX",
      includes: [...o.includes], minimumOrderGpuCount: 8, sourceRecordId: o.sourceRecordId!, sourceUrl: o.sourceUrl, instanceResources: resources() })) };
  return e;
}
type Fixture = ReturnType<typeof fixture>;
function batches(e: ReturnType<typeof environment>, change: (o: Observation, operator: number) => Observation = o => o) {
  return e.identities.map((identity, operator) => signBatch({ ...e.batches[operator]!.payload,
    observations: structuredClone(e.observations).map(o => change(o, operator)) }, identity));
}
const snapshot = (e: Fixture) => calculate(batches(e), e.registry, e.methodology, NOW);

test("omitted resource metadata retains legacy canonical methodology and snapshot hashes", () => {
  const methodology = defaultMethodology(), registry = defaultRegistry("sbx-test");
  expect(hash(parseMethodology(methodology))).toBe("aedd0a2173ffb2b30b8ccd4dc03d0d565049152981e5af744ee4281633a4fb14");
  expect(hash(calculate([], registry, methodology, NOW))).toBe("38856bf09207f6342e0517ea5d1e0c01146f6f14c39420aaee12a1a8701fcf02");
  const e = fixture();
  for (const o of e.observations) delete o.instanceResources;
  for (const offer of e.methodology.offerSchedule!.offers) delete offer.instanceResources;
  expect(snapshot(e).publishable).toBe(true);
  expect(canonical(parseMethodology(e.methodology))).not.toContain("instanceResources");
  expect(canonical(observationSchema.parse(e.observations[0]))).not.toContain("instanceResources");
});

test("explicit undefined scheduled resources normalize to the same canonical policy as omission", () => {
  const e = fixture();
  for (const offer of e.methodology.offerSchedule!.offers) delete offer.instanceResources;
  const omitted = parseMethodology(e.methodology);
  const explicit = parseMethodology({ ...e.methodology, offerSchedule: { ...e.methodology.offerSchedule,
    offers: e.methodology.offerSchedule!.offers.map(offer => ({ ...offer, instanceResources: undefined })) } });
  expect(canonical(explicit)).toBe(canonical(omitted));
  expect(hash(explicit)).toBe(hash(omitted));
  expect(explicit.offerSchedule!.offers.every(offer => !Object.hasOwn(offer, "instanceResources"))).toBe(true);
  expect(() => parseMethodology({ ...e.methodology, offerSchedule: { ...e.methodology.offerSchedule,
    offers: [...e.methodology.offerSchedule!.offers, { ...e.methodology.offerSchedule!.offers[0], instanceResources: undefined }] } })).toThrow();
});

test("resource schema rejects incomplete, malformed and out-of-range observations and schedule entries", () => {
  const e = fixture(), valid = resources();
  const invalid: unknown[] = [null, {}, { ...valid, schemaVersion: 2 }, { ...valid, scope: "PER_GPU" }, { ...valid, extra: true },
    { ...valid, vcpus: 0 }, { ...valid, memoryGiB: 0 }, { ...valid, storageGiB: -1 }];
  for (const field of quantities) {
    const missing: Record<string, unknown> = { ...valid }; delete missing[field]; invalid.push(missing);
    for (const value of [-1, 0.5, "100", 1_000_000_001, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) invalid.push({ ...valid, [field]: value });
  }
  for (const instanceResources of invalid) {
    expect(observationSchema.safeParse({ ...e.observations[0], instanceResources }).success).toBe(false);
    const methodology = { ...e.methodology, offerSchedule: { ...e.methodology.offerSchedule,
      offers: [{ ...e.methodology.offerSchedule!.offers[0], instanceResources }, ...e.methodology.offerSchedule!.offers.slice(1)] } };
    expect(() => parseMethodology(methodology)).toThrow();
  }
});

test("exact full-instance resources preserve normalized price and zero storage is an explicit value", () => {
  const e = fixture(), value = snapshot(e);
  expect(value.publishable).toBe(true); expect(value.feeds.find(f => f.id === "SBX:B200")!.price).toBe("3.250000");
  expect(value.methodologyHash).toBe(hash(e.methodology));
  e.observations[0]!.instanceResources!.storageGiB = 0;
  e.methodology.offerSchedule!.offers[0]!.instanceResources!.storageGiB = 0;
  expect(snapshot(e).publishable).toBe(true);
  const absent = batches(e, o => { if (o.provider === "alpha") delete o.instanceResources; return o; });
  expect(calculate(absent, e.registry, e.methodology, NOW).publishable).toBe(false);
});

test("resource object property order cannot split equivalent operator votes", () => {
  const e = fixture(), changed = batches(e, (o, operator) => {
    if (operator === 2) {
      const r = o.instanceResources!;
      o.instanceResources = { storageGiB: r.storageGiB, memoryGiB: r.memoryGiB, vcpus: r.vcpus, scope: r.scope, schemaVersion: r.schemaVersion };
    }
    return o;
  });
  expect(calculate(changed, e.registry, e.methodology, NOW).publishable).toBe(true);
});

test("operating studies keep unknown and differing full-instance entitlements in separate price series", () => {
  const store = new Store(":memory:"), original = environment().observations[0]!;
  const observations = [original, { ...original, instanceResources: resources() },
    ...quantities.map(field => ({ ...original, instanceResources: { ...resources(), [field]: resources()[field] + 1 } }))];
  try {
    store.capture(observations, [], NOW);
    const result = operatingStudy(store, { asOf: NOW + 300_000, from: NOW, expectedIntervalMs: 300_000 });
    expect(result.series).toHaveLength(5);
    expect(new Set(result.series.map(series => series.id)).size).toBe(5);
    expect(result.series.every(series => series.observationCount === 1)).toBe(true);
    expect(result.series.every(series => series.sensitivity.firstToLastChangeBps === null)).toBe(true);
    expect(result.anomalies.counts).toEqual({});
    expect(canonical(studyTerms(original))).not.toContain("instanceResources");
    expect(new Set(observations.map(o => hash(studyTerms(o)))).size).toBe(5);
  } finally { store.close(); }
});

for (const field of quantities) test(`a changed ${field} entitlement cannot meet the approved scheduled offer`, () => {
  const e = fixture(), changed = batches(e, o => {
    if (o.provider === "alpha") o.instanceResources![field] += 1;
    return o;
  });
  const value = calculate(changed, e.registry, e.methodology, NOW);
  expect(value.publishable).toBe(false);
  expect(value.feeds.find(f => f.id === "SBX:alpha:B200")!.status).toBe("UNAVAILABLE");
});

for (const mode of ["missing", "null"] as const) test(`${mode} resource metadata cannot meet an explicitly approved entitlement`, () => {
  const e = fixture(), changed = batches(e, o => {
    if (o.provider === "alpha") {
      if (mode === "missing") delete o.instanceResources;
      else o.instanceResources = null as unknown as Resources;
    }
    return o;
  });
  expect(calculate(changed, e.registry, e.methodology, NOW).publishable).toBe(false);
});

test("omitting resources from the schedule means exact absence rather than accepting newly claimed entitlements", () => {
  const e = fixture();
  for (const offer of e.methodology.offerSchedule!.offers) delete offer.instanceResources;
  expect(snapshot(e).publishable).toBe(false);
  for (const observation of e.observations) delete observation.instanceResources;
  expect(snapshot(e).publishable).toBe(true);
});

test("scheduled variants of one SKU must each independently reach operator quorum", () => {
  const e = fixture(), variant = structuredClone(e.observations[0]!);
  variant.instanceResources!.memoryGiB *= 2; e.observations.push(variant);
  const required = structuredClone(e.methodology.offerSchedule!.offers[0]!);
  required.instanceResources!.memoryGiB *= 2; e.methodology.offerSchedule!.offers.push(required);
  expect(snapshot(e).publishable).toBe(true);
  const divided = e.identities.map((identity, operator) => signBatch({ ...e.batches[operator]!.payload,
    observations: structuredClone(e.observations).filter(o => o.provider !== "alpha" ||
      (operator === 2 ? o.instanceResources!.memoryGiB === variant.instanceResources!.memoryGiB : o.instanceResources!.memoryGiB !== variant.instanceResources!.memoryGiB)) }, identity));
  expect(calculate(divided, e.registry, e.methodology, NOW).publishable).toBe(false);
});

for (const field of [...quantities, "missing"] as const) test(`legacy aggregation does not pool ${field} resource mismatches into one quote quorum`, () => {
  const e = environment();
  for (const observation of e.observations) observation.instanceResources = resources();
  expect(calculate(batches(e), e.registry, e.methodology, NOW).publishable).toBe(true);
  const divided = batches(e, (observation, operator) => {
    if (observation.provider === "alpha" && observation.model === "B200" && operator === 2) {
      if (field === "missing") delete observation.instanceResources;
      else observation.instanceResources![field] += 1;
    }
    return observation;
  });
  const value = calculate(divided, e.registry, e.methodology, NOW);
  expect(value.publishable).toBe(false);
  expect(value.feeds.find(f => f.id === "SBX:alpha:B200")!.status).toBe("UNAVAILABLE");
});

test("resource policy changes invalidate the old Pyth binding even when every source agrees on the revision", () => {
  const e = fixture(), original = snapshot(e), binding = { indexFeedId: "SBX:B200", pythFeedId: 12, symbol: "TEST.SBXB200/USD", exponent: -6, minPublishers: 3 };
  const manifest: PythManifest = { schemaVersion: 1, enabled: true, network: e.registry.network, methodologyHash: original.methodologyHash,
    registryHash: original.registryHash, publicationScope: { kind: "MODEL", model: "B200" }, agentUrl: "ws://127.0.0.1:8910/v1/jrpc", maxAgeMs: 30_000, futureToleranceMs: 1000,
    approval: { status: "APPROVED", publisherPublicKey: "11111111111111111111111111111111", evidence: "Synthetic Pyth binding",
      verifiedAt: NOW - 1000, expiresAt: NOW + 100_000, protocol: PYTH_PROTOCOL, relayerUrls: ["wss://publisher.example.test/v1/transaction"] }, bindings: [binding] };
  const catalog = [{ pyth_lazer_id: 12, symbol: binding.symbol, exponent: -6, min_publishers: 3, state: "stable" }];
  expect(preparePythPublication(original, manifest, catalog, NOW).status).toBe("PREPARED");
  for (const field of quantities) {
    const changed = structuredClone(e);
    changed.observations[0]!.instanceResources![field] += 1;
    changed.methodology.offerSchedule!.offers[0]!.instanceResources![field] += 1;
    const revised = snapshot(changed);
    expect(revised.publishable).toBe(true); expect(revised.methodologyHash).not.toBe(original.methodologyHash);
    expect(() => preparePythPublication(revised, manifest, catalog, NOW)).toThrow();
  }
});
