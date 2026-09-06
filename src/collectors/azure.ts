import { fromMicros, normalizeInstance, toMicros } from "../decimal";
import type { Collector, CollectorResult, GpuModel } from "../types";
import { array, CollectionError, decimal, failure, jsonRequest, object, string, timestamp } from "./http";

const SKUS: Record<string, GpuModel> = {
  Standard_ND128isr_NDR_GB200_v6: "GB200",
  Standard_ND128isr_GB300_v6: "GB300",
};
const BASE = "https://prices.azure.com/api/retail/prices";
export const azure: Collector = {
  id: "azure-retail", provider: "azure",
  async collect(context) {
    const result: CollectorResult = { observations: [], errors: [] };
    try {
      let url: URL | null = new URL(BASE);
      url.searchParams.set("$filter", "serviceName eq 'Virtual Machines' and (contains(armSkuName, 'GB200') or contains(armSkuName, 'GB300')) and priceType eq 'Consumption'");
      const visited = new Set<string>();
      const observations = [];
      while (url) {
        if (visited.has(url.toString()) || visited.size >= 100) throw new CollectionError("INVALID_PAGINATION", "Azure pagination is repeated or exceeds 100 pages");
        visited.add(url.toString());
        const response = await jsonRequest(context, this.id, url);
        const data = object(response.data);
        for (const item of array(data.Items)) {
          const row = object(item);
          const sku = string(row.armSkuName, "armSkuName");
          const model = SKUS[sku];
          if (!model) continue;
          if (row.type !== "Consumption" || row.currencyCode !== "USD" || row.isPrimaryMeterRegion === false) continue;
          if (string(row.productName, "productName").includes("Windows") || row.tierMinimumUnits !== 0) continue;
          if (row.unitOfMeasure !== "1 Hour") throw new CollectionError("UNSUPPORTED_UNIT", `azure ${sku}`);
          const instancePrice = fromMicros(toMicros(decimal(row.retailPrice)));
          const priceEffectiveAt = timestamp(row.effectiveStartDate);
          if (priceEffectiveAt !== null && priceEffectiveAt > response.observedAt) continue;
          observations.push({
            schemaVersion: 1 as const, provider: this.provider, source: this.id, sku, model,
            region: string(row.armRegionName, "armRegionName"),
            procurement: string(row.meterName).includes("Spot") ? "SPOT" as const : "ON_DEMAND" as const,
            priceBasis: "LIST" as const, priceScope: "PUBLIC" as const, tenancy: "EXCLUSIVE" as const, currency: "USD" as const, unit: "USD_PER_GPU_HOUR" as const,
            price: normalizeInstance(instancePrice, 4), instancePrice, gpuCount: 4,
            includes: ["gpu", "cpu", "memory", "local-storage"], availableGpuCount: null, availability: "UNKNOWN" as const,
            topology: "NVL72" as const, minimumOrderGpuCount: null,
            sourceRecordId: string(row.meterId, "meterId"),
            observedAt: response.observedAt, priceEffectiveAt, expiresAt: null,
            sourceUrl: response.sourceUrl, evidenceHash: response.evidenceHash,
          });
        }
        const next = data.NextPageLink;
        if (next === null || next === undefined || next === "") { url = null; continue; }
        const candidate = new URL(string(next, "NextPageLink"));
        if (candidate.protocol !== "https:" || candidate.hostname !== "prices.azure.com" || candidate.port || candidate.pathname !== "/api/retail/prices" || candidate.username || candidate.password) throw new CollectionError("INVALID_PAGINATION", "Azure next page must remain on its public pricing endpoint");
        url = candidate;
      }
      result.observations = observations;
      if (!observations.length) result.errors.push("NO_DATA: azure has no supported Blackwell consumption prices");
    } catch (error) { result.errors.push(failure(error, this.id)); }
    return result;
  },
};
