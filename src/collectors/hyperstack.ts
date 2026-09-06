import { createHash } from "node:crypto";
import { fromMicros, toMicros } from "../decimal";
import type { Collector, GpuModel, Observation } from "../types";
import { array, CollectionError, decimal, failure, jsonRequest, object, positiveInteger, string } from "./http";
import { blackwellModel } from "./models";

const API = "https://infrahub-api.nexgencloud.com/v1";
/** Explicit physical configurations documented in Hyperstack's flavor catalog. */
export const HYPERSTACK_FLAVORS: Readonly<Record<string, { model: GpuModel; gpuCount: number }>> = {
  "n3-B200-SXM6x8": { model: "B200", gpuCount: 8 },
  "n3-B300-SXM6x8": { model: "B300", gpuCount: 8 },
};
function completeEnvelope(value: unknown) {
  const result = object(value);
  if (["next", "next_page", "next_cursor", "nextPageToken", "pagination"].some(key => result[key] != null && result[key] !== "") || result.has_more === true || result.page != null) {
    throw new CollectionError("INCOMPLETE_COVERAGE", "Hyperstack catalog pagination is not documented for this response");
  }
  return result;
}
function zero(value: unknown): boolean {
  return value === 0 || typeof value === "string" && /^(?:0(?:\.0+)?|0E-\d+)$/.test(value);
}
function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new CollectionError("INVALID_SCHEMA", label);
  return value;
}

export const hyperstack: Collector = {
  id: "hyperstack-pricebook", provider: "hyperstack",
  async collect(context) {
    const key = context.env.HYPERSTACK_API_KEY;
    if (!key?.trim()) return { observations: [], errors: ["NO_KEY: HYPERSTACK_API_KEY is required for hyperstack-pricebook"] };
    try {
      const headers = { api_key: key };
      const priceResponse = await jsonRequest(context, this.id, new URL(`${API}/pricebook`), { headers });
      const flavorResponse = await jsonRequest(context, this.id, new URL(`${API}/core/flavors`), { headers });
      const stockResponse = await jsonRequest(context, this.id, new URL(`${API}/core/stocks`), { headers });
      const prices = new Map<string, Record<string, unknown>>();
      for (const value of array(priceResponse.data)) {
        const price = object(value), name = string(price.name, "pricebook.name");
        if (prices.has(name)) throw new CollectionError("AMBIGUOUS_PRICE", "Duplicate Hyperstack pricebook resource");
        if (price.currency !== undefined && price.currency !== "USD") throw new CollectionError("UNSUPPORTED_CURRENCY", "Hyperstack pricebook currency changed");
        if (price.unit !== undefined) throw new CollectionError("UNSUPPORTED_UNIT", "Hyperstack pricebook added undocumented unit metadata");
        prices.set(name, price);
      }
      for (const included of ["vCPU", "RAM", "hypervisor-local-storage"]) {
        const price = prices.get(included);
        if (!zero(price?.value) || !zero(price?.original_value)) throw new CollectionError("UNSUPPORTED_BUNDLE", "GPU flavor CPU, RAM and local storage must have explicitly zero current and original prices");
        if (price?.discount_applied !== false || price.start_time !== null || price.end_time !== null) throw new CollectionError("UNSUPPORTED_TERMS", "Included Hyperstack components must be undiscounted and open-ended public list rates");
      }
      const flavorDocument = completeEnvelope(flavorResponse.data), stockDocument = completeEnvelope(stockResponse.data);
      if (flavorDocument.status !== true || stockDocument.status === false) throw new CollectionError("INVALID_SCHEMA", "Hyperstack catalog request did not succeed");
      const stocks = new Map<string, Record<string, unknown>>();
      for (const value of array(stockDocument.stocks)) {
        const stock = object(value);
        if (stock["stock-type"] !== "GPU") continue;
        const region = string(stock.region, "stock.region");
        for (const item of array(stock.models)) {
          const model = object(item), name = string(model.model, "stock.model"), id = `${region}\n${name}`;
          if (stocks.has(id)) throw new CollectionError("AMBIGUOUS_STOCK", "Duplicate Hyperstack regional stock");
          stocks.set(id, model);
        }
      }
      const observations: Observation[] = [], seen = new Set<string>();
      for (const value of array(flavorDocument.data)) {
        const group = object(value);
        for (const item of array(group.flavors)) {
          const flavor = object(item), sku = string(flavor.name, "flavor.name"), hardware = HYPERSTACK_FLAVORS[sku];
          if (!hardware && !blackwellModel(flavor.gpu) && !blackwellModel(sku)) continue;
          if (!hardware) throw new CollectionError("UNSUPPORTED_SKU", "Hyperstack Blackwell flavor needs an explicit reviewed physical mapping");
          const gpu = string(flavor.gpu, "flavor.gpu"), gpuCount = positiveInteger(flavor.gpu_count, "flavor.gpu_count");
          if (blackwellModel(gpu) !== hardware.model || gpuCount !== hardware.gpuCount || group.gpu !== gpu) throw new CollectionError("HARDWARE_MISMATCH", "Hyperstack GPU family or count conflicts with documented flavor");
          const region = string(flavor.region_name, "flavor.region_name");
          if (group.region_name !== region) throw new CollectionError("REGION_MISMATCH", "Hyperstack flavor region differs from its group");
          const identity = `${region}\n${sku}`;
          if (seen.has(identity)) throw new CollectionError("AMBIGUOUS_SKU", "Duplicate Hyperstack regional flavor");
          seen.add(identity);
          const price = prices.get(gpu), stock = stocks.get(`${region}\n${gpu}`);
          if (!price || !stock) throw new CollectionError("INCOMPLETE_DATA", "Hyperstack flavor is missing its exact price or stock join");
          // Discounts may be reservations or promotions: a scalar rate does not identify their terms.
          if (price.discount_applied !== false || price.start_time !== null || price.end_time !== null) throw new CollectionError("UNSUPPORTED_TERMS", "Discounted or dated Hyperstack rates need explicit procurement terms");
          const gpuPrice = toMicros(decimal(price.value));
          if (toMicros(decimal(price.original_value)) !== gpuPrice) throw new CollectionError("AMBIGUOUS_PRICE", "Undiscounted Hyperstack price differs from its original value");
          const deployable = nonnegativeInteger(object(stock.configurations)[`${gpuCount}x`], "Missing or invalid stock deployment configuration");
          if (typeof flavor.stock_available !== "boolean" || flavor.stock_available !== (deployable > 0)) throw new CollectionError("INCONSISTENT_AVAILABILITY", "Hyperstack flavor and stock reads disagree; retry current catalogs");
          positiveInteger(flavor.cpu, "flavor.cpu"); positiveInteger(flavor.ram, "flavor.ram");
          positiveInteger(flavor.disk, "flavor.disk"); nonnegativeInteger(flavor.ephemeral, "flavor.ephemeral");
          const flavorId = positiveInteger(flavor.id, "flavor.id"), resourceId = positiveInteger(price.id, "pricebook.id");
          const body = new TextEncoder().encode(JSON.stringify({ kind: "HYPERSTACK_PRICEBOOK_COMPOSITION_V1", sku, region, gpu, gpuCount, flavorId, resourceId,
            inputs: [priceResponse, flavorResponse, stockResponse].map(response => ({ url: response.sourceUrl, evidenceHash: response.evidenceHash, observedAt: response.observedAt })) }));
          const evidenceHash = createHash("sha256").update(body).digest("hex");
          await context.archive({ hash: evidenceHash, source: this.id, url: priceResponse.sourceUrl, receivedAt: context.now(), contentType: "application/vnd.sbx.billing-composition+json", body });
          observations.push({ schemaVersion: 1, provider: this.provider, source: this.id, sku, model: hardware.model, region,
            procurement: "ON_DEMAND", priceBasis: "LIST", priceScope: "PUBLIC", tenancy: "EXCLUSIVE", currency: "USD", unit: "USD_PER_GPU_HOUR",
            price: fromMicros(gpuPrice), instancePrice: fromMicros(gpuPrice * BigInt(gpuCount)), gpuCount,
            includes: ["gpu", "cpu", "memory", "local-root-storage", "local-ephemeral-storage"],
            availableGpuCount: null, availability: deployable > 0 ? "AVAILABLE" : "UNAVAILABLE", topology: "UNKNOWN", minimumOrderGpuCount: gpuCount,
            sourceRecordId: `flavor:${flavorId}:resource:${resourceId}`, observedAt: Math.min(priceResponse.observedAt, flavorResponse.observedAt, stockResponse.observedAt),
            priceEffectiveAt: null, expiresAt: null, sourceUrl: priceResponse.sourceUrl, evidenceHash });
        }
      }
      if (!observations.length) throw new CollectionError("NO_DATA", "Hyperstack returned no supported Blackwell flavors");
      return { observations, errors: [] };
    } catch (error) { return { observations: [], errors: [failure(error, this.id)] }; }
  },
};
