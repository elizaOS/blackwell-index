import { fromMicros, normalizeInstance, toMicros } from "../decimal";
import { hash } from "../crypto";
import type { Collector, CollectorResult } from "../types";
import { array, CollectionError, decimal, failure, jsonRequest, object, positiveInteger, string } from "./http";
import { blackwellModel } from "./models";

const LIMIT = 1000;
export const vast: Collector = {
  id: "vast-offers", provider: "vast",
  async collect(context) {
    const key = context.env.VAST_API_KEY;
    if (!key?.trim()) return { observations: [], errors: ["NO_KEY: VAST_API_KEY is required for vast-offers"] };
    const result: CollectorResult = { observations: [], errors: [] };
    try {
      const response = await jsonRequest(context, this.id, new URL("https://console.vast.ai/api/v0/bundles"), {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ limit: LIMIT, type: "on-demand", verified: { eq: true }, rentable: { eq: true }, rented: { eq: false }, gpu_name: { in: ["B200", "B300", "GB200", "GB300"] } }),
      });
      const rows = array(object(response.data).offers);
      if (rows.length >= LIMIT) throw new CollectionError("INCOMPLETE_COVERAGE", "Vast reached the response limit; refine queries before publishing");
      const seen = new Map<string, string>();
      for (const value of rows) {
        const row = object(value);
        const model = blackwellModel(row.gpu_name);
        if (!model || row.rentable !== true || row.rented !== false || row.is_bid !== false || row.verification !== "verified") continue;
        try {
          const id = String(positiveInteger(row.id, "id"));
          const fingerprint = hash(row), previous = seen.get(id);
          if (previous !== undefined) {
            if (previous !== fingerprint) return { observations: [], errors: ["AMBIGUOUS_PRICE: Vast repeated an offer ID with conflicting fields"] };
            continue;
          }
          seen.set(id, fingerprint);
          const gpuCount = positiveInteger(row.num_gpus, "num_gpus");
          // Until the provider confirms partial-host vs fractional-GPU semantics, only complete resource offers enter this collector.
          if (row.gpu_frac !== 1) throw new CollectionError("UNVERIFIED_TENANCY", `vast offer ${id}`);
          const instancePrice = fromMicros(toMicros(decimal(row.dph_total)));
          const end = row.end_date;
          const expiresAt = typeof end === "number" && Number.isFinite(end) && end > 0 ? Math.floor(end * 1000) : null;
          if (expiresAt !== null && expiresAt <= response.observedAt) continue;
          result.observations.push({
            schemaVersion: 1, provider: this.provider, source: this.id,
            sku: `${string(row.gpu_name)}:${positiveInteger(row.machine_id, "machine_id")}:${id}`, model,
            region: string(row.geolocation, "geolocation"), procurement: "ON_DEMAND", priceBasis: "EXECUTABLE", priceScope: "PUBLIC", tenancy: "EXCLUSIVE",
            currency: "USD", unit: "USD_PER_GPU_HOUR", price: normalizeInstance(instancePrice, gpuCount), instancePrice, gpuCount,
            includes: ["gpu", "cpu", "memory", "quoted-storage"], availableGpuCount: gpuCount, availability: "AVAILABLE",
            minimumOrderGpuCount: gpuCount, sourceRecordId: `host:${positiveInteger(row.host_id, "host_id")}:offer:${id}`,
            observedAt: response.observedAt, priceEffectiveAt: null, expiresAt, sourceUrl: response.sourceUrl, evidenceHash: response.evidenceHash,
          });
        } catch (error) { result.errors.push(failure(error, this.id)); }
      }
      if (!result.observations.length && !result.errors.length) throw new CollectionError("NO_DATA", "vast has no supported verified Blackwell offers");
    } catch (error) { result.errors.push(failure(error, this.id)); }
    return result;
  },
};
