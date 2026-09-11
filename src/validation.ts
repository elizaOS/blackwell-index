import { z } from "zod";
import { MODELS, type Registry, type Methodology } from "./types";
import { nodeIdFor } from "./crypto";
import { normalizeInstance, toMicros } from "./decimal";
import { methodologyPublicationScopeSchema } from "./publication";
import { scheduledOfferKey } from "./offer-schedule";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const decimal = z.string().max(24).refine(x => { try { toMicros(x); return true; } catch { return false; } });
const procurement = z.enum(["ON_DEMAND", "SPOT", "RESERVED", "CAPACITY_BLOCK", "SCHEDULED"]);
const priceBasis = z.enum(["LIST", "EXECUTABLE", "TRANSACTION"]);
const sourceUrl = z.string().max(2048).refine(v => {
  try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && !u.hash && ![...u.searchParams.keys()].some(k => /key|token|secret|signature|credential/i.test(k)); } catch { return false; }
});
export const instanceResourcesSchema = z.strictObject({
  schemaVersion: z.literal(1), scope: z.literal("FULL_INSTANCE"),
  vcpus: z.number().int().min(1).max(1_000_000_000),
  memoryGiB: z.number().int().min(1).max(1_000_000_000),
  storageGiB: z.number().int().min(0).max(1_000_000_000),
});
export const observationSchema = z.strictObject({
  schemaVersion: z.literal(1), provider: id, source: id, sku: z.string().min(1).max(200),
  model: z.enum(MODELS), region: z.string().min(1).max(100), procurement, priceBasis,
  tenancy: z.enum(["EXCLUSIVE", "FRACTIONAL"]), currency: z.literal("USD"), unit: z.literal("USD_PER_GPU_HOUR"),
  price: decimal, instancePrice: decimal, gpuCount: z.number().int().min(1).max(100_000),
  includes: z.array(z.string().min(1).max(100)).max(30), availableGpuCount: z.number().int().min(0).max(1_000_000_000).nullable(),
  availability: z.enum(["AVAILABLE", "UNAVAILABLE", "UNKNOWN"]).optional(),
  priceScope: z.enum(["PUBLIC", "ACCOUNT_SPECIFIC"]).optional(), topology: z.enum(["HGX", "NVL72", "UNKNOWN"]).optional(),
  minimumOrderGpuCount: z.number().int().min(1).max(100000).nullable().optional(), sourceRecordId: z.string().min(1).max(300).optional(),
  instanceResources: instanceResourcesSchema.optional(),
  observedAt: timestamp, priceEffectiveAt: timestamp.nullable(), expiresAt: timestamp.nullable(), sourceUrl, evidenceHash: digest,
}).refine(o => {
  try { return toMicros(o.price) === toMicros(normalizeInstance(o.instancePrice, o.gpuCount)); }
  catch { return false; }
}, "Instance normalization does not match price");
export const signedBatchSchema = z.strictObject({
  payload: z.strictObject({ schemaVersion: z.literal(1), network: id, nodeId: digest,
    publicKey: z.string().regex(/^[A-Za-z0-9+/]{58}==$/).or(z.string().length(60).regex(/^[A-Za-z0-9+/=]+$/)),
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), createdAt: timestamp,
    observations: z.array(observationSchema).max(2000) }),
  signature: z.string().length(88).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export const registrySchema = z.strictObject({
  schemaVersion: z.literal(1), network: id, version: z.string().min(1).max(100),
  providers: z.array(z.strictObject({ id, economicGroup: id, allowedHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).min(1), sources: z.array(id).min(1),
    rights: z.strictObject({ collect: z.boolean(), redistribute: z.boolean(), derive: z.boolean(), evidence: z.string().max(2000), expiresAt: timestamp.nullable() }) })).max(200),
  operators: z.array(z.strictObject({ nodeId: digest, publicKey: z.string().max(100), operatorGroup: id, enabled: z.boolean() })).max(1000),
});
export function parseRegistry(raw: unknown): Registry {
  const registry = registrySchema.parse(raw);
  if (new Set(registry.providers.map(x => x.id)).size !== registry.providers.length) throw new Error("Duplicate provider");
  if (new Set(registry.operators.map(x => x.nodeId)).size !== registry.operators.length) throw new Error("Duplicate operator");
  for (const o of registry.operators) if (o.nodeId !== nodeIdFor(o.publicKey)) throw new Error("Invalid operator key binding");
  for (const p of registry.providers) if ((p.rights.derive || p.rights.redistribute) && !p.rights.evidence.trim()) throw new Error("Publication rights require evidence");
  return registry;
}
const weights = z.record(id, z.number().int().min(1).max(1_000_000));
const exactText = (maximum: number) => z.string().min(1).max(maximum).refine(value => Boolean(value.trim()) && !value.includes("*"), "Offer identity must be exact, without wildcards");
const offerScheduleSchema = z.strictObject({
  schemaVersion: z.literal(1), model: z.literal("B200"), approvalEvidence: z.string().min(1).max(4000).refine(value => Boolean(value.trim()), "Approval evidence must be nonblank"),
  offers: z.array(z.strictObject({
    provider: id, source: id, sku: exactText(200), region: exactText(100), gpuCount: z.literal(8), topology: z.literal("HGX"),
    includes: z.array(exactText(100)).min(1).max(30).refine(values => new Set(values).size === values.length, "Duplicate included component"),
    minimumOrderGpuCount: z.number().int().min(1).max(100000).nullable(), sourceRecordId: exactText(300),
    sourceUrl: sourceUrl.refine(value => !value.includes("*"), "Offer source URL must be exact"),
    instanceResources: instanceResourcesSchema.optional(),
  }).transform(({ instanceResources, ...offer }) => ({ ...offer, ...(instanceResources ? { instanceResources } : {}) })))
    .min(1).max(256).refine(offers => new Set(offers.map(scheduledOfferKey)).size === offers.length, "Duplicate scheduled offer"),
});
export const methodologySchema = z.strictObject({
  schemaVersion: z.literal(1), version: z.string().min(1).max(100), status: z.enum(["DRAFT", "APPROVED"]), effectiveAt: timestamp,
  cohort: z.strictObject({ procurement, priceBasis, tenancy: z.literal("EXCLUSIVE"), regions: z.array(z.string().min(1).max(100)).min(1) }),
  maxAgeMs: z.number().int().min(1000).max(86400000), futureToleranceMs: z.number().int().min(0).max(60000),
  minOperatorGroups: z.number().int().min(2).max(1000), minProviderGroups: z.number().int().min(3).max(200),
  maxCollectorDeviationBps: z.number().int().min(0).max(10000), maxProviderDispersionBps: z.number().int().min(1).max(100000),
  providerWeights: z.strictObject({ B200: weights, B300: weights, GB200: weights, GB300: weights }),
  modelWeights: z.strictObject({ B200: z.number().int().positive().max(1000000), B300: z.number().int().positive().max(1000000), GB200: z.number().int().positive().max(1000000), GB300: z.number().int().positive().max(1000000) }),
  weightEvidence: z.string().min(1).max(4000),
  publicationScope: methodologyPublicationScopeSchema.optional(),
  offerSchedule: offerScheduleSchema.optional(),
});
export function parseMethodology(raw: unknown): Methodology {
  const value = methodologySchema.parse(raw);
  if (value.offerSchedule && (!value.publicationScope || value.cohort.procurement !== "ON_DEMAND" || value.cohort.priceBasis !== "LIST")) {
    throw new Error("B200 offer schedule requires explicit B200 publication scope and public on-demand list cohort");
  }
  if (value.offerSchedule && !value.cohort.regions.includes("*") && value.offerSchedule.offers.some(offer => !value.cohort.regions.includes(offer.region))) {
    throw new Error("Scheduled offer region is outside the methodology cohort");
  }
  const approvedModels = value.publicationScope ? [value.publicationScope.model] : MODELS;
  if (value.status === "APPROVED") for (const model of approvedModels) if (Object.keys(value.providerWeights[model]).length < value.minProviderGroups) throw new Error(`${model}: insufficient configured provider groups`);
  const { publicationScope, offerSchedule, ...legacy } = value;
  return { ...legacy, ...(publicationScope ? { publicationScope } : {}), ...(offerSchedule ? { offerSchedule } : {}) };
}
