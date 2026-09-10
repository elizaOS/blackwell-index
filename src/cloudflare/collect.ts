import { collectSources } from "../collect-cycle";
import { hash, signBatch } from "../crypto";
import { allowedObservation } from "../engine";
import type { Journal } from "../journal";
import type { OracleNode } from "../network";
import type { Observation } from "../types";
import type { runtimeConfig } from "./config";
import type { CollectionSchedule } from "../collection-control";

/** Shared adapters only: no simulated prices and no credential values in diagnostics. */
export async function collectCycle(config: ReturnType<typeof runtimeConfig>, node: OracleNode, store: Journal) {
  const startedAt = Date.now(), observations: Observation[] = [], errors: string[] = [];
  const sources: {collector:string;status:string;observations:number;errors:number;errorCodes?:string[];schedule?:CollectionSchedule}[] = [];
  for await (const source of collectSources(config.collectors,config.registry,store,{now:Date.now,env:config.credentials,fetch:fetch.bind(globalThis)})) {
    const {collector,status,schedule}=source;
    if (status === "COLLECTION_NOT_APPROVED") {
      sources.push({collector,status,observations:0,errors:0});
      continue;
    }
    if(status === "BACKOFF") {
      sources.push({collector,status,observations:0,errors:0,schedule:schedule!});
      continue;
    }
    if(status !== "FAILED") {
      for(const observation of source.observations)observations.push(observation);
      // Provider error strings can include response snippets; retain only bounded codes/counts here.
      const errorCount = source.errors.length + source.rejectedObservations;
      if (errorCount) errors.push(`${collector}: ${errorCount} collection or validation errors`);
      const errorCodes = [...new Set(source.errors.map(error => /^([A-Z][A-Z0-9_]{1,63}):/.exec(error)?.[1] ?? "COLLECTION_FAILED"))];
      sources.push({collector,status,observations:source.observations.length,errors:errorCount,schedule:schedule!,...(errorCodes.length ? {errorCodes} : {})});
    } else {
      errors.push(`${collector}: collector failed`);
      sources.push({collector,status,observations:0,errors:1});
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
