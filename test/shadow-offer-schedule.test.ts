// Synthetic, in-memory policy diagnostics; no provider data or publication.
import { afterEach, expect, test } from "bun:test";
import { calculate } from "../src/engine";
import { hash, signBatch } from "../src/crypto";
import { qualifyModel } from "../src/qualification";
import { shadowStudy } from "../src/shadow";
import { operatingStudy } from "../src/study";
import { Store } from "../src/store";
import type { Observation, ScheduledB200Offer } from "../src/types";
import { environment, NOW } from "./helpers";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const options = { asOf: NOW, expectedIntervalMs: 300_000 };
function scheduled(o: Observation): ScheduledB200Offer {
  return { provider: o.provider, source: o.source, sku: o.sku, region: o.region, gpuCount: 8, topology: "HGX",
    includes: [...o.includes], minimumOrderGpuCount: 8, sourceRecordId: o.sourceRecordId!, sourceUrl: o.sourceUrl,
    instanceResources: structuredClone(o.instanceResources!) };
}
function fixture() {
  const e = environment(), store = new Store(":memory:"); stores.push(store);
  const observations: Observation[] = e.observations.filter(o => o.model === "B200").map(o => ({ ...o,
    priceScope: "PUBLIC", topology: "HGX", minimumOrderGpuCount: 8,
    sourceRecordId: `PRIVATE-REVIEW-${o.provider}-RECORD`, sourceUrl: `https://${o.provider}.example/PRIVATE-REVIEW-PATH`,
    instanceResources: { schemaVersion: 1, scope: "FULL_INSTANCE", vcpus: 200, memoryGiB: 2000, storageGiB: 20000 } }));
  e.methodology.publicationScope = { kind: "MODEL", model: "B200", approvalEvidence: "Synthetic scope approval" };
  e.methodology.offerSchedule = { schemaVersion: 1, model: "B200", approvalEvidence: "Synthetic schedule", offers: observations.map(scheduled) };
  return { ...e, observations, store };
}
type Fixture = ReturnType<typeof fixture>;
function batches(e: Fixture) {
  return e.identities.map((identity, i) => signBatch({ ...e.batches[i]!.payload, observations: e.observations }, identity));
}
function capture(e: Fixture) { e.store.capture(e.observations, [], NOW); }
function shadow(e: Fixture, asOf = NOW) { return shadowStudy(e.store.db, e.registry, e.methodology, { ...options, asOf }); }
function calculated(e: Fixture) { return calculate(batches(e), e.registry, e.methodology, NOW); }
function addSibling(e: Fixture, selected: boolean) {
  const provider = { ...structuredClone(e.registry.providers[0]!), id: "alpha-second" };
  e.registry.providers.push(provider);
  const observation = { ...structuredClone(e.observations[0]!), provider: provider.id, sourceRecordId: "PRIVATE-SIBLING-RECORD" };
  e.observations.push(observation);
  if (selected) e.methodology.offerSchedule!.offers.push(scheduled(observation));
  return { provider, observation };
}

test("complete scoped research equals calculation and stays deterministic, private and read-only", () => {
  const e = fixture(); capture(e);
  for (const batch of batches(e)) e.store.accept(batch, NOW, true);
  const before = { captures: e.store.db.query("SELECT * FROM captures").all(), reports: e.store.db.query("SELECT * FROM reports").all(),
    evidence: e.store.db.query("SELECT * FROM evidence").all() };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("LIVE_FETCH_FORBIDDEN"); }) as unknown as typeof fetch;
  try {
    const result = shadow(e), actual = calculated(e);
    expect(actual.publishable).toBe(true); expect(result.current.price).toBe("3.250000");
    expect(result.current.price).toBe(actual.feeds.find(f => f.id === "SBX:B200")!.price);
    expect(result.qualification!.calculationReady).toBe(true);
    expect(result.publishable).toBe(false); expect(result.liveMarketQualified).toBe(false);
    expect(shadow(e)).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-REVIEW");
    expect({ captures: e.store.db.query("SELECT * FROM captures").all(), reports: e.store.db.query("SELECT * FROM reports").all(),
      evidence: e.store.db.query("SELECT * FROM evidence").all() }).toEqual(before);
  } finally { globalThis.fetch = originalFetch; }
});

test("unscheduled offers and economic-group siblings cannot contaminate a scoped research price", () => {
  const e = fixture();
  e.observations.push({ ...structuredClone(e.observations[0]!), sku: "other-sku", sourceRecordId: "OTHER-PRIVATE-RECORD", price: "6", instancePrice: "48" });
  const sibling = addSibling(e, false); sibling.observation.price = "10"; sibling.observation.instancePrice = "80";
  capture(e);
  expect(calculated(e).publishable).toBe(true);
  expect(shadow(e).current.price).toBe("3.250000");
  const diagnostic = qualifyModel(batches(e), e.registry, e.methodology, "B200", NOW);
  expect(diagnostic.groups.find(g => g.group === "alpha")!.providers).toEqual(["alpha"]);
});

const mutations: Array<[string, (o: Observation) => void]> = [
  ["source record", o => { o.sourceRecordId += "-changed"; }],
  ["source URL", o => { o.sourceUrl += "/changed"; }],
  ["SKU", o => { o.sku += "-changed"; }],
  ["region", o => { o.region = "other-region"; }],
  ["GPU count", o => { o.gpuCount = 4; o.instancePrice = String(Number(o.price) * 4); }],
  ["topology", o => { o.topology = "UNKNOWN"; }],
  ["minimum order", o => { o.minimumOrderGpuCount = 16; }],
  ["component bundle", o => { o.includes.push("extra-component"); }],
  ["vCPU quantity", o => { o.instanceResources!.vcpus += 1; }],
  ["memory quantity", o => { o.instanceResources!.memoryGiB += 1; }],
  ["storage quantity", o => { o.instanceResources!.storageGiB += 1; }],
  ["missing resources", o => { delete o.instanceResources; }],
  ["missing explicit public scope", o => { delete o.priceScope; }],
];
for (const [name, mutate] of mutations) test(`scoped research produces an affected-group gap after ${name} mutation`, () => {
  const e = fixture(); mutate(e.observations[0]!); capture(e);
  expect(calculated(e).publishable).toBe(false);
  const result = shadow(e);
  expect(result.current.price).toBeNull(); expect(result.current.missingGroups).toContain("alpha");
  expect(result.scenarios).toEqual([]);
});

for (const loss of ["absent", "expired", "stale"] as const) test(`one ${loss} scheduled offer blocks its otherwise covered provider in shadow`, () => {
  const e = fixture(), extra = { ...structuredClone(e.observations[0]!), sku: "required-second-sku", sourceRecordId: "SECOND-PRIVATE-RECORD" };
  e.methodology.offerSchedule!.offers.push(scheduled(extra));
  if (loss !== "absent") e.observations.push({ ...extra, ...(loss === "expired" ? { expiresAt: NOW } : { observedAt: NOW - e.methodology.maxAgeMs - 1 }) });
  capture(e);
  expect(calculated(e).publishable).toBe(false);
  const result = shadow(e);
  expect(result.current.price).toBeNull(); expect(result.current.missingGroups).toContain("alpha");
});

test("a selected sibling cannot disappear or have its rights masked by another provider", () => {
  for (const loss of ["absent", "rights"] as const) {
    const e = fixture(), sibling = addSibling(e, true);
    if (loss === "absent") e.observations = e.observations.filter(o => o.provider !== sibling.provider.id);
    else sibling.provider.rights.derive = false;
    capture(e);
    const diagnostic = qualifyModel(batches(e), e.registry, e.methodology, "B200", NOW);
    expect(diagnostic.calculationReady).toBe(false);
    const group = diagnostic.groups.find(g => g.group === "alpha")!;
    expect(group.providers).toEqual(["alpha", "alpha-second"]); expect(group.matchedReportsReady).toBe(false);
    if (loss === "rights") {
      expect(group.rightsConfigured).toBe(false); expect(diagnostic.blockers).toContain("CONSTITUENT_RIGHTS_NOT_CONFIGURED");
    } else {
      expect(shadow(e).current.price).toBeNull(); expect(shadow(e).current.missingGroups).toContain("alpha");
    }
  }
});

for (const field of ["sourceUrl", "sourceRecordId"] as const) test(`two selected offers differing only in ${field} remain separate and do not conflict`, () => {
  const e = fixture(), extra = { ...structuredClone(e.observations[0]!), [field]: `${e.observations[0]![field]}-second`, price: "6", instancePrice: "48" };
  e.observations.push(extra); e.methodology.offerSchedule!.offers.push(scheduled(extra)); capture(e);
  const result = shadow(e), actual = calculated(e);
  expect(actual.publishable).toBe(true); expect(result.current.price).toBe("3.750000");
  expect(result.current.price).toBe(actual.feeds.find(f => f.id === "SBX:B200")!.price);
  expect(result.completeness.conflictingPoints).toBe(0); expect(result.anomalies).toEqual({});
  const study = operatingStudy(e.store.db, { ...options, exactB200OfferIdentity: true });
  const identities = study.series.filter(s => s.terms.provider === "alpha").map(s => s.terms.offerIdentityHash);
  expect(identities).toHaveLength(2); expect(new Set(identities).size).toBe(2);
  expect(identities.every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))).toBe(true);
  expect(JSON.stringify(study)).not.toContain("PRIVATE-REVIEW");
  expect(JSON.stringify(study)).not.toContain("sourceRecordId"); expect(JSON.stringify(study)).not.toContain("sourceUrl");
});

test("hashed identity keeps invalid or incomplete offer identity ineligible without inventing public scope", () => {
  const e = fixture(); delete e.observations[0]!.priceScope; capture(e);
  const study = operatingStudy(e.store.db, { ...options, exactB200OfferIdentity: true });
  expect(study.series.find(s => s.terms.provider === "alpha")!.terms.offerIdentityHash).toBeNull();
  expect(shadow(e).current.price).toBeNull();
});

test("scoped shadow continues to block bounded incomplete scans and source expiry between captures", () => {
  const e = fixture(); capture(e);
  const later = e.observations.map(o => ({ ...o, observedAt: NOW + 300_000 }));
  e.store.capture(later, [], NOW + 300_000);
  const limited = shadowStudy(e.store.db, e.registry, e.methodology, { ...options, asOf: NOW + 300_000, maxCaptures: 1 });
  expect(limited.completeness.complete).toBe(false); expect(limited.current.price).toBeNull();
  const stale = shadow(e, NOW + 300_000 + e.methodology.maxAgeMs + 1);
  expect(stale.current.price).toBeNull(); expect(stale.current.missingGroups).toEqual(["alpha", "beta", "gamma"]);
});

test("default studies emit no exact identity metadata and scoped qualification leaves other-model legacy groups alone", () => {
  const e = fixture(); addSibling(e, false); capture(e);
  const normal = operatingStudy(e.store.db, options);
  expect(operatingStudy(e.store.db, { ...options, exactB200OfferIdentity: false })).toEqual(normal);
  expect(JSON.stringify(normal)).not.toContain("offerIdentityHash");
  const diagnostic = qualifyModel(e.batches, e.registry, e.methodology, "B300", NOW);
  expect(diagnostic.groups.find(g => g.group === "alpha")!.providers).toEqual(["alpha", "alpha-second"]);
  expect(diagnostic.groups.find(g => g.group === "alpha")!.matchedReportsReady).toBe(true);
  expect(diagnostic.blockers).toContain("MODEL_OUTSIDE_PUBLICATION_SCOPE");
  delete e.methodology.offerSchedule; delete e.methodology.publicationScope;
  const legacy = shadow(e);
  expect(JSON.stringify(legacy)).not.toContain("offerIdentityHash");
  expect(hash(operatingStudy(e.store.db, options))).toBe(hash(normal));
});
