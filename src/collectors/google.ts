import { createHash } from "node:crypto";
import { fromMicros, normalizeInstance } from "../decimal";
import { MODELS, type Collector, type CollectorContext, type CollectorResult, type GpuModel, type Procurement } from "../types";
import { array, CollectionError, failure, jsonRequest, object, positiveInteger, string, timestamp } from "./http";

interface Component { skuId: string; description: string; quantity: number; usageUnit: string; usageType: string }
interface Machine { model: GpuModel; sku: string; region: string; gpuCount: number; procurement: Procurement; includes: string[]; components: Component[] }
interface CatalogSku { record: Record<string, unknown>; hash: string; observedAt: number; sourceUrl: string }
const MACHINES: Record<string, { model: GpuModel; gpuCount: number }> = {
  "a4-highgpu-8g": { model: "B200", gpuCount: 8 },
  "a4x-highgpu-4g": { model: "GB200", gpuCount: 4 },
  "a4x-maxgpu-4g-metal": { model: "GB300", gpuCount: 4 },
};

function parseMappings(raw: string | undefined): Machine[] {
  if (!raw) return [];
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { throw new CollectionError("INVALID_MAPPING", "GOOGLE_BILLING_SKU_MAP_JSON must be JSON"); }
  return array(decoded).map(value => {
    const item = object(value);
    if (!MODELS.includes(item.model as GpuModel)) throw new CollectionError("INVALID_MAPPING", "Unknown Google hardware family");
    if (!["ON_DEMAND", "SPOT", "RESERVED", "CAPACITY_BLOCK", "SCHEDULED"].includes(String(item.procurement))) throw new CollectionError("INVALID_MAPPING", "Unknown Google procurement term");
    const components = array(item.components).map(value => {
      const component = object(value);
      const usageUnit = string(component.usageUnit);
      if (!/^(h|[A-Za-z]+\.h)$/.test(usageUnit)) throw new CollectionError("INVALID_MAPPING", "Only hourly component units are supported");
      if (typeof component.description !== "string" || !component.description.trim()) throw new CollectionError("INVALID_MAPPING", "Each Google component requires its reviewed exact catalog description");
      return { skuId: string(component.skuId), description: component.description, quantity: positiveInteger(component.quantity, "component.quantity"), usageUnit, usageType: string(component.usageType) };
    });
    if (!components.length || components.length > 20 || new Set(components.map(x => x.skuId)).size !== components.length) throw new CollectionError("INVALID_MAPPING", "Expected 1–20 unique billing components");
    const sku = string(item.sku);
    const gpuCount = positiveInteger(item.gpuCount, "gpuCount");
    if (MACHINES[sku]?.model !== item.model || MACHINES[sku]?.gpuCount !== gpuCount) throw new CollectionError("INVALID_MAPPING", "Google machine model or physical GPU count does not match official hardware mapping");
    return { model: item.model as GpuModel, sku, region: string(item.region), gpuCount, procurement: item.procurement as Procurement, includes: array(item.includes).map(value => string(value)), components };
  });
}

/** Official paginated catalog discovery. Original successful response bytes are archived by jsonRequest. */
export async function discoverGoogleCatalog(context: CollectorContext, key: string): Promise<CatalogSku[]> {
  let serviceName: string | undefined;
  let token: string | undefined;
  const serviceTokens = new Set<string>();
  do {
    if (serviceTokens.has(token ?? "") || serviceTokens.size >= 100) throw new CollectionError("INVALID_PAGINATION", "Google service catalog pagination repeated");
    serviceTokens.add(token ?? "");
    const url = new URL("https://cloudbilling.googleapis.com/v1/services");
    url.searchParams.set("key", key); url.searchParams.set("pageSize", "5000");
    if (token) url.searchParams.set("pageToken", token);
    const { data } = await jsonRequest(context, "google-billing", url);
    const response = object(data);
    for (const value of array(response.services)) {
      const service = object(value);
      if (service.displayName === "Compute Engine") serviceName = string(service.name);
    }
    token = response.nextPageToken ? string(response.nextPageToken) : undefined;
  } while (!serviceName && token);
  if (!serviceName || !/^services\/[A-Z0-9-]+$/.test(serviceName)) throw new CollectionError("NO_DATA", "Google Compute Engine service missing");
  token = undefined;
  const tokens = new Set<string>();
  const skus: CatalogSku[] = [];
  do {
    if (tokens.has(token ?? "") || tokens.size >= 100) throw new CollectionError("INVALID_PAGINATION", "Google SKU catalog pagination repeated or exceeds 100 pages");
    tokens.add(token ?? "");
    const url = new URL(`https://cloudbilling.googleapis.com/v1/${serviceName}/skus`);
    url.searchParams.set("key", key); url.searchParams.set("currencyCode", "USD"); url.searchParams.set("pageSize", "5000");
    if (token) url.searchParams.set("pageToken", token);
    const response = await jsonRequest(context, "google-billing", url);
    const data = object(response.data);
    const publicSource = new URL(response.sourceUrl); publicSource.searchParams.delete("pageToken");
    for (const value of array(data.skus)) skus.push({ record: object(value), hash: response.evidenceHash, observedAt: response.observedAt, sourceUrl: publicSource.toString() });
    token = data.nextPageToken ? string(data.nextPageToken) : undefined;
  } while (token);
  return skus;
}

function componentRate(part: CatalogSku, component: Component, region: string) {
  const record = part.record;
  // Google uses OnDemand for some Spot and scheduled SKUs as well.
  // Pin the reviewed description rather than infer procurement from that category.
  if (record.description !== component.description) throw new CollectionError("MAPPING_MISMATCH", `Google SKU ${component.skuId} description changed; review procurement and bundle identity`);
  if (!array(record.serviceRegions).includes(region)) throw new CollectionError("MAPPING_MISMATCH", `Google SKU ${component.skuId} is not offered in configured region`);
  if (object(record.category).usageType !== component.usageType) throw new CollectionError("MAPPING_MISMATCH", `Google SKU ${component.skuId} consumption model changed`);
  const eligible = array(record.pricingInfo).map(value => object(value)).map(value => ({ value, effectiveAt: timestamp(value.effectiveTime) })).filter(value => value.effectiveAt !== null && value.effectiveAt <= part.observedAt).sort((a, b) => b.effectiveAt! - a.effectiveAt!);
  if (!eligible.length) throw new CollectionError("NO_DATA", `Google SKU ${component.skuId} has no current price`);
  const selected = eligible[0]!;
  const expression = object(selected.value.pricingExpression);
  if (expression.usageUnit !== component.usageUnit) throw new CollectionError("UNSUPPORTED_UNIT", `Google SKU ${component.skuId} unit changed`);
  const tiers = array(expression.tieredRates).map(value => object(value));
  if (tiers.length !== 1 || tiers[0]!.startUsageAmount !== 0) throw new CollectionError("UNSUPPORTED_TIERS", `Google SKU ${component.skuId}`);
  const price = object(tiers[0]!.unitPrice);
  const units = string(price.units, "price.units");
  if (price.currencyCode !== "USD" || !/^\d{1,11}$/.test(units) || !Number.isInteger(price.nanos) || Number(price.nanos) < 0 || Number(price.nanos) > 999_999_999) throw new CollectionError("INVALID_PRICE", `Google SKU ${component.skuId}`);
  const nanos = BigInt(units) * 1_000_000_000n + BigInt(price.nanos as number);
  return { nanos: nanos * BigInt(component.quantity), effectiveAt: selected.effectiveAt! };
}

export const google: Collector = {
  id: "google-billing", provider: "google",
  async collect(context) {
    const key = context.env.GOOGLE_CLOUD_BILLING_API_KEY;
    if (!key?.trim()) return { observations: [], errors: ["NO_KEY: GOOGLE_CLOUD_BILLING_API_KEY is required for google-billing"] };
    const result: CollectorResult = { observations: [], errors: [] };
    try {
      const mappings = parseMappings(context.env.GOOGLE_BILLING_SKU_MAP_JSON);
      const catalog = await discoverGoogleCatalog(context, key);
      if (!mappings.length) throw new CollectionError("NO_MAPPING", "Google catalog archived; configure reviewed GOOGLE_BILLING_SKU_MAP_JSON before composing instance prices");
      for (const mapping of mappings) {
        try {
          const components = mapping.components.map(component => {
            const matching = catalog.filter(item => item.record.skuId === component.skuId);
            if (matching.length !== 1) throw new CollectionError("NO_DATA", `Google component ${component.skuId} missing or duplicated`);
            const part = matching[0]!;
            return { component, part, ...componentRate(part, component, mapping.region) };
          });
          const totalNanos = components.reduce((total, component) => total + component.nanos, 0n);
          const totalMicros = (totalNanos + 500n) / 1000n;
          if (totalMicros <= 0n) throw new CollectionError("INVALID_PRICE", "Google bundle has no positive price");
          const instancePrice = fromMicros(totalMicros);
          const observedAt = Math.min(...components.map(component => component.part.observedAt));
          // A composition receipt links every unmodified response; it is explicitly not an upstream price payload.
          const body = new TextEncoder().encode(JSON.stringify({ type: "GOOGLE_BILLING_COMPOSITION_V1", mapping, components: components.map(component => ({ skuId: component.component.skuId, responseHash: component.part.hash })) }));
          const evidenceHash = createHash("sha256").update(body).digest("hex");
          const sourceUrl = components[0]!.part.sourceUrl;
          await context.archive({ hash: evidenceHash, source: this.id, url: sourceUrl, receivedAt: context.now(), contentType: "application/vnd.sbx.billing-composition+json", body });
          result.observations.push({
            schemaVersion: 1, provider: this.provider, source: this.id, sku: mapping.sku, model: mapping.model, region: mapping.region,
            procurement: mapping.procurement, priceBasis: "LIST", priceScope: "PUBLIC", tenancy: "EXCLUSIVE", currency: "USD", unit: "USD_PER_GPU_HOUR",
            price: normalizeInstance(instancePrice, mapping.gpuCount), instancePrice, gpuCount: mapping.gpuCount, includes: mapping.includes,
            availableGpuCount: null, availability: "UNKNOWN", minimumOrderGpuCount: null,
            observedAt, priceEffectiveAt: Math.max(...components.map(component => component.effectiveAt)), expiresAt: null, sourceUrl, evidenceHash,
          });
        } catch (error) { result.errors.push(failure(error, this.id)); }
      }
    } catch (error) { result.errors.push(failure(error, this.id)); }
    return result;
  },
};
