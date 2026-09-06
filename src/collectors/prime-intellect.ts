import { createHash } from "node:crypto";
import { fromMicros, normalizeInstance, toMicros } from "../decimal";
import type { Collector, CollectorContext, EvidenceRecord, GpuModel, Observation } from "../types";
import { array, CollectionError, decimal, failure, jsonRequest, object, positiveInteger, string } from "./http";

const ENDPOINT = "https://api.primeintellect.ai/api/v1/availability/gpus";
const PAGE_SIZE = 100, MAX_ITEMS_PER_MODEL = 2000, MAX_OBSERVATIONS = 2000;
/** Exact enums in the official availability OpenAPI; GB systems remain raw discovery only. */
export const PRIME_INTELLECT_GPU_TYPES: ReadonlyArray<{ apiType: string; model: GpuModel; gpuMemory: number | null }> = [
  { apiType: "B200_180GB", model: "B200", gpuMemory: 180 },
  { apiType: "B300_262GB", model: "B300", gpuMemory: 262 },
  { apiType: "GB200", model: "GB200", gpuMemory: null },
  { apiType: "GB300", model: "GB300", gpuMemory: null },
];
type ResponseEvidence = Awaited<ReturnType<typeof jsonRequest>>;
function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) throw new CollectionError("INVALID_SCHEMA", label);
  return value;
}
function boundedString(value: unknown, label: string, limit: number): string {
  const result = string(value, label);
  if (result.length > limit || /[\x00-\x1f\x7f]/.test(result)) throw new CollectionError("INVALID_SCHEMA", label);
  return result;
}
function nonnegativeMicros(value: unknown): bigint {
  return value === 0 || value === "0" ? 0n : toMicros(decimal(value));
}
/** Only complete, explicit minimum/default billing is supported; omitted resource fields are not free resources. */
function component(value: unknown, name: string) {
  const spec = object(value, name), count = nonnegativeInteger(spec.defaultCount, `${name}.defaultCount`);
  if (name !== "sharedDisk" && count === 0) throw new CollectionError("INCOMPLETE_BUNDLE", "Prime Intellect must specify nonzero CPU, RAM and local disk resources");
  if (spec.minCount != null && nonnegativeInteger(spec.minCount, `${name}.minCount`) > count ||
      spec.maxCount != null && nonnegativeInteger(spec.maxCount, `${name}.maxCount`) < count) throw new CollectionError("INVALID_SCHEMA", "Prime Intellect resource bounds contradict its default");
  if (spec.additionalInfo != null && spec.additionalInfo !== "") throw new CollectionError("UNSUPPORTED_TERMS", "Prime Intellect resource billing notes need review");
  if (spec.currency !== undefined && spec.currency !== "USD") throw new CollectionError("UNSUPPORTED_CURRENCY", "Prime Intellect component currency changed");
  if (spec.unit !== undefined || spec.priceUnit !== undefined) throw new CollectionError("UNSUPPORTED_UNIT", "Prime Intellect resource added undocumented units");
  if (spec.defaultIncludedInPrice === true) return { name, count, includedInBase: true, hourlyUsd: "0.000000" };
  if (spec.defaultIncludedInPrice !== false) throw new CollectionError("INCOMPLETE_BUNDLE", "Prime Intellect resource inclusion is not explicit");
  if (nonnegativeInteger(spec.minCount, `${name}.minCount`) !== count) throw new CollectionError("UNSUPPORTED_BUNDLE", "Separately billed Prime Intellect defaults must equal the explicit minimum configuration");
  return { name, count, includedInBase: false, hourlyUsd: fromMicros(nonnegativeMicros(spec.pricePerUnit) * BigInt(count)) };
}
function normalizeOffer(item: Record<string, unknown>, mapping: typeof PRIME_INTELLECT_GPU_TYPES[number], evidence: ResponseEvidence) {
  const gpuCount = positiveInteger(item.gpuCount, "Prime Intellect gpuCount"), cloudId = boundedString(item.cloudId, "Prime Intellect cloudId", 150);
  // Opaque upstream identifiers are valid, but every explicit family label must
  // agree. A mixed B200/GB200 label is not an absent hardware label.
  const cloudModels = cloudId.toUpperCase().replaceAll("_", " ").match(/\b(?:GB300|GB200|B300|B200)\b/g) ?? [];
  if (gpuCount > 100_000 || item.gpuMemory !== mapping.gpuMemory || item.socket !== "SXM6" || cloudModels.some(model => model !== mapping.model)) throw new CollectionError("HARDWARE_MISMATCH", "Prime Intellect whole-GPU model, memory, count or socket needs review");
  if (item.security !== "secure_cloud") throw new CollectionError("UNVERIFIED_TENANCY", "Prime Intellect requires secure-cloud whole-GPU configurations");
  // isSpot describes spot capability rather than an unambiguous executable spot tariff.
  if (item.isSpot !== false || item.prepaidTime !== null) throw new CollectionError("UNSUPPORTED_TERMS", "Prime Intellect spot, prepaid or unspecified procurement terms need review");
  const prices = object(item.prices, "Prime Intellect prices");
  if (prices.currency !== "USD") throw new CollectionError("UNSUPPORTED_CURRENCY", "Prime Intellect requires explicit USD pricing");
  if (prices.isVariable !== false || prices.communityPrice != null) throw new CollectionError("UNSUPPORTED_TERMS", "Prime Intellect variable or community pricing needs review");
  if (prices.unit !== undefined || prices.priceUnit !== undefined || item.unit !== undefined) throw new CollectionError("UNSUPPORTED_UNIT", "Prime Intellect added undocumented price units");
  const upstream = boundedString(item.provider, "Prime Intellect upstream provider", 64);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(upstream)) throw new CollectionError("INVALID_SCHEMA", "Prime Intellect upstream provider identifier");
  const region = boundedString(item.region, "Prime Intellect region", 100);
  const dataCenter = item.dataCenter == null ? null : boundedString(item.dataCenter, "Prime Intellect data center", 100);
  // A JSON tuple preserves provenance without delimiter collisions between
  // provider-defined cloud IDs and data-center names.
  const sku = JSON.stringify([upstream, cloudId, gpuCount, dataCenter]);
  if (sku.length > 200) throw new CollectionError("INVALID_SCHEMA", "Prime Intellect SKU exceeds the canonical limit");
  const stock = string(item.stockStatus, "Prime Intellect stockStatus");
  if (!["Available", "Low", "Medium", "High", "Unavailable"].includes(stock)) throw new CollectionError("INVALID_SCHEMA", "Prime Intellect stock status changed");
  const baseInstanceHourlyUsd = fromMicros(toMicros(decimal(prices.onDemand)));
  const components = ["vcpu", "memory", "disk", "sharedDisk"].map(name => component(item[name], name));
  const instancePrice = fromMicros(components.reduce((total, value) => total + nonnegativeMicros(value.hourlyUsd === "0.000000" ? "0" : value.hourlyUsd), toMicros(baseInstanceHourlyUsd)));
  // Enforce the canonical decimal bound before constructing any observation.
  toMicros(instancePrice);
  const identity = JSON.stringify([upstream, cloudId, region, dataCenter, mapping.apiType, gpuCount]);
  const body = new TextEncoder().encode(JSON.stringify({ kind: "PRIME_INTELLECT_BUNDLE_COMPOSITION_V1",
    input: { url: evidence.sourceUrl, evidenceHash: evidence.evidenceHash, observedAt: evidence.observedAt },
    offer: { upstreamProvider: upstream, cloudId, region, dataCenter, gpuType: mapping.apiType, gpuCount }, baseInstanceHourlyUsd, components }));
  const evidenceHash = createHash("sha256").update(body).digest("hex");
  const observation: Observation = { schemaVersion: 1, provider: "prime-intellect", source: "prime-intellect-availability", sku, model: mapping.model, region,
    procurement: "ON_DEMAND", priceBasis: "LIST", priceScope: "ACCOUNT_SPECIFIC", tenancy: "EXCLUSIVE", currency: "USD", unit: "USD_PER_GPU_HOUR",
    instancePrice, gpuCount, price: normalizeInstance(instancePrice, gpuCount),
    includes: ["gpu", "cpu", "memory", "local-storage", ...(components[3]!.count > 0 ? ["shared-storage"] : []), "reseller:prime-intellect", `upstream-cloud:${upstream}`],
    availableGpuCount: null, availability: stock === "Unavailable" ? "UNAVAILABLE" : "AVAILABLE", topology: "UNKNOWN", minimumOrderGpuCount: gpuCount,
    sourceRecordId: `configuration:${createHash("sha256").update(identity).digest("hex")}`,
    observedAt: evidence.observedAt, priceEffectiveAt: null, expiresAt: null, sourceUrl: evidence.sourceUrl, evidenceHash };
  const receipt: EvidenceRecord = { hash: evidenceHash, source: observation.source, url: evidence.sourceUrl, receivedAt: evidence.observedAt,
    contentType: "application/vnd.sbx.billing-composition+json", body };
  return { identity, observation, receipt };
}

async function discover(context: CollectorContext, source: string, apiType: string, key: string) {
  const records: { item: Record<string, unknown>; evidence: ResponseEvidence }[] = [];
  let expectedTotal: number | undefined;
  for (let page = 1; page <= MAX_ITEMS_PER_MODEL / PAGE_SIZE; page++) {
    const url = new URL(ENDPOINT);
    url.searchParams.set("gpu_type", apiType); url.searchParams.set("security", "secure_cloud");
    url.searchParams.set("page", String(page)); url.searchParams.set("page_size", String(PAGE_SIZE));
    const evidence = await jsonRequest(context, source, url, { method: "GET", headers: { Authorization: `Bearer ${key}` } });
    const document = object(evidence.data, "Prime Intellect availability"), items = array(document.items);
    if (["next", "nextPage", "next_page", "next_cursor", "nextPageToken", "pagination"].some(name => document[name] != null && document[name] !== "") || document.has_more === true) throw new CollectionError("INVALID_PAGINATION", "Prime Intellect added unsupported pagination metadata");
    const total = nonnegativeInteger(document.totalCount, "Prime Intellect totalCount");
    if (total > MAX_ITEMS_PER_MODEL) throw new CollectionError("INCOMPLETE_COVERAGE", "Prime Intellect model catalog exceeds the bounded collection limit");
    if (expectedTotal !== undefined && expectedTotal !== total) throw new CollectionError("INCOMPLETE_COVERAGE", "Prime Intellect catalog changed during pagination");
    expectedTotal = total;
    if (items.length !== Math.min(PAGE_SIZE, total - records.length)) throw new CollectionError("INCOMPLETE_COVERAGE", "Prime Intellect page length does not reconcile with totalCount");
    for (const value of items) {
      const item = object(value, "Prime Intellect configuration");
      if (item.gpuType !== apiType || item.security !== "secure_cloud") throw new CollectionError("FILTER_MISMATCH", "Prime Intellect response differs from requested GPU family or security");
      records.push({ item, evidence });
    }
    if (records.length === total) return records;
  }
  throw new CollectionError("INCOMPLETE_COVERAGE", "Prime Intellect pagination exceeded its bounded page limit");
}

/** Integration must keep collection, derivation and redistribution rights unapproved until reviewed. */
export const primeIntellect: Collector = {
  id: "prime-intellect-availability", provider: "prime-intellect",
  async collect(context) {
    const key = context.env.PRIME_INTELLECT_API_KEY;
    if (!key?.trim()) return { observations: [], errors: ["NO_KEY: PRIME_INTELLECT_API_KEY with Availability Read permission is required for prime-intellect-availability"] };
    try {
      const pending: ReturnType<typeof normalizeOffer>[] = [], identities = new Set<string>(), errors: string[] = [];
      for (const mapping of PRIME_INTELLECT_GPU_TYPES) {
        const records = await discover(context, this.id, mapping.apiType, key);
        if (!records.length) { errors.push(`NO_DATA: prime-intellect-availability has no ${mapping.model} configurations`); continue; }
        if (mapping.gpuMemory === null) {
          errors.push(`HARDWARE_METADATA_REQUIRED: Prime Intellect ${mapping.model} requires reviewed physical system, minimum-order and commercial mapping; raw discovery only`);
          continue;
        }
        for (const { item, evidence } of records) {
          const normalized = normalizeOffer(item, mapping, evidence);
          if (identities.has(normalized.identity)) throw new CollectionError("AMBIGUOUS_CONFIGURATION", "Prime Intellect repeated a configuration during collection");
          identities.add(normalized.identity); pending.push(normalized);
          if (pending.length > MAX_OBSERVATIONS) throw new CollectionError("INCOMPLETE_COVERAGE", "Prime Intellect exceeds the canonical observation batch limit");
        }
      }
      // No normalized subset or receipt is returned from an incomplete source cycle.
      for (const value of pending) await context.archive(value.receipt);
      return { observations: pending.map(value => value.observation), errors };
    } catch (error) { return { observations: [], errors: [failure(error, this.id)] }; }
  },
};
