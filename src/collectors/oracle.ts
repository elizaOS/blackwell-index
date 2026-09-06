import { fromMicros, toMicros } from "../decimal";
import type { Collector, CollectorResult, GpuModel, Observation } from "../types";
import { array, decimal, failure, jsonRequest, object, CollectionError } from "./http";

export const ORACLE_PARTS: ReadonlyArray<{ part: string; model: GpuModel; sku: string; gpuCount: number }> = [
  { part: "B110978", model: "B200", sku: "BM.GPU.B200.8", gpuCount: 8 },
  { part: "B112237", model: "B300", sku: "BM.GPU.B300.8", gpuCount: 8 },
  { part: "B110979", model: "GB200", sku: "BM.GPU.GB200.4", gpuCount: 4 },
  { part: "B112140", model: "GB300", sku: "BM.GPU.GB300.4", gpuCount: 4 },
];
export const oracle: Collector = {
  id: "oracle-public", provider: "oracle",
  async collect(context) {
    const result: CollectorResult = { observations: [], errors: [] };
    for (const mapping of ORACLE_PARTS) {
      try {
        const url = new URL("https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/");
        url.searchParams.set("partNumber", mapping.part); url.searchParams.set("currencyCode", "USD");
        const response = await jsonRequest(context, this.id, url);
        const data = object(response.data);
        const matches = array(data.items).map(item => object(item)).filter(item => item.partNumber === mapping.part);
        if (matches.length !== 1) throw new CollectionError("NO_DATA", `oracle ${mapping.part}: expected one product`);
        const item = matches[0]!;
        if (item.metricName !== "GPU Per Hour") throw new CollectionError("UNSUPPORTED_UNIT", `oracle ${mapping.part}`);
        const localized = array(item.currencyCodeLocalizations).map(value => object(value)).filter(value => value.currencyCode === "USD");
        if (localized.length !== 1) throw new CollectionError("INVALID_SCHEMA", "Expected one USD localization");
        const prices = array(localized[0]!.prices).map(value => object(value)).filter(value => value.model === "PAY_AS_YOU_GO");
        if (prices.length !== 1) throw new CollectionError("NO_DATA", `oracle ${mapping.part}: missing unique PAY_AS_YOU_GO price`);
        const price = fromMicros(toMicros(decimal(prices[0]!.value)));
        const observation: Observation = {
          schemaVersion: 1, provider: this.provider, source: this.id, sku: mapping.sku,
          model: mapping.model, region: "global", procurement: "ON_DEMAND", priceBasis: "LIST", priceScope: "PUBLIC", tenancy: "EXCLUSIVE",
          currency: "USD", unit: "USD_PER_GPU_HOUR", price,
          instancePrice: fromMicros(toMicros(price) * BigInt(mapping.gpuCount)), gpuCount: mapping.gpuCount,
          includes: ["gpu", "cpu", "memory", "local-storage"], availableGpuCount: null, availability: "UNKNOWN",
          topology: mapping.model.startsWith("GB") ? "NVL72" : "HGX", minimumOrderGpuCount: null, sourceRecordId: mapping.part,
          // Catalog lastUpdated is preserved in raw evidence; it is not a tariff effective date.
          observedAt: response.observedAt, priceEffectiveAt: null, expiresAt: null,
          sourceUrl: response.sourceUrl, evidenceHash: response.evidenceHash,
        };
        result.observations.push(observation);
      } catch (error) {
        result.errors.push(failure(error, this.id));
        if (error instanceof CollectionError && error.code === "RATE_LIMITED") break;
      }
    }
    return result;
  },
};
