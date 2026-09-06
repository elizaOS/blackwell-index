import { fromMicros, toMicros } from "../decimal";
import type { Collector, CollectorResult } from "../types";
import { array, CollectionError, decimal, failure, jsonRequest, object, positiveInteger, string } from "./http";
import { blackwellModel } from "./models";

/** The documented query asks for a single GPU, so the returned total needs no division. */
const QUERY = "query { gpuTypes { id displayName secureCloud lowestPrice(input: { gpuCount: 1, secureCloud: true }) { stockStatus uninterruptablePrice availableGpuCounts } } }";
export const runpod: Collector = {
  id: "runpod-secure", provider: "runpod",
  async collect(context) {
    const key = context.env.RUNPOD_API_KEY;
    if (!key?.trim()) return { observations: [], errors: ["NO_KEY: RUNPOD_API_KEY is required for runpod-secure"] };
    const result: CollectorResult = { observations: [], errors: [] };
    try {
      const url = new URL("https://api.runpod.io/graphql"); url.searchParams.set("api_key", key);
      const response = await jsonRequest(context, this.id, url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: QUERY }) });
      const data = object(response.data);
      if (data.errors) throw new CollectionError("PROVIDER_ERROR", "runpod returned GraphQL errors");
      for (const value of array(object(data.data).gpuTypes)) {
        const row = object(value);
        const model = blackwellModel(row.id);
        if (!model || row.secureCloud !== true) continue;
        if (row.lowestPrice === null || row.lowestPrice === undefined) continue;
        try {
          const offer = object(row.lowestPrice);
          if (offer.uninterruptablePrice === null || offer.uninterruptablePrice === undefined) continue;
          const price = fromMicros(toMicros(decimal(offer.uninterruptablePrice)));
          // Runpod's nullable [Int] field can omit deployment-size information.
          // Null is not an empty inventory list; missing/malformed fields still fail.
          const counts = offer.availableGpuCounts === null ? null : array(offer.availableGpuCounts).map(count => positiveInteger(count, "availableGpuCounts"));
          // Multi-GPU-only inventory cannot support the one-GPU quote this query requested.
          const state = offer.stockStatus === null ? null : string(offer.stockStatus, "stockStatus");
          if (state !== null && !["High", "Medium", "Low", "None"].includes(state)) throw new CollectionError("INVALID_SCHEMA", "Unknown Runpod stockStatus");
          const availability = state === "None" || counts !== null && !counts.includes(1) ? "UNAVAILABLE"
            : state === null || counts === null ? "UNKNOWN" : "AVAILABLE";
          result.observations.push({
            schemaVersion: 1, provider: this.provider, source: this.id, sku: string(row.id, "gpuType.id"), model,
            region: "global", procurement: "ON_DEMAND", priceBasis: "LIST", priceScope: "PUBLIC", tenancy: "EXCLUSIVE",
            currency: "USD", unit: "USD_PER_GPU_HOUR", price, instancePrice: price, gpuCount: 1,
            includes: ["gpu"], availableGpuCount: null, availability,
            minimumOrderGpuCount: counts?.length ? Math.min(...counts) : null, sourceRecordId: string(row.id),
            observedAt: response.observedAt, priceEffectiveAt: null, expiresAt: null, sourceUrl: response.sourceUrl, evidenceHash: response.evidenceHash,
          });
        } catch (error) { result.errors.push(failure(error, this.id)); }
      }
      if (!result.observations.length && !result.errors.length) throw new CollectionError("NO_DATA", "runpod has no Blackwell secure-cloud price");
    } catch (error) { result.errors.push(failure(error, this.id)); }
    return result;
  },
};
