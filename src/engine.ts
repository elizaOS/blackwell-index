import { hash, verifyBatch } from "./crypto";
import { distance, fromMicros, median, toMicros, weighted } from "./decimal";
import { MODELS, type Feed, type GpuModel, type Methodology, type Observation, type Registry, type SignedBatch, type Snapshot } from "./types";
import { parseMethodology, parseRegistry, signedBatchSchema } from "./validation";

export function requiredOperators(registry: Registry, methodology: Methodology): number {
  const groups = new Set(registry.operators.filter(x => x.enabled).map(x => x.operatorGroup)).size;
  return Math.max(methodology.minOperatorGroups, Math.floor(groups * 2 / 3) + 1);
}
export function allowedObservation(o: Observation, registry: Registry, now: number, purpose: "share" | "derive"): boolean {
  const p = registry.providers.find(x => x.id === o.provider);
  if (!p || !p.sources.includes(o.source) || !p.allowedHosts.includes(new URL(o.sourceUrl).hostname)) return false;
  const r = p.rights;
  return r.collect && r.redistribute && (purpose !== "derive" || r.derive) && Boolean(r.evidence.trim()) && (r.expiresAt === null || r.expiresAt > now);
}
function quoteKey(o: Observation): string {
  return JSON.stringify([o.provider, o.source, o.model, o.region, o.sku, o.procurement, o.priceBasis, o.tenancy, o.gpuCount, [...o.includes].sort(), o.priceScope ?? "PUBLIC", o.topology ?? "UNKNOWN", o.minimumOrderGpuCount ?? null]);
}
function empty(id: string, kind: Feed["kind"], model: GpuModel | null, provider: string | null, now: number, reason: string): Feed {
  return { id, kind, model, provider, status: "UNAVAILABLE", price: null, confidence: null, observedAt: null, calculatedAt: now, reasons: [reason], contributors: [], weights: {} };
}
interface Vote { observation: Observation; group: string }
interface Quote { observation: Observation; price: bigint; spread: bigint; groups: string[]; observedAt: number }

/** Pure calculation: identical inputs, configuration and time yield identical bytes. */
export function calculate(batches: SignedBatch[], registryInput: Registry, methodologyInput: Methodology, now: number): Snapshot {
  const registry = parseRegistry(registryInput), methodology = parseMethodology(methodologyInput);
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Invalid calculation time");
  const rejected: Snapshot["rejected"] = [];
  const accepted: SignedBatch[] = [];
  const byNode = new Map<string, SignedBatch>();
  const equivocating = new Set<string>();
  const sequences = new Map<string, string>();
  for (const raw of batches) {
    const batchHash = hash(raw);
    const result = signedBatchSchema.safeParse(raw);
    if (!result.success || !verifyBatch(raw)) { rejected.push({ batchHash, reason: "INVALID_SIGNATURE_OR_SCHEMA" }); continue; }
    const p = raw.payload;
    const operator = registry.operators.find(o => o.enabled && o.nodeId === p.nodeId && o.publicKey === p.publicKey);
    if (!operator || p.network !== registry.network) { rejected.push({ batchHash, reason: "UNTRUSTED_OPERATOR_OR_NETWORK" }); continue; }
    if (p.createdAt > now + methodology.futureToleranceMs || now - p.createdAt > methodology.maxAgeMs) { rejected.push({ batchHash, reason: "BATCH_TIME_INVALID" }); continue; }
    const sequenceKey = `${p.nodeId}:${p.sequence}`;
    const knownHash = sequences.get(sequenceKey);
    if (knownHash && knownHash !== hash(p)) equivocating.add(p.nodeId);
    sequences.set(sequenceKey, hash(p));
    const previous = byNode.get(p.nodeId);
    if (!previous || previous.payload.sequence < p.sequence) byNode.set(p.nodeId, raw);
  }
  const votes = new Map<string, Map<string, Vote>>();
  for (const batch of [...byNode.values()].sort((a, b) => a.payload.nodeId.localeCompare(b.payload.nodeId))) {
    const batchHash = hash(batch), p = batch.payload;
    if (equivocating.has(p.nodeId)) { rejected.push({ batchHash, reason: "EQUIVOCATING_OPERATOR" }); continue; }
    accepted.push(batch);
    const group = registry.operators.find(x => x.nodeId === p.nodeId)!.operatorGroup;
    const seen = new Set<string>();
    for (const o of p.observations) {
      if (!allowedObservation(o, registry, now, "derive")) continue;
      if (o.procurement !== methodology.cohort.procurement || o.priceBasis !== methodology.cohort.priceBasis || o.tenancy !== methodology.cohort.tenancy || o.priceScope === "ACCOUNT_SPECIFIC") continue;
      if (!methodology.cohort.regions.includes("*") && !methodology.cohort.regions.includes(o.region)) continue;
      if (now - o.observedAt > methodology.maxAgeMs || o.observedAt > now + methodology.futureToleranceMs || o.observedAt > p.createdAt + methodology.futureToleranceMs) continue;
      if (o.priceEffectiveAt !== null && o.priceEffectiveAt > o.observedAt + methodology.futureToleranceMs) continue;
      if (o.expiresAt !== null && o.expiresAt <= now) continue;
      if (o.priceBasis !== "LIST" && (o.availableGpuCount === 0 || o.availability !== "AVAILABLE")) continue;
      const key = quoteKey(o);
      // A signed list cannot manufacture extra votes using duplicate records.
      if (seen.has(key)) continue;
      seen.add(key);
      const row = votes.get(key) ?? new Map<string, Vote>();
      const previous = row.get(group);
      // Multiple keys belonging to one operator have exactly one vote.
      if (!previous || previous.observation.observedAt < o.observedAt) row.set(group, { observation: o, group });
      votes.set(key, row);
    }
  }
  const quorum = requiredOperators(registry, methodology);
  const quotes: Quote[] = [];
  for (const row of votes.values()) {
    const values = [...row.values()];
    if (values.length < quorum) continue;
    const center = median(values.map(x => toMicros(x.observation.price)));
    const agreeing = values.filter(x => distance(toMicros(x.observation.price), center) * 10_000n <= center * BigInt(methodology.maxCollectorDeviationBps));
    if (agreeing.length < quorum) continue;
    const price = median(agreeing.map(x => toMicros(x.observation.price)));
    quotes.push({ observation: agreeing[0]!.observation, price,
      spread: agreeing.reduce((s, x) => { const d = distance(toMicros(x.observation.price), price); return d > s ? d : s; }, 0n),
      groups: agreeing.map(x => x.group).sort(), observedAt: Math.min(...agreeing.map(x => x.observation.observedAt)) });
  }
  const feeds: Feed[] = [];
  for (const provider of [...registry.providers].sort((a, b) => a.id.localeCompare(b.id))) for (const model of MODELS) {
    const feed = empty(`SBX:${provider.id}:${model}`, "PROVIDER", model, provider.id, now, "INSUFFICIENT_MATCHED_OPERATOR_REPORTS");
    const matching = quotes.filter(q => q.observation.provider === provider.id && q.observation.model === model);
    if (matching.length) {
      const regions = [...new Set(matching.map(x => x.observation.region))].sort();
      const regionalPrices = regions.map(region => median(matching.filter(x => x.observation.region === region).map(x => x.price)));
      const price = median(regionalPrices);
      const spread = matching.reduce((s, q) => { const d = distance(q.price, price) + q.spread; return d > s ? d : s; }, 0n);
      Object.assign(feed, { status: "READY", price: fromMicros(price), confidence: fromMicros(spread), reasons: [],
        observedAt: Math.min(...matching.map(x => x.observedAt)), contributors: [...new Set(matching.flatMap(q => q.groups))].sort() });
    }
    feeds.push(feed);
  }
  for (const model of MODELS) {
    const feed = empty(`SBX:${model}`, "MODEL", model, null, now, "INSUFFICIENT_PROVIDER_GROUPS");
    const weights = methodology.providerWeights[model];
    feed.weights = { ...weights };
    const groups = Object.keys(weights).sort();
    const inputs: Array<{ group: string; price: bigint; weight: number; time: number; spread: bigint }> = [];
    for (const group of groups) {
      const providers = new Set(registry.providers.filter(p => p.economicGroup === group).map(p => p.id));
      const matches = feeds.filter(f => f.kind === "PROVIDER" && f.model === model && f.provider && providers.has(f.provider) && f.status === "READY");
      if (matches.length) {
        const price = median(matches.map(f => toMicros(f.price!)));
        const spread = matches.reduce((s, f) => { const d = distance(toMicros(f.price!), price) + BigInt(f.confidence!.replace(".", "")); return d > s ? d : s; }, 0n);
        inputs.push({ group, price, weight: weights[group]!, time: Math.min(...matches.map(f => f.observedAt!)), spread });
      }
    }
    // Fixed constituent coverage: source loss does not silently rebalance the index.
    if (groups.length >= methodology.minProviderGroups && inputs.length === groups.length) {
      const price = weighted(inputs);
      const spread = inputs.reduce((s, x) => { const d = distance(x.price, price) + x.spread; return d > s ? d : s; }, 0n);
      if (spread * 10_000n > price * BigInt(methodology.maxProviderDispersionBps)) feed.reasons = ["EXCESSIVE_PROVIDER_DISPERSION"];
      else Object.assign(feed, { status: "READY", price: fromMicros(price), confidence: fromMicros(spread), reasons: [], observedAt: Math.min(...inputs.map(x => x.time)), contributors: inputs.map(x => x.group) });
    } else if (groups.length >= methodology.minProviderGroups) feed.reasons = ["MISSING_FIXED_WEIGHT_CONSTITUENT"];
    feeds.push(feed);
  }
  const composite = empty("SBX", "COMPOSITE", null, null, now, "MISSING_MODEL_COMPONENT");
  composite.weights = { ...methodology.modelWeights };
  const models = feeds.filter(f => f.kind === "MODEL");
  if (models.length === MODELS.length && models.every(f => f.status === "READY")) {
    const price = weighted(models.map(f => ({ price: toMicros(f.price!), weight: methodology.modelWeights[f.model!] })));
    const confidence = weighted(models.map(f => ({ price: BigInt(f.confidence!.replace(".", "")), weight: methodology.modelWeights[f.model!] })));
    Object.assign(composite, { status: "READY", price: fromMicros(price), confidence: fromMicros(confidence), reasons: [], observedAt: Math.min(...models.map(f => f.observedAt!)), contributors: models.map(f => f.id) });
  }
  feeds.push(composite);
  const activeMethodology = methodology.status === "APPROVED" && methodology.effectiveAt <= now;
  if (methodology.effectiveAt > now) for (const f of feeds) Object.assign(f, { status: "UNAVAILABLE", price: null, confidence: null, reasons: ["METHODOLOGY_NOT_EFFECTIVE"] });
  return { schemaVersion: 1, network: registry.network, calculatedAt: now, methodologyVersion: methodology.version,
    methodologyHash: hash(methodology), registryHash: hash(registry), publishable: activeMethodology && composite.status === "READY",
    feeds, inputBatchHashes: accepted.map(hash).sort(), rejected: rejected.sort((a, b) => a.batchHash.localeCompare(b.batchHash) || a.reason.localeCompare(b.reason)) };
}
