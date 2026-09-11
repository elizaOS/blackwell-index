/** Diagnostic only: never grants approval or changes calculation/publication policy. */
import { calculate, requiredOperators } from "./engine";
import type { GpuModel, Methodology, Registry, SignedBatch } from "./types";
import { isFeedPublishable } from "./publication";
import { compileOfferSchedule } from "./offer-schedule";

export function qualifyModel(batches: SignedBatch[], registry: Registry, methodology: Methodology, model: GpuModel, at: number) {
  const snapshot = calculate(batches, registry, methodology, at);
  const feed = snapshot.feeds.find(value => value.id === `SBX:${model}`)!;
  const weights = methodology.providerWeights[model];
  const schedule = model === "B200" ? compileOfferSchedule(methodology, registry) : undefined;
  const enabledOperatorGroups = new Set(registry.operators.filter(value => value.enabled).map(value => value.operatorGroup)).size;
  const groups = Object.keys(weights).sort().map(group => {
    const selected = schedule?.groupProviders.get(group);
    const providers = registry.providers.filter(value => value.economicGroup === group && (!schedule || selected?.has(value.id)));
    const rights = (value: Registry["providers"][number]) => value.rights.collect && value.rights.redistribute && value.rights.derive &&
      Boolean(value.rights.evidence.trim()) && (value.rights.expiresAt === null || value.rights.expiresAt > at);
    const ready = (value: Registry["providers"][number]) => snapshot.feeds.some(item => item.id === `SBX:${value.id}:${model}` && item.status === "READY");
    return { group, weight: weights[group]!, providers: providers.map(value => value.id).sort(),
      rightsConfigured: schedule ? providers.length > 0 && providers.every(rights) : providers.some(rights),
      matchedReportsReady: schedule ? providers.length > 0 && providers.every(ready) : providers.some(ready) };
  });
  const blockers = [...feed.reasons];
  if (methodology.status !== "APPROVED") blockers.push("METHODOLOGY_NOT_APPROVED");
  if (methodology.effectiveAt > at) blockers.push("METHODOLOGY_NOT_EFFECTIVE");
  if (groups.length < methodology.minProviderGroups) blockers.push("INSUFFICIENT_FIXED_PROVIDER_GROUPS");
  if (groups.some(group => !group.rightsConfigured)) blockers.push("CONSTITUENT_RIGHTS_NOT_CONFIGURED");
  if (enabledOperatorGroups < requiredOperators(registry, methodology)) blockers.push("INSUFFICIENT_ADMITTED_OPERATOR_GROUPS");
  if (snapshot.publicationScope) {
    if (snapshot.publicationScope.model !== model) blockers.push("MODEL_OUTSIDE_PUBLICATION_SCOPE");
    else if (!snapshot.publishable) blockers.push("CURRENT_MODEL_PUBLICATION_GATE_NOT_MET");
  } else if (!snapshot.publishable) blockers.push("CURRENT_COMPOSITE_PUBLICATION_GATE_NOT_MET");
  return { kind: "MODEL_QUALIFICATION_DIAGNOSTIC", asOf: at, model, feed,
    network: snapshot.network, methodologyHash: snapshot.methodologyHash, registryHash: snapshot.registryHash,
    calculationReady: feed.status === "READY", currentSnapshotPublishable: snapshot.publishable,
    ...(snapshot.publicationScope ? { publicationScope: snapshot.publicationScope, currentModelPublishable: isFeedPublishable(snapshot, feed.id) } : {}),
    // A calculation result cannot attest to partner approval, economic rights or market safety.
    liveMarketQualified: false, requiredProviderGroups: methodology.minProviderGroups, groups,
    enabledOperatorGroups, requiredOperatorGroups: requiredOperators(registry, methodology),
    blockers: [...new Set(blockers)].sort(), acceptedBatchHashes: snapshot.inputBatchHashes, rejected: snapshot.rejected,
    externalGates: ["SOURCE_AND_DERIVATIVES_RIGHTS_REVIEW", "INDEPENDENCE_AND_WEIGHT_APPROVAL", "SUSTAINED_OPERATION_AND_SECURITY_REVIEW",
      "PYTH_ROUTE_AND_FEED_APPROVAL", "AUTHENTICATED_UPSTREAM_AND_VENUE_READBACK", "CONTRACT_RISK_LIQUIDITY_AND_OPERATOR_APPROVAL"] };
}
