// Signed synthetic inputs and approval records only; no live configuration changes.
import { expect, test } from "bun:test";
import { defaultMethodology, defaultRegistry } from "../src/config";
import { canonical, hash, signBatch } from "../src/crypto";
import { calculate } from "../src/engine";
import { OracleNode } from "../src/network";
import { assertSnapshotPublicationScope, isFeedPublishable } from "../src/publication";
import { qualifyModel } from "../src/qualification";
import { Store } from "../src/store";
import { parseMethodology } from "../src/validation";
import type { PublicationScope } from "../src/types";
import { environment, NOW } from "./helpers";

const scope: PublicationScope = { kind: "MODEL", model: "B200" };
function fixture() {
  const e = environment();
  e.methodology.publicationScope = { ...scope, approvalEvidence: "Synthetic local scope approval only" };
  for (const model of ["B300", "GB200", "GB300"] as const) e.methodology.providerWeights[model] = {};
  const batches = e.batches.map((batch, index) => signBatch({ ...batch.payload,
    observations: batch.payload.observations.filter(value => value.model === "B200") }, e.identities[index]!));
  return { ...e, batches };
}

test("absent scope preserves pre-change canonical methodology and snapshot hashes", () => {
  // Recorded by executing the bca1332 engine, before the policy extension.
  const methodology = defaultMethodology(), registry = defaultRegistry("sbx-test");
  expect(hash(parseMethodology(methodology))).toBe("aedd0a2173ffb2b30b8ccd4dc03d0d565049152981e5af744ee4281633a4fb14");
  const snapshot = calculate([], registry, methodology, NOW);
  expect(hash(snapshot)).toBe("38856bf09207f6342e0517ea5d1e0c01146f6f14c39420aaee12a1a8701fcf02");
  expect(canonical(snapshot)).not.toContain("publicationScope");
  const e = environment(), full = calculate(e.batches, e.registry, e.methodology, NOW);
  expect(full.publishable).toBe(true); expect(full.publicationScope).toBeUndefined();
  const onlyB200 = e.batches.map((batch, index) => signBatch({ ...batch.payload,
    observations: batch.payload.observations.filter(value => value.model === "B200") }, e.identities[index]!));
  expect(calculate(onlyB200, e.registry, e.methodology, NOW).publishable).toBe(false);
  e.methodology.providerWeights.B300 = {};
  expect(() => parseMethodology(e.methodology)).toThrow("B300: insufficient");
});

test("B200 scope requires explicit evidence and rejects broader or malformed policies", () => {
  const e = fixture();
  for (const publicationScope of [null, {}, { ...scope, approvalEvidence: "" }, { ...scope, approvalEvidence: "   " },
    { ...scope, model: "B300", approvalEvidence: "test" }, { ...scope, approvalEvidence: "test", extra: true }]) {
    expect(() => parseMethodology({ ...e.methodology, publicationScope })).toThrow();
  }
  e.methodology.providerWeights.B200 = { alpha: 1, beta: 1 };
  expect(() => parseMethodology(e.methodology)).toThrow("B200: insufficient");
  expect(() => parseMethodology({ ...e.methodology, minProviderGroups: 2 })).toThrow();
  expect(() => parseMethodology({ ...e.methodology, minOperatorGroups: 1 })).toThrow();
});

test("a scoped B200 calculation does not require or publish other models or their composite", () => {
  const e = fixture(), snapshot = calculate(e.batches, e.registry, e.methodology, NOW);
  expect(snapshot.publishable).toBe(true); expect(snapshot.publicationScope).toEqual(scope);
  expect(snapshot.feeds.find(feed => feed.id === "SBX:B200")!.price).toBe("3.250000");
  expect(snapshot.feeds.find(feed => feed.id === "SBX")!.status).toBe("UNAVAILABLE");
  expect(snapshot.methodologyHash).toBe(hash(e.methodology)); expect(snapshot.registryHash).toBe(hash(e.registry));
  expect(snapshot.publicationScope).not.toHaveProperty("approvalEvidence");
  expect(snapshot.feeds.filter(feed => isFeedPublishable(snapshot, feed.id)).map(feed => feed.id)).toEqual(["SBX:B200"]);
  const diagnostic = qualifyModel(e.batches, e.registry, e.methodology, "B200", NOW);
  expect(diagnostic.currentModelPublishable).toBe(true); expect(diagnostic.blockers).toEqual([]);
  expect(diagnostic.liveMarketQualified).toBe(false);
  expect(qualifyModel(e.batches, e.registry, e.methodology, "B300", NOW).blockers).toContain("MODEL_OUTSIDE_PUBLICATION_SCOPE");
  const changed = structuredClone(e.methodology); changed.publicationScope!.approvalEvidence += " renewed";
  expect(calculate(e.batches, e.registry, changed, NOW).methodologyHash).not.toBe(snapshot.methodologyHash);
});

for (const scenario of ["draft", "future", "expired-rights", "missing-rights", "missing-group", "operator-quorum", "stale", "source-future", "dispersion", "account-specific", "spot"] as const) {
  test(`scoped publication preserves the ${scenario} gate`, () => {
    const e = fixture(); let at = NOW;
    if (scenario === "draft") e.methodology.status = "DRAFT";
    if (scenario === "future") e.methodology.effectiveAt = NOW + 1;
    if (scenario === "expired-rights") e.registry.providers[0]!.rights.expiresAt = NOW;
    if (scenario === "missing-rights") e.registry.providers[0]!.rights.derive = false;
    if (scenario === "operator-quorum") e.registry.operators[0]!.enabled = false;
    if (scenario === "stale") at += e.methodology.maxAgeMs + 1;
    if (scenario === "dispersion") e.methodology.maxProviderDispersionBps = 1;
    const batches = e.batches.map((batch, index) => signBatch({ ...batch.payload, observations: batch.payload.observations
      .filter(value => scenario !== "missing-group" || value.provider !== "gamma")
      .map(value => ({ ...value, ...(scenario === "source-future" ? { observedAt: NOW + e.methodology.futureToleranceMs + 1 } : {}),
        ...(scenario === "account-specific" ? { priceScope: "ACCOUNT_SPECIFIC" as const } : {}),
        ...(scenario === "spot" ? { procurement: "SPOT" as const } : {}) })) }, e.identities[index]!));
    expect(calculate(batches, e.registry, e.methodology, at).publishable).toBe(false);
  });
}

test("scope cannot relabel a provider or different model as the admitted model feed", () => {
  const e = fixture(), snapshot = calculate(e.batches, e.registry, e.methodology, NOW);
  for (const patch of [{ kind: "PROVIDER" }, { model: "B300" }, { provider: "alpha" }]) {
    const changed = structuredClone(snapshot); Object.assign(changed.feeds.find(feed => feed.id === "SBX:B200")!, patch);
    expect(() => assertSnapshotPublicationScope(changed, scope)).toThrow("feed identity");
  }
  expect(() => assertSnapshotPublicationScope(snapshot, undefined)).toThrow("scope");
});

test("API publication flags follow the approved scope even when all model feeds calculate", async () => {
  const e = environment(); e.methodology.publicationScope = { ...scope, approvalEvidence: "Synthetic API scope approval" };
  const store = new Store(":memory:"), node = new OracleNode({ identity: e.identities[0]!, registry: e.registry, methodology: e.methodology, store, clock: () => NOW });
  try {
    for (const batch of e.batches) node.receive(batch);
    const ready = await node.handle(new Request("http://node/v1/ready"));
    expect(ready.status).toBe(200); expect(await ready.json() as Record<string, unknown>).toEqual({ publishable: true, publicationScope: scope });
    for (const id of ["SBX:B200", "SBX:B300", "SBX:alpha:B200", "SBX"]) {
      const response = await node.handle(new Request(`http://node/v1/feeds/${encodeURIComponent(id)}`));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ publishable: id === "SBX:B200", publicationScope: scope });
    }
  } finally { store.close(); }
});
