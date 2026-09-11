// Synthetic responses only. Replay fetch always resolves against memory, never the network.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { auditB200Sources } from "../src/source-audit";
import { defaultMethodology, defaultRegistry } from "../src/config";
import { lambda } from "../src/collectors/lambda";
import { oracle } from "../src/collectors/oracle";
import { runpod } from "../src/collectors/runpod";
import { verda } from "../src/collectors/verda";
import { Store } from "../src/store";
import type { Collector, Observation } from "../src/types";
import { NOW } from "./helpers";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
async function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const registry = defaultRegistry("sbx-audit-test"), methodology = defaultMethodology();
  const observations: Observation[] = [];
  for (const collector of [oracle, verda] as Collector[]) {
    const result = await collector.collect({ now: () => NOW, env: {}, archive: async record => store.archive(record),
      fetch: (async input => {
        const url = new URL(String(input));
        const body = collector === oracle ? { items: [{ partNumber: url.searchParams.get("partNumber"), metricName: "GPU Per Hour",
          currencyCodeLocalizations: [{ currencyCode: "USD", prices: [{ model: "PAY_AS_YOU_GO", value: 14 }] }] }] } : [1, 8].map(gpus => ({
          id: `test-b200-${gpus}`, model: "B200", instance_type: `${gpus}B200.${gpus * 30}V`, description: "Dedicated Hardware Instance", manufacturer: "NVIDIA",
          gpu: { number_of_gpus: gpus, description: `${gpus}x B200 GPU` }, cpu: { number_of_cores: gpus * 30 }, memory: { size_in_gigabytes: gpus * 100 },
          currency: "usd", price_per_hour: String(6 * gpus), spot_price: String(3 * gpus) }));
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      }) as typeof fetch });
    expect(result.errors).toEqual([]); observations.push(...result.observations);
  }
  store.capture(observations, [], NOW);
  return { store, registry, methodology, observations };
}

test("current collectors reproduce every B200 field from hash-verified bytes without network or writes", async () => {
  const { store, registry, methodology, observations } = await fixture();
  store.capture(observations.map(value => ({ ...value, observedAt: NOW + 300_000 })), [], NOW + 300_000);
  const before = store.db.query("SELECT * FROM captures").all(), evidenceBefore = store.db.query("SELECT * FROM evidence").all();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("LIVE_FETCH_FORBIDDEN"); }) as unknown as typeof fetch;
  try {
    const options = { asOf: NOW + 300_000, expectedIntervalMs: 300_000 };
    const audit = await auditB200Sources(store.db, registry, methodology, options);
    expect(audit.status).toBe("LOCAL_REPLAY_PASSED");
    expect(audit.summary).toMatchObject({ observationCount: 10, observationsReproduced: 10, evidenceRecords: 2, evidenceHashesVerified: 2,
      eligibleSeries: 3, configuredEconomicGroupsObserved: 2, independentlyVerifiedEconomicGroups: null });
    expect(audit.publishable).toBe(false); expect(audit.liveMarketQualified).toBe(false);
    expect(audit.providers.every(value => !value.derivationConfigured && value.derivativesRightsReview === "NOT_ESTABLISHED")).toBe(true);
    expect(audit.comparabilityIssues).toContain("BUNDLED_COMPONENTS_DIFFER"); expect(audit.comparabilityIssues).toContain("PHYSICAL_INSTANCE_SIZES_DIFFER");
    expect(audit.offers.filter(value => value.terms.procurement === "SPOT").every(value => !value.inResearchCohort)).toBe(true);
    expect(await auditB200Sources(store.db, registry, methodology, options)).toEqual(audit);
    expect(store.db.query("SELECT * FROM captures").all()).toEqual(before); expect(store.db.query("SELECT * FROM evidence").all()).toEqual(evidenceBefore);
  } finally { globalThis.fetch = originalFetch; }
});

test("changed observation price or provenance cannot pass by referencing an intact response hash", async () => {
  for (const change of [{ price: "99.000000", instancePrice: "792.000000" }, { sourceUrl: "https://attacker.example/private-token" }]) {
    const { store, registry, methodology, observations } = await fixture();
    const rows = observations.map(value => value.model === "B200" && value.provider === "oracle" ? { ...value, ...change } : value);
    store.db.query("UPDATE captures SET observations=?").run(JSON.stringify(rows));
    const audit = await auditB200Sources(store.db, registry, methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
    expect(audit.status).toBe("LOCAL_REPLAY_FAILED"); expect(audit.summary.evidenceHashesVerified).toBe(2);
    expect(audit.offers.find(value => value.terms.provider === "oracle")!.issues).toContain("OBSERVATION_NOT_REPRODUCED_FROM_RETAINED_RESPONSE");
    expect(JSON.stringify(audit)).not.toContain("private-token");
  }
});

test("corrupt bodies and missing evidence remain failed, not approved or silently skipped", async () => {
  const { store, registry, methodology, observations } = await fixture();
  const digest = observations.find(value => value.model === "B200" && value.provider === "oracle")!.evidenceHash;
  store.db.query("UPDATE evidence SET body=? WHERE hash=?").run(new TextEncoder().encode("private malformed bytes"), digest);
  const corrupt = await auditB200Sources(store.db, registry, methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
  expect(corrupt.status).toBe("LOCAL_REPLAY_FAILED"); expect(corrupt.evidence.find(value => value.hash === digest)!.reasons).toContain("EVIDENCE_HASH_MISMATCH");
  expect(JSON.stringify(corrupt)).not.toContain("private malformed bytes");
  store.db.query("DELETE FROM evidence WHERE hash=?").run(digest);
  const missing = await auditB200Sources(store.db, registry, methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
  expect(missing.status).toBe("LOCAL_REPLAY_FAILED"); expect(missing.evidence.find(value => value.hash === digest)!.reasons).toContain("EVIDENCE_MISSING");
});

test("knowledge cutoffs do not admit late captures or evidence first archived after the observation", async () => {
  const { store, registry, methodology, observations } = await fixture();
  store.capture(observations.map(value => ({ ...value, observedAt: NOW + 1 })), [], NOW + 1);
  const early = await auditB200Sources(store.db, registry, methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
  expect(early.window.captures).toBe(1); expect(early.summary.observationCount).toBe(5);
  store.db.query("UPDATE evidence SET received_at=?").run(NOW + 2);
  const future = await auditB200Sources(store.db, registry, methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
  expect(future.status).toBe("LOCAL_REPLAY_FAILED"); expect(future.completeness.bytesRead).toBe(0);
  const late = await auditB200Sources(store.db, registry, methodology, { asOf: NOW + 2, expectedIntervalMs: 300_000 });
  expect(late.status).toBe("LOCAL_REPLAY_FAILED"); expect(late.summary.observationsReproduced).toBe(0);
});

test("byte and record limits are explicit, and configured economic aliases do not create independence", async () => {
  const { store, registry, methodology } = await fixture();
  registry.providers.find(value => value.id === "verda")!.economicGroup = "oracle";
  const common = { asOf: NOW, expectedIntervalMs: 300_000 };
  const audit = await auditB200Sources(store.db, registry, methodology, common);
  expect(audit.summary.configuredEconomicGroupsObserved).toBe(1); expect(audit.summary.independentlyVerifiedEconomicGroups).toBeNull();
  expect((await auditB200Sources(store.db, registry, methodology, { ...common, maxEvidenceRecords: 1 })).status).toBe("INCOMPLETE");
  const bounded = await auditB200Sources(store.db, registry, methodology, { ...common, maxEvidenceBytes: 1 });
  expect(bounded.status).toBe("INCOMPLETE"); expect(bounded.completeness.bytesRead).toBe(0);
  expect((await auditB200Sources(store.db, registry, methodology, { ...common, maxObservations: 1 })).status).toBe("INCOMPLETE");
});

test("unsupported collectors and unapproved archive origins cannot pass source replay", async () => {
  const { store, registry, methodology } = await fixture();
  store.db.query("UPDATE evidence SET url=? WHERE source=?").run("https://attacker.example/secret-query", "oracle-public");
  const audit = await auditB200Sources(store.db, registry, methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
  expect(audit.status).toBe("LOCAL_REPLAY_FAILED");
  expect(audit.evidence.find(value => value.source === "oracle-public")!.reasons).toContain("SOURCE_METADATA_NOT_ADMITTED");
  expect(JSON.stringify(audit)).not.toContain("secret-query");
  store.db.query("UPDATE evidence SET source=? WHERE source=?").run("unsupported-source", "oracle-public");
  const unsupported = await auditB200Sources(store.db, registry, methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
  expect(unsupported.status).toBe("LOCAL_REPLAY_FAILED"); expect(unsupported.evidence.some(value => value.reasons.includes("COLLECTOR_REPLAY_UNSUPPORTED"))).toBe(true);
});

test("an empty journal is no evidence, and a hash-correct malformed response still fails reproduction", async () => {
  const store = new Store(":memory:"); stores.push(store);
  const registry = defaultRegistry("sbx-audit-test"), methodology = defaultMethodology(), options = { asOf: NOW, expectedIntervalMs: 300_000 };
  expect((await auditB200Sources(store.db, registry, methodology, options)).status).toBe("NO_B200_DATA");
  store.capture([], [], NOW);
  store.db.query("UPDATE captures SET observations='invalid-json'").run();
  const malformedCapture = await auditB200Sources(store.db, registry, methodology, options);
  expect(malformedCapture.status).toBe("LOCAL_REPLAY_FAILED"); expect(malformedCapture.anomalies.INVALID_CAPTURE_JSON).toBe(1);
  store.db.query("DELETE FROM captures").run();
  const f = await fixture(), body = new TextEncoder().encode("{}");
  const digest = createHash("sha256").update(body).digest("hex"), original = f.observations.find(value => value.model === "B200" && value.provider === "oracle")!;
  await store.archive({ hash: digest, body, source: original.source, url: original.sourceUrl, receivedAt: NOW, contentType: "application/json" });
  store.capture([{ ...original, evidenceHash: digest }], [], NOW);
  const audit = await auditB200Sources(store.db, registry, methodology, options);
  expect(audit.status).toBe("LOCAL_REPLAY_FAILED"); expect(audit.summary.evidenceHashesVerified).toBe(1);
  expect(audit.summary.observationsReproduced).toBe(0);
});

async function runpodFixture(counts: readonly number[] | null = null) {
  const f = await fixture();
  const result = await runpod.collect({ now: () => NOW, env: { RUNPOD_API_KEY: "isolated-fixture-key" },
    archive: async record => { expect(record.url).toBe("https://api.runpod.io/graphql"); await f.store.archive(record); },
    fetch: (async () => new Response(JSON.stringify({ data: { gpuTypes: [{ id: "NVIDIA B200", secureCloud: true,
      lowestPrice: { stockStatus: "Low", availableGpuCounts: counts, uninterruptablePrice: 2.5 } }] } }),
      { headers: { "content-type": "application/json" } })) as unknown as typeof fetch });
  expect(result.errors).toEqual([]);
  f.store.capture(result.observations, [], NOW);
  return { ...f, runpodObservation: result.observations[0]! };
}

test.each([null, [1], [8]].map(counts => ({ counts })))("Runpod archive replay preserves inventory case %# without a real credential or network", async ({ counts }) => {
  const f = await runpodFixture(counts), originalFetch = globalThis.fetch;
  const before = f.store.db.query("SELECT * FROM evidence").all();
  globalThis.fetch = (() => { throw new Error("LIVE_FETCH_FORBIDDEN"); }) as unknown as typeof fetch;
  try {
    const audit = await auditB200Sources(f.store.db, f.registry, f.methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
    expect(audit.status).toBe("LOCAL_REPLAY_PASSED");
    expect(audit.summary).toMatchObject({ observationsReproduced: 6, observationCount: 6, evidenceHashesVerified: 3,
      configuredEconomicGroupsObserved: 3, independentlyVerifiedEconomicGroups: null });
    expect(audit.evidence.find(value => value.source === "runpod-secure")).toMatchObject({ matchedArchiveRequests: 1, missingArchiveRequests: 0, reasons: [] });
    const offer = audit.offers.find(value => value.terms.provider === "runpod")!;
    expect(offer.terms).toMatchObject({ gpuCount: 1, includes: ["gpu"], minimumOrderGpuCount: counts?.[0] ?? null });
    expect(offer.unknowns).toContain("GEOGRAPHIC_OFFER_NOT_ESTABLISHED");
    if (counts === null) expect(offer.unknowns).toContain("EXECUTABLE_AVAILABILITY_UNKNOWN");
    if (counts?.[0] === 8) expect(offer.unknowns).toContain("EXECUTABLE_AVAILABILITY_UNAVAILABLE");
    expect(audit.publishable).toBe(false); expect(audit.liveMarketQualified).toBe(false);
    expect(JSON.stringify(audit)).not.toContain("isolated-fixture-key");
    expect(JSON.stringify(audit)).not.toContain("sbx-offline-replay-not-a-credential");
    expect(f.store.db.query("SELECT * FROM evidence").all()).toEqual(before);
    f.registry.providers.find(value => value.id === "runpod")!.economicGroup = "verda";
    const aliased = await auditB200Sources(f.store.db, f.registry, f.methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
    expect(aliased.summary.configuredEconomicGroupsObserved).toBe(2);
  } finally { globalThis.fetch = originalFetch; }
});

test("Runpod inventory or bundle claims cannot change while referencing the original response", async () => {
  for (const change of [{ availability: "AVAILABLE" }, { includes: ["gpu", "cpu", "memory"] }]) {
    const f = await runpodFixture();
    f.store.db.query("UPDATE captures SET observations=? WHERE id=(SELECT MAX(id) FROM captures)")
      .run(JSON.stringify([{ ...f.runpodObservation, ...change }]));
    const audit = await auditB200Sources(f.store.db, f.registry, f.methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
    expect(audit.status).toBe("LOCAL_REPLAY_FAILED");
    expect(audit.offers.find(value => value.terms.provider === "runpod")!.issues).toContain("OBSERVATION_NOT_REPRODUCED_FROM_RETAINED_RESPONSE");
  }
});

test.each(["https://api.runpod.io/graphql?api_key=private-fixture-token", "https://api.runpod.io/graphql?query=other", "https://api.runpod.io/other"])(
  "Runpod evidence must retain the exact credential-free endpoint %#", async url => {
    const f = await runpodFixture();
    f.store.db.query("UPDATE evidence SET url=? WHERE source='runpod-secure'").run(url);
    const audit = await auditB200Sources(f.store.db, f.registry, f.methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
    expect(audit.status).toBe("LOCAL_REPLAY_FAILED");
    expect(audit.evidence.find(value => value.source === "runpod-secure")!.reasons).toContain("RUNPOD_ARCHIVE_URL_NOT_CANONICAL");
    expect(audit.evidence.find(value => value.source === "runpod-secure")!.matchedArchiveRequests).toBe(0);
    expect(JSON.stringify(audit)).not.toContain("private-fixture-token");
  });

async function lambdaFixture(regions: readonly string[] = ["us-west-1"], resources = false) {
  const f = await fixture();
  const result = await lambda.collect({ now: () => NOW, env: { LAMBDA_API_KEY: "isolated-lambda-fixture-key", ...(resources ? { LAMBDA_INSTANCE_RESOURCES: "1" } : {}) },
    archive: async record => { expect(record.url).toBe("https://cloud.lambda.ai/api/v1/instance-types"); await f.store.archive(record); },
    fetch: (async () => new Response(JSON.stringify({ data: { "fixture-b200-8": {
      instance_type: { name: "fixture-b200-8", gpu_description: "NVIDIA B200 SXM6", price_cents_per_hour: 5352,
        specs: { gpus: 8, vcpus: 208, memory_gib: 2900, storage_gib: 22528 } },
      regions_with_capacity_available: regions.map(name => ({ name })),
    } } }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch });
  expect(result.errors).toEqual([]);
  f.store.capture(result.observations, [], NOW);
  return { ...f, lambdaObservations: result.observations };
}

test.each([[], ["us-west-1"], ["us-west-1", "us-south-1"]].map(regions => ({ regions })))(
  "Lambda archive replay preserves full-instance price and regional capacity case %# without inventing topology or rights", async ({ regions }) => {
    const f = await lambdaFixture(regions), originalFetch = globalThis.fetch;
    const before = f.store.db.query("SELECT * FROM evidence").all(), capturesBefore = f.store.db.query("SELECT * FROM captures").all();
    globalThis.fetch = (() => { throw new Error("LIVE_FETCH_FORBIDDEN"); }) as unknown as typeof fetch;
    try {
      const audit = await auditB200Sources(f.store.db, f.registry, f.methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
      expect(audit.status).toBe("LOCAL_REPLAY_PASSED");
      expect(audit.summary).toMatchObject({ observationCount: 5 + Math.max(regions.length, 1),
        observationsReproduced: 5 + Math.max(regions.length, 1), evidenceHashesVerified: 3,
        configuredEconomicGroupsObserved: 3, independentlyVerifiedEconomicGroups: null });
      expect(audit.evidence.find(value => value.source === "lambda-cloud")).toMatchObject({
        matchedArchiveRequests: 1, missingArchiveRequests: 0, reasons: [], replayedB200Observations: Math.max(regions.length, 1) });
      const offers = audit.offers.filter(value => value.terms.provider === "lambda");
      expect(offers.map(value => value.terms.region).sort()).toEqual(regions.length ? [...regions].sort() : ["global"]);
      for (const offer of offers) {
        expect(offer.terms).toMatchObject({ gpuCount: 8, minimumOrderGpuCount: 8, topology: "UNKNOWN",
          includes: ["cpu", "gpu", "local-storage", "memory"], sku: "fixture-b200-8" });
        expect(offer.latestPrice).toBe("6.690000");
        expect(offer.unknowns).toContain("TOPOLOGY_UNKNOWN");
        if (!regions.length) {
          expect(offer.unknowns).toContain("GEOGRAPHIC_OFFER_NOT_ESTABLISHED");
          expect(offer.unknowns).toContain("EXECUTABLE_AVAILABILITY_UNAVAILABLE");
        }
      }
      expect(f.lambdaObservations.every(value => value.instancePrice === "53.520000")).toBe(true);
      expect(audit.providers.find(value => value.provider === "lambda")).toMatchObject({ collectionConfigured: false,
        redistributionConfigured: false, derivationConfigured: false, ownershipVerification: "NOT_ESTABLISHED", derivativesRightsReview: "NOT_ESTABLISHED" });
      expect(audit.publishable).toBe(false); expect(audit.liveMarketQualified).toBe(false);
      expect(audit.limitations.some(value => value.includes("Lambda replay") && value.includes("not independently verified"))).toBe(true);
      expect(JSON.stringify(audit)).not.toContain("isolated-lambda-fixture-key");
      expect(JSON.stringify(audit)).not.toContain("sbx-offline-lambda-replay-not-a-credential");
      expect(f.store.db.query("SELECT * FROM evidence").all()).toEqual(before);
      expect(f.store.db.query("SELECT * FROM captures").all()).toEqual(capturesBefore);
    } finally { globalThis.fetch = originalFetch; }
  });

test("Lambda archive replay rejects forged topology, bundle, GPU count, region, source record and full-instance price", async () => {
  for (const change of [{ topology: "HGX" }, { includes: ["gpu"] }, { gpuCount: 4, price: "13.380000" },
    { region: "us-south-1" }, { sourceRecordId: "other-record" }, { price: "7.000000", instancePrice: "56.000000" }]) {
    const f = await lambdaFixture();
    f.store.db.query("UPDATE captures SET observations=? WHERE id=(SELECT MAX(id) FROM captures)")
      .run(JSON.stringify(f.lambdaObservations.map(value => ({ ...value, ...change }))));
    const audit = await auditB200Sources(f.store.db, f.registry, f.methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
    expect(audit.status).toBe("LOCAL_REPLAY_FAILED");
    expect(audit.offers.find(value => value.terms.provider === "lambda")!.issues).toContain("OBSERVATION_NOT_REPRODUCED_FROM_RETAINED_RESPONSE");
  }
});

test.each(["https://cloud.lambda.ai/api/v1/instance-types?token=private-lambda-token", "https://cloud.lambda.ai/api/v1/instance-types?region=us-west-1",
  "https://cloud.lambda.ai/api/v1/instances"])("Lambda evidence requires the exact credential-free instance-types endpoint %#", async url => {
  const f = await lambdaFixture();
  f.store.db.query("UPDATE evidence SET url=? WHERE source='lambda-cloud'").run(url);
  const audit = await auditB200Sources(f.store.db, f.registry, f.methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
  expect(audit.status).toBe("LOCAL_REPLAY_FAILED");
  expect(audit.evidence.find(value => value.source === "lambda-cloud")!.reasons).toContain("LAMBDA_ARCHIVE_URL_NOT_CANONICAL");
  expect(audit.evidence.find(value => value.source === "lambda-cloud")!.matchedArchiveRequests).toBe(0);
  expect(JSON.stringify(audit)).not.toContain("private-lambda-token");
});

test("same retained Lambda response supports old and explicitly enriched observations without rewriting historical bytes", async () => {
  const f = await lambdaFixture(), options = { asOf: NOW, expectedIntervalMs: 300_000 };
  const before = await auditB200Sources(f.store.db, f.registry, f.methodology, options);
  const oldCaptures = f.store.db.query("SELECT * FROM captures").all(), oldEvidence = f.store.db.query("SELECT * FROM evidence").all();
  const digest = f.lambdaObservations[0]!.evidenceHash;
  const { body } = f.store.db.query("SELECT body FROM evidence WHERE hash=?").get(digest) as { body: Uint8Array };
  const result = await lambda.collect({ now: () => NOW + 300_000,
    env: { LAMBDA_API_KEY: "new-fixture-key", LAMBDA_INSTANCE_RESOURCES: "1" },
    fetch: (async () => new Response(body.slice(), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    archive: async record => f.store.archive(record) });
  expect(result.errors).toEqual([]); expect(result.observations[0]!.evidenceHash).toBe(digest);
  f.store.capture(result.observations, [], NOW + 300_000);
  expect(f.store.db.query("SELECT * FROM evidence").all()).toEqual(oldEvidence);
  expect(f.store.db.query("SELECT * FROM captures WHERE collected_at<=?").all(NOW)).toEqual(oldCaptures);
  expect(await auditB200Sources(f.store.db, f.registry, f.methodology, options)).toEqual(before);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("LIVE_FETCH_FORBIDDEN"); }) as unknown as typeof fetch;
  try {
    const audit = await auditB200Sources(f.store.db, f.registry, f.methodology, { ...options, asOf: NOW + 300_000 });
    expect(audit.status).toBe("LOCAL_REPLAY_PASSED");
    expect(audit.summary).toMatchObject({ observationCount: 7, observationsReproduced: 7, evidenceRecords: 3 });
    expect(audit.evidence.find(value => value.source === "lambda-cloud")).toMatchObject({ hash: digest, matchedArchiveRequests: 2,
      replayVariants: ["LEGACY", "INSTANCE_RESOURCES_V1"], replayedResourceB200Observations: 1, replayedB200Observations: 2, reasons: [] });
    const offers = audit.offers.filter(value => value.terms.provider === "lambda");
    expect(offers).toHaveLength(2);
    expect(offers.find(value => value.terms.instanceResources)!.terms.instanceResources).toEqual({ schemaVersion: 1,
      scope: "FULL_INSTANCE", vcpus: 208, memoryGiB: 2900, storageGiB: 22528 });
    expect(offers.find(value => !value.terms.instanceResources)!.unknowns).toContain("INSTANCE_RESOURCES_UNKNOWN");
    expect(offers.every(value => value.unknowns.includes("TOPOLOGY_UNKNOWN"))).toBe(true);
    expect(audit.publishable).toBe(false); expect(audit.liveMarketQualified).toBe(false);
    expect(JSON.stringify(audit)).not.toContain("new-fixture-key");
  } finally { globalThis.fetch = originalFetch; }
});

test("Lambda enriched replay rejects forged quantitative entitlements and does not fall back on legacy output", async () => {
  for (const field of ["vcpus", "memoryGiB", "storageGiB"] as const) {
    const f = await lambdaFixture(["us-west-1"], true);
    const changed = f.lambdaObservations.map(value => ({ ...value,
      instanceResources: { ...value.instanceResources!, [field]: value.instanceResources![field] + 1 } }));
    f.store.db.query("UPDATE captures SET observations=? WHERE id=(SELECT MAX(id) FROM captures)").run(JSON.stringify(changed));
    const audit = await auditB200Sources(f.store.db, f.registry, f.methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
    expect(audit.status).toBe("LOCAL_REPLAY_FAILED");
    expect(audit.offers.find(value => value.terms.provider === "lambda")!.issues).toContain("OBSERVATION_NOT_REPRODUCED_FROM_RETAINED_RESPONSE");
  }
  const f = await lambdaFixture(["us-west-1"], true), observation = f.lambdaObservations[0]!;
  const old = f.store.db.query("SELECT body FROM evidence WHERE hash=?").get(observation.evidenceHash) as { body: Uint8Array };
  const document = JSON.parse(new TextDecoder().decode(old.body)); delete document.data["fixture-b200-8"].instance_type.specs.vcpus;
  const body = new TextEncoder().encode(JSON.stringify(document)), digest = createHash("sha256").update(body).digest("hex");
  await f.store.archive({ hash: digest, body, source: "lambda-cloud", url: observation.sourceUrl, receivedAt: NOW, contentType: "application/json" });
  f.store.db.query("UPDATE captures SET observations=? WHERE id=(SELECT MAX(id) FROM captures)")
    .run(JSON.stringify([{ ...observation, evidenceHash: digest }]));
  const audit = await auditB200Sources(f.store.db, f.registry, f.methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
  expect(audit.status).toBe("LOCAL_REPLAY_FAILED");
  expect(audit.evidence.find(value => value.hash === digest)!.reasons).toContain("LAMBDA_INSTANCE_RESOURCES_REPLAY_FAILED");
  expect(audit.evidence.find(value => value.hash === digest)!.replayedResourceB200Observations).toBe(0);
  expect(audit.offers.find(value => value.terms.provider === "lambda")!.observationsReproduced).toBe(0);
});

test("reproduced Lambda resource changes remain separate offers and expose quantitative comparability", async () => {
  const f = await lambdaFixture(["us-west-1"], true), observation = f.lambdaObservations[0]!;
  const old = f.store.db.query("SELECT body FROM evidence WHERE hash=?").get(observation.evidenceHash) as { body: Uint8Array };
  const document = JSON.parse(new TextDecoder().decode(old.body)); document.data["fixture-b200-8"].instance_type.specs.memory_gib += 1;
  const result = await lambda.collect({ now: () => NOW + 300_000,
    env: { LAMBDA_API_KEY: "fixture", LAMBDA_INSTANCE_RESOURCES: "1" },
    fetch: (async () => new Response(JSON.stringify(document), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    archive: async record => f.store.archive(record) });
  expect(result.errors).toEqual([]); f.store.capture(result.observations, [], NOW + 300_000);
  const audit = await auditB200Sources(f.store.db, f.registry, f.methodology, { asOf: NOW + 300_000, expectedIntervalMs: 300_000 });
  expect(audit.status).toBe("LOCAL_REPLAY_PASSED");
  expect(audit.offers.filter(value => value.terms.provider === "lambda")).toHaveLength(2);
  expect(audit.comparabilityIssues).toContain("QUANTITATIVE_INSTANCE_RESOURCES_DIFFER");
  expect(audit.comparabilityIssues).toContain("INSTANCE_RESOURCES_UNKNOWN");
  expect(audit.offers.find(value => value.terms.provider === "oracle")!.unknowns).toContain("INSTANCE_RESOURCES_UNKNOWN");
  expect(audit.publishable).toBe(false); expect(audit.liveMarketQualified).toBe(false);
});
