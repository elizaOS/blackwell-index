import { z } from "zod";
import { fromMicros, toMicros } from "./decimal";

const id = z.string().min(1).max(256);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.string().regex(/^(0|[1-9][0-9]{0,10})(\.[0-9]{1,6})?$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const EvidenceState = z.enum(["TARIFF", "OFFER", "ORDER", "DELIVERED", "INVOICED", "PAID"]);

/** Private research input. Never accepted by the production Observation pipeline. */
export const TransactionRecord = z.object({
  schemaVersion: z.literal(1), source: id, economicProvider: id,
  buyerId: id, dealId: id, segmentId: id, revision: z.number().int().nonnegative(),
  recordedAt: timestamp, evidenceState: EvidenceState, evidenceHash: digest,
  model: z.enum(["B200", "B300", "GB200", "GB300"]), sku: id,
  region: id, bundle: id, topology: id, currency: z.literal("USD"),
  procurement: z.enum(["ON_DEMAND", "SPOT", "RESERVED", "CAPACITY_BLOCK", "SCHEDULED"]),
  tenancy: z.enum(["EXCLUSIVE", "FRACTIONAL"]),
  gpuCount: z.number().int().min(1).max(100000),
  serviceStart: timestamp, serviceEnd: timestamp,
  grossComputeUsd: amount, discountUsd: amount, refundUsd: amount,
  mandatoryComputeFeesUsd: amount, netComputeUsd: amount,
  invoiceId: id.nullable(), invoiceEvidenceHash: digest.nullable(),
  paidAllocatedUsd: amount.nullable(), paymentEvidenceHash: digest.nullable(),
  affiliated: z.boolean(), cancelled: z.boolean(),
}).strict().superRefine((r, ctx) => {
  const fail = (message: string) => ctx.addIssue({code: "custom", message});
  if (r.serviceEnd <= r.serviceStart) fail("Service interval must be positive");
  // Zod may run object refinements after a field-pattern failure.
  if ([r.grossComputeUsd,r.discountUsd,r.refundUsd,r.mandatoryComputeFeesUsd,r.netComputeUsd,...(r.paidAllocatedUsd===null?[]:[r.paidAllocatedUsd])].some(value=>!amount.safeParse(value).success)) return;
  const gross = micros(r.grossComputeUsd), discount = micros(r.discountUsd);
  const refund = micros(r.refundUsd), fees = micros(r.mandatoryComputeFeesUsd);
  if (gross + fees - discount - refund !== micros(r.netComputeUsd)) fail("Net charges do not reconcile");
  if (["INVOICED", "PAID"].includes(r.evidenceState) && (!r.invoiceId || !r.invoiceEvidenceHash)) fail("Invoice evidence required");
  if (r.evidenceState === "PAID" && (!r.paymentEvidenceHash || r.paidAllocatedUsd === null || micros(r.paidAllocatedUsd) !== micros(r.netComputeUsd))) fail("Paid evidence requires full payment allocation");
});
export type Transaction = z.infer<typeof TransactionRecord>;
function micros(s: string): bigint { return /^0(?:\.0+)?$/.test(s) ? 0n : toMicros(s); }
const round = (n: bigint, d: bigint) => (n + d / 2n) / d;

export const ResearchConfig = z.object({
  schemaVersion: z.literal(1), asOf: timestamp, windowStart: timestamp, windowEnd: timestamp,
  model: z.enum(["B200", "B300", "GB200", "GB300"]), region: id, bundle: id, topology: id,
  procurement: z.enum(["ON_DEMAND", "SPOT", "RESERVED", "CAPACITY_BLOCK", "SCHEDULED"]),
  minimumEvidence: z.enum(["DELIVERED", "INVOICED", "PAID"]),
  minProviders: z.number().int().min(2), minBuyers: z.number().int().min(2),
  minGpuHours: z.number().int().positive(), maxProviderShareBps: z.number().int().min(1).max(10000),
  maxBuyerShareBps: z.number().int().min(1).max(10000),
  winsorBps: z.number().int().min(0).max(4999),
  permissions: z.array(z.object({source: id, agreementId: id, evidenceHash: digest,
    evaluationAllowed: z.literal(true), validFrom: timestamp, expiresAt: timestamp}).strict()),
}).strict().superRefine((c, ctx) => {
  if (c.windowStart >= c.windowEnd || c.windowEnd > c.asOf) ctx.addIssue({code:"custom", message:"Invalid research window"});
  if (new Set(c.permissions.map(p => p.source)).size !== c.permissions.length) ctx.addIssue({code:"custom", message:"Duplicate permission source"});
  if (c.permissions.some(p => p.validFrom >= p.expiresAt)) ctx.addIssue({code:"custom", message:"Invalid permission interval"});
});

const rank = {TARIFF:0, OFFER:1, ORDER:2, DELIVERED:3, INVOICED:4, PAID:5};
type Point = {record: Transaction; volume: bigint; price: bigint; charge: bigint};
function quantile(points: Point[], bps: number): bigint {
  const sorted = [...points].sort((a,b) => a.price < b.price ? -1 : a.price > b.price ? 1 : 0);
  const total = sorted.reduce((s,p) => s+p.volume,0n);
  let cumulative = 0n;
  for (const p of sorted) { cumulative += p.volume; if (cumulative*10000n >= total*BigInt(bps)) return p.price; }
  return sorted.at(-1)!.price;
}
function estimates(points: Point[], winsorBps: number) {
  const volume = points.reduce((s,p) => s+p.volume,0n);
  const low = quantile(points,winsorBps), high = quantile(points,10000-winsorBps);
  return {
    vwap: fromMicros(round(points.reduce((s,p) => s+p.charge,0n)*3600000n,volume)),
    weightedMedian: fromMicros(quantile(points,5000)),
    winsorizedVwap: fromMicros(round(points.reduce((s,p) => s+(p.price<low?low:p.price>high?high:p.price)*p.volume,0n),volume)),
    lowerBound: fromMicros(low), upperBound: fromMicros(high),
  };
}

export function analyzeTransactions(input: unknown, settings: unknown) {
  const c = ResearchConfig.parse(settings);
  const records = z.array(TransactionRecord).max(100000).parse(input);
  const excluded: Record<string,number> = {};
  const reject = (reason: string) => { excluded[reason] = (excluded[reason] ?? 0)+1; };
  const latest = new Map<string,Transaction>();
  const seenRevisions = new Set<string>();
  for (const r of records) {
    if (r.recordedAt > c.asOf) { reject("AFTER_AS_OF"); continue; }
    const permission = c.permissions.find(p => p.source === r.source);
    if (!permission || permission.validFrom > c.asOf || permission.expiresAt <= c.asOf) throw new Error("Missing current evaluation permission for input source");
    const key = JSON.stringify([r.economicProvider,r.dealId,r.segmentId]);
    const revisionKey = JSON.stringify([key,r.revision]);
    if (seenRevisions.has(revisionKey)) throw new Error("Duplicate or conflicting deal segment revision");
    seenRevisions.add(revisionKey);
    const prior = latest.get(key);
    if (prior && prior.revision === r.revision) {
      // Fail closed even across resellers: a duplicate cannot increase quantity.
      throw new Error("Duplicate or conflicting deal segment revision");
    }
    if (!prior || prior.revision < r.revision) latest.set(key,r);
  }
  const points: Point[] = [];
  const intervals = new Map<string,Transaction[]>();
  for (const r of latest.values()) {
    if (r.cancelled || r.affiliated) { reject("CANCELLED_OR_AFFILIATED"); continue; }
    if (rank[r.evidenceState] < rank[c.minimumEvidence]) { reject("INSUFFICIENT_EVIDENCE"); continue; }
    if (r.model!==c.model || r.region!==c.region || r.bundle!==c.bundle || r.topology!==c.topology || r.procurement!==c.procurement || r.tenancy!=="EXCLUSIVE") { reject("COHORT_MISMATCH"); continue; }
    if (r.serviceStart < c.windowStart || r.serviceEnd > c.windowEnd || r.serviceEnd > r.recordedAt) { reject("INTERVAL_REQUIRES_METERED_SPLIT"); continue; }
    const charge = micros(r.netComputeUsd);
    if (!charge) { reject("ZERO_NET_CHARGE"); continue; }
    const intervalKey = JSON.stringify([r.economicProvider,r.dealId]);
    const previous = intervals.get(intervalKey) ?? [];
    if (previous.some(p => r.serviceStart < p.serviceEnd && r.serviceEnd > p.serviceStart)) throw new Error("Overlapping deal segments require upstream reconciliation");
    previous.push(r); intervals.set(intervalKey,previous);
    const volume = BigInt(r.gpuCount)*BigInt(r.serviceEnd-r.serviceStart);
    const price = round(charge*3600000n,volume);
    if (!price) { reject("BELOW_PRICE_PRECISION"); continue; }
    points.push({record:r,volume,charge,price});
  }
  const volume = points.reduce((s,p)=>s+p.volume,0n);
  const shares = (key: "economicProvider" | "buyerId") => {
    const groups = new Map<string,bigint>();
    for (const p of points) groups.set(p.record[key],(groups.get(p.record[key])??0n)+p.volume);
    return [...groups.values()];
  };
  const providers = shares("economicProvider"), buyers = shares("buyerId");
  const max = (a:bigint[]) => a.reduce((m,n)=>n>m?n:m,0n);
  const reasons: string[] = [];
  if (providers.length<c.minProviders) reasons.push("PROVIDER_COVERAGE");
  if (buyers.length<c.minBuyers) reasons.push("BUYER_COVERAGE");
  if (volume<BigInt(c.minGpuHours)*3600000n) reasons.push("VOLUME_COVERAGE");
  if (volume && max(providers)*10000n>volume*BigInt(c.maxProviderShareBps)) reasons.push("PROVIDER_CONCENTRATION");
  if (volume && max(buyers)*10000n>volume*BigInt(c.maxBuyerShareBps)) reasons.push("BUYER_CONCENTRATION");
  const candidate = points.length ? estimates(points,c.winsorBps) : null;
  const leaveOneProviderOut = [...new Set(points.map(p=>p.record.economicProvider))].map(group => {
    const remaining = points.filter(p=>p.record.economicProvider!==group);
    return remaining.length ? estimates(remaining,c.winsorBps).vwap : null;
  });
  return {schemaVersion:1, purpose:"PRIVATE_RESEARCH", publishable:false,
    status:reasons.length?"INSUFFICIENT_DATA":"RESEARCH_ONLY", reasons,
    windowStart:c.windowStart, windowEnd:c.windowEnd, asOf:c.asOf,
    inputRecords:records.length, supersededRecords:records.length-(excluded.AFTER_AS_OF??0)-latest.size,
    acceptedSegments:points.length, excluded, providerCount:providers.length, buyerCount:buyers.length,
    gpuMilliseconds:volume.toString(),
    maxProviderShareBps:volume?Number(round(max(providers)*10000n,volume)):null,
    maxBuyerShareBps:volume?Number(round(max(buyers)*10000n,volume)):null,
    effectiveProviderCount:volume?Number(volume*volume)/Number(providers.reduce((s,v)=>s+v*v,0n)):0,
    candidateEstimates:candidate, leaveOneProviderOut,
    // Values remain private even when source/buyer identities are omitted.
    warning:"Not a settlement feed. Requires licensed data, independent review and production qualification.",
  };
}

/** Explicit as-of windows prevent later invoice corrections leaking into earlier estimates. */
export function backtestTransactions(input: unknown, configurations: unknown) {
  const configs = z.array(ResearchConfig).min(1).max(366).parse(configurations);
  const first = configs[0]!;
  for (let i=0;i<configs.length;i++) {
    const c=configs[i]!;
    if (["model","region","bundle","topology","procurement","minimumEvidence","winsorBps","minProviders","minBuyers","minGpuHours","maxProviderShareBps","maxBuyerShareBps"].some(key => c[key as keyof typeof c]!==first[key as keyof typeof first])) throw new Error("Backtest cohort and parameters must remain fixed");
    if (i && c.windowStart < configs[i-1]!.windowEnd) throw new Error("Backtest windows must be ordered and non-overlapping");
  }
  const windows = configs.map(c=>analyzeTransactions(input,c));
  const missingWindows = windows.filter(w=>w.status==="INSUFFICIENT_DATA").length;
  return {schemaVersion:1,purpose:"PRIVATE_BACKTEST",publishable:false,windows,
    totalWindows:windows.length,missingWindows,
    coverageBps:Math.round((windows.length-missingWindows)*10000/windows.length),
    warning:"Only explicitly supplied windows are measured. No interpolation, carry-forward or claim of historical qualification."};
}
