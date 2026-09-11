import { fromMicros, normalizeInstance } from "../decimal";
import type { Collector, CollectorResult, Observation } from "../types";
import { array, CollectionError, failure, jsonRequest, object, positiveInteger, string } from "./http";
import { blackwellModel } from "./models";
import { instanceResourcesSchema } from "../validation";

/** Explicit opt-in; omitted configuration preserves the original observation bytes. */
export const LAMBDA_CONFIGURATION_ENVS = ["LAMBDA_INSTANCE_RESOURCES"];
function instanceResources(specs: Record<string, unknown>): NonNullable<Observation["instanceResources"]> {
  // The documented API values describe the whole instance. Do not divide by GPUs,
  // substitute physical CPU cores, or infer topology/entitlements from the SKU.
  const parsed = instanceResourcesSchema.safeParse({ schemaVersion: 1, scope: "FULL_INSTANCE",
    vcpus: specs.vcpus, memoryGiB: specs.memory_gib, storageGiB: specs.storage_gib });
  if (!parsed.success) throw new CollectionError("INVALID_INSTANCE_RESOURCES", "Lambda specs require bounded full-instance vCPU, memory GiB and storage GiB integers");
  return parsed.data;
}

export const lambda: Collector = {
  id: "lambda-cloud", provider: "lambda",
  async collect(context) {
    const resourceMode = context.env.LAMBDA_INSTANCE_RESOURCES;
    if (resourceMode !== undefined && resourceMode !== "1") return { observations: [], errors: ["UNSUPPORTED_CONFIGURATION: LAMBDA_INSTANCE_RESOURCES must be 1 or omitted"] };
    const key = context.env.LAMBDA_API_KEY;
    if (!key?.trim()) return { observations: [], errors: ["NO_KEY: LAMBDA_API_KEY is required for lambda-cloud"] };
    const result: CollectorResult = { observations: [], errors: [] };
    try {
      const response = await jsonRequest(context, this.id, new URL("https://cloud.lambda.ai/api/v1/instance-types"), { headers: { Authorization: `Bearer ${key}` } });
      const data = object(object(response.data).data);
      for (const [id, value] of Object.entries(data)) {
        const item = object(value);
        const type = object(item.instance_type);
        const model = blackwellModel(type.gpu_description);
        if (!model) continue;
        try {
          const specs = object(type.specs), gpuCount = positiveInteger(specs.gpus, "specs.gpus");
          const resources = resourceMode === "1" ? instanceResources(specs) : undefined;
          const cents = positiveInteger(type.price_cents_per_hour, "price_cents_per_hour");
          const instancePrice = fromMicros(BigInt(cents) * 10_000n);
          const regions = array(item.regions_with_capacity_available).map(region => string(object(region).name, "region.name"));
          for (const region of regions.length ? regions : ["global"]) {
            result.observations.push({
              schemaVersion: 1, provider: this.provider, source: this.id, sku: string(type.name, "instance_type.name"), model,
              region, procurement: "ON_DEMAND", priceBasis: "LIST", priceScope: "PUBLIC", tenancy: "EXCLUSIVE",
              currency: "USD", unit: "USD_PER_GPU_HOUR", price: normalizeInstance(instancePrice, gpuCount), instancePrice, gpuCount,
              includes: ["gpu", "cpu", "memory", "local-storage"], availableGpuCount: null,
              availability: regions.length ? "AVAILABLE" : "UNAVAILABLE", minimumOrderGpuCount: gpuCount, sourceRecordId: id,
              ...(resources ? { instanceResources: resources } : {}),
              observedAt: response.observedAt, priceEffectiveAt: null, expiresAt: null, sourceUrl: response.sourceUrl, evidenceHash: response.evidenceHash,
            });
          }
        } catch (error) { result.errors.push(failure(error, this.id)); }
      }
      if (!result.observations.length && !result.errors.length) throw new CollectionError("NO_DATA", "lambda has no Blackwell instance types");
    } catch (error) { result.errors.push(failure(error, this.id)); }
    return result;
  },
};
