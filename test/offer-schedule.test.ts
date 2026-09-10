// All approvals, publishers and tariffs here are synthetic local test fixtures.
import { expect, test } from "bun:test";
import { defaultMethodology, defaultRegistry } from "../src/config";
import { canonical, hash, signBatch } from "../src/crypto";
import { calculate } from "../src/engine";
import { isFeedPublishable } from "../src/publication";
import { preparePythPublication, PYTH_PROTOCOL, type PythManifest } from "../src/pyth";
import type { Methodology, Observation } from "../src/types";
import { parseMethodology } from "../src/validation";
import { environment, NOW } from "./helpers";

type Schedule = NonNullable<Methodology["offerSchedule"]>;
function offer(observation: Observation): Schedule["offers"][number] {
  return { provider: observation.provider, source: observation.source, sku: observation.sku, region: observation.region,
    gpuCount: 8, topology: "HGX", includes: [...observation.includes], minimumOrderGpuCount: observation.minimumOrderGpuCount ?? null,
    sourceRecordId: observation.sourceRecordId!, sourceUrl: observation.sourceUrl };
}
function fixture() {
  const e = environment();
  e.methodology.publicationScope = { kind: "MODEL", model: "B200", approvalEvidence: "Synthetic scope approval" };
  for (const model of ["B300", "GB200", "GB300"] as const) e.methodology.providerWeights[model] = {};
  e.observations = e.observations.filter(o => o.model === "B200").map(o => ({ ...o, priceScope: "PUBLIC", topology: "HGX",
    minimumOrderGpuCount: 8, sourceRecordId: `record:${o.provider}:${o.sku}`, includes: ["gpu", "cpu", "memory"] }));
  e.methodology.offerSchedule = { schemaVersion: 1, model: "B200", approvalEvidence: "Synthetic exact offer approval",
    offers: e.observations.map(offer) };
  return e;
}
type Fixture = ReturnType<typeof fixture>;
function batches(e: Fixture, change: (observations: Observation[], operator: number) => Observation[] = observations => observations) {
  return e.identities.map((identity, i) => signBatch({ ...e.batches[i]!.payload,
    observations: change(structuredClone(e.observations), i) }, identity));
}
const snapshot = (e: Fixture) => calculate(batches(e), e.registry, e.methodology, NOW);
const model = (value: ReturnType<typeof calculate>) => value.feeds.find(feed => feed.id === "SBX:B200")!;
function addAlphaOffer(e: Fixture, field: "sourceUrl" | "sourceRecordId" | "sku" = "sku") {
  const next = { ...e.observations[0]!, [field]: `${e.observations[0]![field]}-second` };
  e.observations.push(next); e.methodology.offerSchedule!.offers.push(offer(next));
  return next;
}
function addSibling(e: Fixture, scheduled: boolean) {
  const provider = { ...structuredClone(e.registry.providers[0]!), id: "alpha-second" };
  e.registry.providers.push(provider);
  const observation = { ...structuredClone(e.observations[0]!), provider: provider.id, sourceRecordId: "alpha-second-record" };
  e.observations.push(observation);
  if (scheduled) e.methodology.offerSchedule!.offers.push(offer(observation));
  return observation;
}

test("absent offer schedule preserves the original canonical methodology and snapshot bytes", () => {
  const methodology = defaultMethodology(), registry = defaultRegistry("sbx-test");
  expect(hash(parseMethodology(methodology))).toBe("aedd0a2173ffb2b30b8ccd4dc03d0d565049152981e5af744ee4281633a4fb14");
  const value = calculate([], registry, methodology, NOW);
  expect(hash(value)).toBe("38856bf09207f6342e0517ea5d1e0c01146f6f14c39420aaee12a1a8701fcf02");
  expect(canonical(value)).not.toContain("offerSchedule");
  expect(canonical(parseMethodology({ ...methodology, offerSchedule: undefined }))).not.toContain("offerSchedule");
});

test("complete exact scheduled offers retain fixed group weights and only B200 publication", () => {
  const e = fixture(), value = snapshot(e);
  expect(value.publishable).toBe(true); expect(model(value).price).toBe("3.250000");
  expect(model(value).weights).toEqual({ alpha: 1, beta: 1, gamma: 2 });
  expect(model(value).observedAt).toBe(NOW - 1000);
  expect(value.methodologyHash).toBe(hash(e.methodology));
  expect(value.feeds.filter(feed => isFeedPublishable(value, feed.id)).map(feed => feed.id)).toEqual(["SBX:B200"]);
  expect(value).not.toHaveProperty("offerSchedule");
});

test("schedule schema refuses missing scope, non-B200 hardware, unsupported cohort and malformed approvals", () => {
  const e = fixture(), schedule = e.methodology.offerSchedule!;
  for (const offerSchedule of [null, {}, { ...schedule, approvalEvidence: " " }, { ...schedule, model: "B300" },
    { ...schedule, extra: true }, { ...schedule, offers: [] },
    { ...schedule, offers: [{ ...schedule.offers[0], gpuCount: 1 }] },
    { ...schedule, offers: [{ ...schedule.offers[0], topology: "UNKNOWN" }] },
    { ...schedule, offers: [{ ...schedule.offers[0], sourceRecordId: undefined }] },
    { ...schedule, offers: [{ ...schedule.offers[0], minimumOrderGpuCount: undefined }] },
    { ...schedule, offers: [{ ...schedule.offers[0], includes: [] }] },
    { ...schedule, offers: [{ ...schedule.offers[0], includes: ["gpu", "gpu"] }] },
    { ...schedule, offers: [...schedule.offers, structuredClone(schedule.offers[0]!)] },
    { ...schedule, offers: Array.from({ length: 257 }, (_, i) => ({ ...schedule.offers[0], sku: `sku-${i}` })) }]) {
    expect(() => parseMethodology({ ...e.methodology, offerSchedule })).toThrow();
  }
  const missingScope = structuredClone(e.methodology); delete missingScope.publicationScope;
  expect(() => parseMethodology(missingScope)).toThrow();
  for (const cohort of [{ ...e.methodology.cohort, procurement: "SPOT" }, { ...e.methodology.cohort, priceBasis: "EXECUTABLE" }]) {
    expect(() => parseMethodology({ ...e.methodology, cohort })).toThrow();
  }
});

test("approval evidence may contain markdown without weakening exact offer identifiers", () => {
  const e = fixture();
  e.methodology.offerSchedule!.approvalEvidence = "**Synthetic approval** for the exact schedule; *reviewed locally*.";
  expect(parseMethodology(e.methodology).offerSchedule!.approvalEvidence).toBe(e.methodology.offerSchedule!.approvalEvidence);
  expect(snapshot(e).publishable).toBe(true);
  e.methodology.offerSchedule!.offers[0]!.region = "*";
  expect(() => parseMethodology(e.methodology)).toThrow();
});

test("every scheduled region must fit an explicit cohort while a broad cohort still requires exact offers", () => {
  const e = fixture(); e.methodology.cohort.regions = ["us-test"];
  expect(snapshot(e).publishable).toBe(true);
  e.methodology.offerSchedule!.offers[0]!.region = "unapproved-region";
  expect(() => parseMethodology(e.methodology)).toThrow();
  e.methodology.cohort.regions = ["*"];
  expect(() => parseMethodology(e.methodology)).not.toThrow();
  expect(snapshot(e).publishable).toBe(false);
  e.observations[0]!.region = "unapproved-region";
  expect(snapshot(e).publishable).toBe(true);
});

test("scheduled fields reject wildcard and unsafe source URL admission", () => {
  const e = fixture(), original = e.methodology.offerSchedule!.offers[0]!;
  for (const field of ["provider", "source", "sku", "region", "sourceRecordId", "sourceUrl"] as const) {
    const changed = structuredClone(e.methodology); changed.offerSchedule!.offers[0] = { ...original, [field]: `${original[field]}*` };
    expect(() => parseMethodology(changed)).toThrow();
  }
  for (const sourceUrl of ["http://alpha.example/prices", "https://user:password@alpha.example/prices", "https://alpha.example/prices?token=private", "https://alpha.example/prices#fragment"]) {
    const changed = structuredClone(e.methodology); changed.offerSchedule!.offers[0]!.sourceUrl = sourceUrl;
    expect(() => parseMethodology(changed)).toThrow();
  }
});

test("literal global and unspecified region labels are exact matches, never regional wildcards", () => {
  for (const region of ["global", "unspecified"]) {
    const e = fixture(); e.observations[0]!.region = region; e.methodology.offerSchedule!.offers[0]!.region = region;
    expect(snapshot(e).publishable).toBe(true);
    const wrong = batches(e, observations => observations.map(o => ({ ...o, region: o.provider === "alpha" ? "other-region" : o.region })));
    expect(calculate(wrong, e.registry, e.methodology, NOW).publishable).toBe(false);
  }
});

test("scheduled providers, sources, hosts and exact economic group weights are configuration-bound", () => {
  const changes: Array<(e: Fixture) => void> = [
    e => { e.methodology.offerSchedule!.offers[0]!.provider = "unknown"; },
    e => { e.methodology.offerSchedule!.offers[0]!.source = "unknown-source"; },
    e => { e.methodology.offerSchedule!.offers[0]!.sourceUrl = "https://unadmitted.example/prices"; },
    e => { e.registry.providers[0]!.economicGroup = "unweighted-group"; },
    e => { e.methodology.providerWeights.B200.extra = 1; },
    e => { e.methodology.offerSchedule!.offers = e.methodology.offerSchedule!.offers.filter(o => o.provider !== "gamma"); },
  ];
  for (const change of changes) { const e = fixture(); change(e); expect(() => snapshot(e)).toThrow(); }
});

const identityMutations: Array<[string, (o: Observation) => Observation]> = [
  ["provider", o => ({ ...o, provider: "unknown" })], ["source", o => ({ ...o, source: "another-api" })],
  ["SKU", o => ({ ...o, sku: `${o.sku}-changed` })], ["region", o => ({ ...o, region: "other-region" })],
  ["model", o => ({ ...o, model: "B300" })], ["GPU count", o => ({ ...o, gpuCount: 4, instancePrice: String(Number(o.price) * 4) })],
  ["topology", o => ({ ...o, topology: "UNKNOWN" })], ["missing topology", o => { delete o.topology; return o; }],
  ["minimum order", o => ({ ...o, minimumOrderGpuCount: 16 })], ["missing minimum order", o => { delete o.minimumOrderGpuCount; return o; }],
  ["record ID", o => ({ ...o, sourceRecordId: `${o.sourceRecordId}-changed` })],
  ["missing record ID", o => { delete o.sourceRecordId; return o; }],
  ["URL path", o => ({ ...o, sourceUrl: `${o.sourceUrl}/` })], ["URL query", o => ({ ...o, sourceUrl: `${o.sourceUrl}?page=1` })],
  ["nonpublic price", o => ({ ...o, priceScope: "ACCOUNT_SPECIFIC" })], ["missing public evidence", o => { delete o.priceScope; return o; }],
];
for (const [name, change] of identityMutations) test(`scheduled admission fails closed after changing ${name}`, () => {
  const e = fixture(), changed = batches(e, observations => observations.map(o => o.provider === "alpha" ? change(o) : o));
  const value = calculate(changed, e.registry, e.methodology, NOW);
  expect(value.publishable).toBe(false); expect(model(value).status).toBe("UNAVAILABLE");
});

test("included components match as an exact set without accepting duplicates or substituted bundles", () => {
  const e = fixture();
  const reordered = batches(e, observations => observations.map(o => ({ ...o, includes: [...o.includes].reverse() })));
  expect(calculate(reordered, e.registry, e.methodology, NOW)).toMatchObject({ publishable: true });
  for (const includes of [["gpu", "cpu"], ["gpu", "cpu", "memory", "storage"], ["gpu", "cpu", "memory", "memory"]]) {
    const changed = batches(e, observations => observations.map(o => o.provider === "alpha" ? { ...o, includes } : o));
    expect(calculate(changed, e.registry, e.methodology, NOW).publishable).toBe(false);
  }
});

test("an explicitly unknown minimum order matches null or absence but never an inferred count", () => {
  const e = fixture(); e.methodology.offerSchedule!.offers[0]!.minimumOrderGpuCount = null;
  for (const minimumOrderGpuCount of [null, undefined]) {
    const changed = batches(e, observations => observations.map(o => {
      if (o.provider === "alpha") {
        if (minimumOrderGpuCount === undefined) delete o.minimumOrderGpuCount;
        else o.minimumOrderGpuCount = minimumOrderGpuCount;
      }
      return o;
    }));
    expect(calculate(changed, e.registry, e.methodology, NOW).publishable).toBe(true);
  }
  expect(snapshot(e).publishable).toBe(false);
});

for (const field of ["sourceUrl", "sourceRecordId"] as const) test(`different scheduled ${field} records cannot pool operator votes`, () => {
  const e = fixture(), second = addAlphaOffer(e, field);
  expect(snapshot(e).publishable).toBe(true);
  const divided = batches(e, (observations, operator) => observations.filter(o => o.provider !== "alpha" ||
    (operator === 2 ? o[field] === second[field] : o[field] !== second[field])));
  expect(calculate(divided, e.registry, e.methodology, NOW).publishable).toBe(false);
});

for (const loss of ["absent", "stale", "expired", "quorum"] as const) test(`one ${loss} scheduled offer blocks its otherwise covered provider`, () => {
  const e = fixture(), extra = addAlphaOffer(e);
  expect(snapshot(e).publishable).toBe(true);
  const changed = batches(e, (observations, operator) => observations
    .filter(o => o.sku !== extra.sku || (loss !== "absent" && (loss !== "quorum" || operator !== 0)))
    .map(o => o.sku !== extra.sku ? o : { ...o,
      ...(loss === "stale" ? { observedAt: NOW - e.methodology.maxAgeMs - 1 } : {}),
      ...(loss === "expired" ? { expiresAt: NOW } : {}) }));
  const value = calculate(changed, e.registry, e.methodology, NOW);
  expect(value.feeds.find(feed => feed.id === "SBX:alpha:B200")!.status).toBe("UNAVAILABLE");
  expect(value.publishable).toBe(false);
});

test("losing one selected provider cannot silently change its economic-group median", () => {
  const e = fixture(), sibling = addSibling(e, true); expect(snapshot(e).publishable).toBe(true);
  const changed = batches(e, observations => observations.filter(o => o.provider !== sibling.provider));
  const value = calculate(changed, e.registry, e.methodology, NOW);
  expect(value.feeds.find(feed => feed.id === "SBX:alpha:B200")!.status).toBe("READY");
  expect(value.publishable).toBe(false);
});

test("an unscheduled economic-group sibling cannot alter the price or substitute for a required provider", () => {
  const e = fixture(); addSibling(e, false);
  e.observations.find(o => o.provider === "alpha-second")!.price = "1";
  e.observations.find(o => o.provider === "alpha-second")!.instancePrice = "8";
  const ready = snapshot(e); expect(ready.publishable).toBe(true); expect(model(ready).price).toBe("3.250000");
  const substituted = batches(e, observations => observations.filter(o => o.provider !== "alpha"));
  expect(calculate(substituted, e.registry, e.methodology, NOW).publishable).toBe(false);
});

test("schedule selection preserves draft, future, rights, operator and dispersion interlocks", () => {
  const changes: Array<(e: Fixture) => void> = [
    e => { e.methodology.status = "DRAFT"; }, e => { e.methodology.effectiveAt = NOW + 1; },
    e => { e.registry.providers[0]!.rights.derive = false; }, e => { e.registry.providers[0]!.rights.expiresAt = NOW; },
    e => { e.registry.operators[0]!.enabled = false; }, e => { e.methodology.maxProviderDispersionBps = 1; },
  ];
  for (const change of changes) { const e = fixture(); change(e); expect(snapshot(e).publishable).toBe(false); }
});

test("schedule changes invalidate the previously approved Pyth methodology binding", () => {
  const e = fixture(), value = snapshot(e);
  const binding = { indexFeedId: "SBX:B200", pythFeedId: 12, symbol: "TEST.SBXB200/USD", exponent: -6, minPublishers: 3 };
  const manifest: PythManifest = { schemaVersion: 1, enabled: true, network: e.registry.network,
    methodologyHash: value.methodologyHash, registryHash: value.registryHash, publicationScope: { kind: "MODEL", model: "B200" },
    agentUrl: "ws://127.0.0.1:8910/v1/jrpc", maxAgeMs: 30_000, futureToleranceMs: 1000,
    approval: { status: "APPROVED", publisherPublicKey: "11111111111111111111111111111111", evidence: "Synthetic Pyth fixture",
      verifiedAt: NOW - 1000, expiresAt: NOW + 100_000, protocol: PYTH_PROTOCOL, relayerUrls: ["wss://publisher.example.test/v1/transaction"] }, bindings: [binding] };
  const catalog = [{ pyth_lazer_id: 12, symbol: binding.symbol, exponent: -6, min_publishers: 3, state: "stable" }];
  expect(preparePythPublication(value, manifest, catalog, NOW).status).toBe("PREPARED");
  for (const mutate of [
    (methodology: Methodology) => { methodology.offerSchedule!.approvalEvidence += " revised"; },
    (methodology: Methodology) => { delete methodology.offerSchedule; },
  ]) {
    const changed = structuredClone(e.methodology); mutate(changed);
    const revised = calculate(batches(e), e.registry, changed, NOW);
    expect(revised.methodologyHash).not.toBe(value.methodologyHash);
    expect(() => preparePythPublication(revised, manifest, catalog, NOW)).toThrow();
  }
});
