import { createCollectors } from "../collectors";
import { hash, signBatch } from "../crypto";
import { allowedObservation } from "../engine";
import type { Journal } from "../journal";
import type { OracleNode } from "../network";
import type { Observation } from "../types";
import { observationSchema } from "../validation";
import type { runtimeConfig } from "./config";

/** Shared adapters only: no simulated prices and no credential values in diagnostics. */
export async function collectCycle(config: ReturnType<typeof runtimeConfig>, node: OracleNode, store: Journal) {
  const startedAt = Date.now(), observations: Observation[] = [], errors: string[] = [];
  const sources: {collector:string;status:string;observations:number;errors:number;errorCodes?:string[]}[] = [];
  for (const collector of createCollectors(config.collectors)) {
    const provider = config.registry.providers.find(p => p.id === collector.provider);
    if (!provider?.rights.collect || (provider.rights.expiresAt !== null && provider.rights.expiresAt < Date.now())) {
      sources.push({collector:collector.id,status:"COLLECTION_NOT_APPROVED",observations:0,errors:0});
      continue;
    }
    try {
      const result = await collector.collect({ now:Date.now, env:config.credentials, fetch:fetch.bind(globalThis), archive:r => store.archive(r) });
      let accepted = 0, rejected = 0;
      for (const observation of result.observations) {
        const parsed = observationSchema.safeParse(observation);
        if (parsed.success) { observations.push(observation); accepted++; } else rejected++;
      }
      // Provider error strings can include response snippets; retain only bounded codes/counts here.
      const errorCount = result.errors.length + rejected;
      if (errorCount) errors.push(`${collector.id}: ${errorCount} collection or validation errors`);
      const errorCodes = [...new Set(result.errors.map(error => /^([A-Z][A-Z0-9_]{1,63}):/.exec(error)?.[1] ?? "COLLECTION_FAILED"))];
      sources.push({collector:collector.id,status:errorCount ? "DEGRADED" : "COLLECTED",observations:accepted,errors:errorCount,...(errorCodes.length ? {errorCodes} : {})});
    } catch {
      errors.push(`${collector.id}: collector failed`);
      sources.push({collector:collector.id,status:"FAILED",observations:0,errors:1});
    }
  }
  const collectedAt = Date.now();
  store.capture(observations, errors, collectedAt);
  const identity = node.options.identity;
  const shared = observations.filter(o => allowedObservation(o, config.registry, collectedAt, "share"));
  const batch = signBatch({schemaVersion:1,network:config.network,nodeId:identity.nodeId,publicKey:identity.publicKey,
    sequence:store.nextSequence(identity.nodeId),createdAt:collectedAt,observations:shared}, identity);
  node.receive(batch);
  const peers = await node.sync(config.peers);
  const snapshot = node.snapshot();
  store.snapshot(snapshot);
  return { startedAt, collectedAt, realObservationCount:observations.length, sharedObservationCount:shared.length,
    models:[...new Set(observations.map(o => o.model))].sort(), sources, peerCount:peers.length,
    snapshotHash:hash(snapshot), publishable:snapshot.publishable };
}
