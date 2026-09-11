/** Synthetic local resolver acceptance only; no production code imports this file. */
import { calculate } from "../src/engine";
import { hash, signBatch } from "../src/crypto";
import { fromMicros, toMicros } from "../src/decimal";
import { isFeedPublishable } from "../src/publication";
import type { Snapshot } from "../src/types";
import { environment, NOW } from "./helpers";

export function hip3SourceFixture() {
  const e = environment();
  e.methodology.publicationScope = { kind: "MODEL", model: "B200", approvalEvidence: "Synthetic local test only; no real approval" };
  for (const model of ["B300", "GB200", "GB300"] as const) e.methodology.providerWeights[model] = {};
  const price = "3.123457";
  const observations = e.observations.filter(o => o.model === "B200").map(o => ({ ...o, price, instancePrice: fromMicros(toMicros(price) * BigInt(o.gpuCount)) }));
  const batches = e.batches.map((b, i) => signBatch({ ...b.payload, observations }, e.identities[i]!));
  const summarize = (name: string, snapshot: Snapshot, feedId = "SBX:B200") => {
    const feed = snapshot.feeds.find(f => f.id === feedId)!;
    return { name, feedId, eligible: isFeedPublishable(snapshot, feedId), price: feed.price,
      observedAt: feed.observedAt, calculatedAt: feed.calculatedAt, status: feed.status,
      reasons: feed.reasons, snapshotHash: hash(snapshot), methodologyHash: snapshot.methodologyHash,
      registryHash: snapshot.registryHash, inputBatchCount: snapshot.inputBatchHashes.length };
  };
  const approved = calculate(batches, e.registry, e.methodology, NOW);
  const missing = batches.map((b, i) => signBatch({ ...b.payload, observations: b.payload.observations.filter(o => o.provider !== "gamma") }, e.identities[i]!));
  const tampered = structuredClone(batches);
  for (const b of tampered) b.payload.sequence++;
  return { schemaVersion: 1, fixtureOnly: true, network: e.registry.network, bunVersion: Bun.version,
    market: "localfixture", symbol: "B200", sourceName: "sbx_local_fixture", now: NOW,
    expectedPrice: price, expectedObservedAt: NOW - 1000,
    cases: [summarize("eligible_b200", approved),
      summarize("missing_fixed_constituent", calculate(missing, e.registry, e.methodology, NOW)),
      summarize("draft_methodology", calculate(batches, e.registry, { ...e.methodology, status: "DRAFT" }, NOW)),
      summarize("stale_source", calculate(batches, e.registry, e.methodology, NOW + e.methodology.maxAgeMs + 1001)),
      summarize("invalid_signatures", calculate(tampered, e.registry, e.methodology, NOW)),
      summarize("outside_approved_scope", approved, "SBX:B300")] };
}

if (import.meta.main) process.stdout.write(`${JSON.stringify(hip3SourceFixture(), null, 2)}\n`);
