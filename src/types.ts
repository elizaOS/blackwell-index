/** Canonical SBX observations preserve commercial terms before aggregation. */
export const MODELS = ["B200", "B300", "GB200", "GB300"] as const;
export type GpuModel = typeof MODELS[number];
export type Procurement = "ON_DEMAND" | "SPOT" | "RESERVED" | "CAPACITY_BLOCK" | "SCHEDULED";
export type PriceBasis = "LIST" | "EXECUTABLE" | "TRANSACTION";

export interface Observation {
  schemaVersion: 1;
  provider: string;
  source: string;
  sku: string;
  model: GpuModel;
  region: string;
  procurement: Procurement;
  priceBasis: PriceBasis;
  tenancy: "EXCLUSIVE" | "FRACTIONAL";
  currency: "USD";
  unit: "USD_PER_GPU_HOUR";
  price: string;
  /** Full minimum instance price and physical GPU count, before normalization. */
  instancePrice: string;
  gpuCount: number;
  includes: string[];
  availableGpuCount: number | null;
  availability?: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
  priceScope?: "PUBLIC" | "ACCOUNT_SPECIFIC";
  topology?: "HGX" | "NVL72" | "UNKNOWN";
  minimumOrderGpuCount?: number | null;
  sourceRecordId?: string;
  /** Versioned quantities for the full instance; omission means unreported, not zero. */
  instanceResources?: InstanceResources;
  /** Retrieval time is not the date when a catalog tariff last changed. */
  observedAt: number;
  priceEffectiveAt: number | null;
  expiresAt: number | null;
  sourceUrl: string;
  evidenceHash: string;
}

export interface InstanceResources {
  schemaVersion: 1;
  scope: "FULL_INSTANCE";
  /** Virtual CPUs, not physical cores or provider-specific OCPUs. */
  vcpus: number;
  memoryGiB: number;
  /** Reported included storage; does not assert disk medium, locality or durability. */
  storageGiB: number;
}

export interface ObservationBatch {
  schemaVersion: 1;
  network: string;
  nodeId: string;
  publicKey: string;
  sequence: number;
  createdAt: number;
  observations: Observation[];
}
export interface SignedBatch { payload: ObservationBatch; signature: string }
export interface NodeIdentity { nodeId: string; publicKey: string; privateKeyPem: string }
export interface ProviderDefinition {
  id: string;
  economicGroup: string;
  /** Only listed authoritative origins are accepted from collectors. */
  allowedHosts: string[];
  sources: string[];
  rights: { collect: boolean; redistribute: boolean; derive: boolean; evidence: string; expiresAt: number | null };
}
export interface OperatorDefinition { nodeId: string; publicKey: string; operatorGroup: string; enabled: boolean }
export interface Registry {
  schemaVersion: 1;
  network: string;
  version: string;
  providers: ProviderDefinition[];
  operators: OperatorDefinition[];
}
export interface Methodology {
  schemaVersion: 1;
  version: string;
  status: "DRAFT" | "APPROVED";
  effectiveAt: number;
  cohort: { procurement: Procurement; priceBasis: PriceBasis; tenancy: "EXCLUSIVE"; regions: string[] };
  maxAgeMs: number;
  futureToleranceMs: number;
  minOperatorGroups: number;
  minProviderGroups: number;
  maxCollectorDeviationBps: number;
  maxProviderDispersionBps: number;
  /** Explicit group weights; never inferred from collector or quote count. */
  providerWeights: Record<GpuModel, Record<string, number>>;
  modelWeights: Record<GpuModel, number>;
  weightEvidence: string;
  /** Omitted for the legacy four-model composite policy. Approval remains explicit. */
  publicationScope?: PublicationScope & { approvalEvidence: string };
  /** Inactive unless explicitly configured; all listed offers remain required. */
  offerSchedule?: B200OfferSchedule;
}
export interface ScheduledB200Offer {
  provider: string;
  source: string;
  sku: string;
  region: string;
  gpuCount: 8;
  topology: "HGX";
  includes: string[];
  /** Null explicitly matches unknown minimum order; it is never a wildcard. */
  minimumOrderGpuCount: number | null;
  sourceRecordId: string;
  sourceUrl: string;
  /** Exact optional quantities; omission matches only an unreported bundle. */
  instanceResources?: InstanceResources;
}
export interface B200OfferSchedule {
  schemaVersion: 1;
  model: "B200";
  approvalEvidence: string;
  offers: ScheduledB200Offer[];
}
/** A publication boundary, not a hardware or commercial eligibility rule. */
export interface PublicationScope { kind: "MODEL"; model: "B200" }
export interface Feed {
  id: string;
  kind: "PROVIDER" | "MODEL" | "COMPOSITE";
  model: GpuModel | null;
  provider: string | null;
  status: "READY" | "UNAVAILABLE";
  price: string | null;
  /** Absolute cross-input deviation bound; not a statistical confidence interval. */
  confidence: string | null;
  observedAt: number | null;
  calculatedAt: number;
  reasons: string[];
  contributors: string[];
  weights: Record<string, number>;
}
export interface Snapshot {
  schemaVersion: 1;
  network: string;
  calculatedAt: number;
  methodologyVersion: string;
  methodologyHash: string;
  registryHash: string;
  publishable: boolean;
  publicationScope?: PublicationScope;
  feeds: Feed[];
  inputBatchHashes: string[];
  rejected: Array<{ batchHash: string; reason: string }>;
}
export interface EvidenceRecord { hash: string; source: string; url: string; receivedAt: number; contentType: string; body: Uint8Array }
export interface CollectorContext {
  now: () => number;
  env: Record<string, string | undefined>;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  archive: (record: EvidenceRecord) => Promise<void>;
}
export interface CollectorResult { observations: Observation[]; errors: string[] }
export interface Collector { id: string; provider: string; collect: (context: CollectorContext) => Promise<CollectorResult> }
