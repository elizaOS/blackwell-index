/** Fixed commercial membership, separate from rights and external product approval. */
import type { Methodology, Observation, Registry } from "./types";
import { instanceResourceKey } from "./instance-resources";

export function scheduledOfferKey(offer: Pick<Observation, "provider" | "source" | "sku" | "region" | "gpuCount" | "topology" |
  "includes" | "minimumOrderGpuCount" | "sourceRecordId" | "sourceUrl" | "instanceResources">): string {
  return JSON.stringify([offer.provider, offer.source, offer.sku, offer.region, offer.gpuCount, offer.topology,
    [...offer.includes].sort(), offer.minimumOrderGpuCount ?? null, offer.sourceRecordId, offer.sourceUrl,
    ...(offer.instanceResources ? [instanceResourceKey(offer.instanceResources)] : [])]);
}

export interface CompiledOfferSchedule {
  keys: Set<string>;
  providerKeys: Map<string, Set<string>>;
  groupProviders: Map<string, Set<string>>;
}

/** Registry-dependent checks run once, before any signed observations are admitted. */
export function compileOfferSchedule(methodology: Methodology, registry: Registry): CompiledOfferSchedule | undefined {
  if (!methodology.offerSchedule) return undefined;
  const result: CompiledOfferSchedule = { keys: new Set(), providerKeys: new Map(), groupProviders: new Map() };
  for (const offer of methodology.offerSchedule.offers) {
    const provider = registry.providers.find(value => value.id === offer.provider);
    if (!provider || !provider.sources.includes(offer.source) || !provider.allowedHosts.includes(new URL(offer.sourceUrl).hostname)) {
      throw new Error("Offer schedule contains an unknown provider, source or allowed host");
    }
    const key = scheduledOfferKey(offer);
    result.keys.add(key);
    const providerKeys = result.providerKeys.get(provider.id) ?? new Set<string>();
    providerKeys.add(key); result.providerKeys.set(provider.id, providerKeys);
    const groupProviders = result.groupProviders.get(provider.economicGroup) ?? new Set<string>();
    groupProviders.add(provider.id); result.groupProviders.set(provider.economicGroup, groupProviders);
  }
  const groups = Object.keys(methodology.providerWeights.B200);
  if (groups.length !== result.groupProviders.size || groups.some(group => !result.groupProviders.has(group))) {
    throw new Error("Offer schedule economic groups must exactly match B200 provider weights");
  }
  return result;
}

/** Preserve explicit evidence requirements before hashing or schedule membership checks. */
export function observationOfferKey(observation: Observation): string | undefined {
  if (observation.model !== "B200" || observation.gpuCount !== 8 || observation.topology !== "HGX" ||
    observation.priceScope !== "PUBLIC" || !observation.sourceRecordId || new Set(observation.includes).size !== observation.includes.length) return undefined;
  return scheduledOfferKey(observation);
}

export function matchingScheduledOffer(observation: Observation, schedule: CompiledOfferSchedule): string | undefined {
  const key = observationOfferKey(observation);
  return key !== undefined && schedule.keys.has(key) ? key : undefined;
}
