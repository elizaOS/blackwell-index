/** Private, bounded, offline B200 research. No signer, publisher, order entry or venue emulator. */
import { hash } from "./crypto";
import { distance, fromMicros, median, toMicros, weighted } from "./decimal";
import type { SqlDriver } from "./journal";
import { operatingStudy, studyChangeBps, type OperatingStudy, type StudyOptions } from "./study";
import type { Methodology, Registry, SignedBatch } from "./types";
import { qualifyModel } from "./qualification";
import { parseMethodology, parseRegistry } from "./validation";

const DAY = 86_400_000;
export const SHADOW_LIMITS = Object.freeze({ cycles: 5000, reports: 1000, reportBytes: 16 * 1024 * 1024 });
type Series = OperatingStudy["series"][number];
type Point = Series["points"][number];
interface Quote { series: Series; point: Point }
interface GroupPrice { group: string; price: string; observedAt: number }
interface Print { at: number; price: string | null; candidatePrice: string | null; sourceAgeMs: number | null;
  dispersionBps: string | null; missingGroups: string[]; reasons: string[]; groups: GroupPrice[] }

function signedUsd(value: bigint): string { return `${value < 0n ? "-" : ""}${fromMicros(value < 0n ? -value : value)}`; }
function integer(value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid shadow risk parameter");
}
/** Linear cash PnL; rates are scenarios, not calibrated venue risk parameters. */
export function positionStress(input: { side: "LONG" | "SHORT"; quantityGpuHours: number; entryPrice: string; indexPrice: string;
  collateralUsd: string; markPremiumBps: number; maintenanceMarginBps: number; fundingBpsPerDay: number; elapsedMs: number }) {
  if (input.side !== "LONG" && input.side !== "SHORT") throw new Error("Invalid shadow side");
  integer(input.quantityGpuHours, 1, 1_000_000); integer(input.markPremiumBps, -9000, 100_000);
  integer(input.maintenanceMarginBps, 1, 10_000); integer(input.fundingBpsPerDay, -10_000, 10_000); integer(input.elapsedMs, 0, 366 * DAY);
  const direction = input.side === "LONG" ? 1n : -1n, quantity = BigInt(input.quantityGpuHours);
  const entry = toMicros(input.entryPrice), index = toMicros(input.indexPrice), collateral = toMicros(input.collateralUsd);
  const mark = (index * BigInt(10_000 + input.markPremiumBps) + 5000n) / 10_000n;
  if (mark <= 0n) throw new Error("Shadow mark below precision");
  const pnl = direction * quantity * (mark - entry);
  // Constant entry notional, simple accrued funding. Integer division truncates toward zero.
  const fundingCost = direction * quantity * entry * BigInt(input.fundingBpsPerDay) * BigInt(input.elapsedMs) / (10_000n * BigInt(DAY));
  const equity = collateral + pnl - fundingCost;
  const maintenance = (quantity * mark * BigInt(input.maintenanceMarginBps) + 9999n) / 10_000n;
  return { side: input.side, quantityGpuHours: input.quantityGpuHours, markPremiumBps: input.markPremiumBps,
    indexPrice: input.indexPrice, markPrice: fromMicros(mark), pnlUsd: signedUsd(pnl), fundingCostUsd: signedUsd(fundingCost),
    equityUsd: signedUsd(equity), maintenanceUsd: fromMicros(maintenance), maintenanceBreached: equity <= maintenance,
    negativeEquity: equity < 0n, executed: false };
}

function groupPrices(quotes: Quote[], registry: Registry, methodology: Methodology, at: number): GroupPrice[] {
  const eligible = quotes.filter(({ series, point }) => {
    const t = series.terms, p = registry.providers.find(value => value.id === t.provider);
    return p && p.sources.includes(t.source) && t.model === "B200" && t.procurement === "ON_DEMAND" && t.priceBasis === "LIST" &&
      t.tenancy === "EXCLUSIVE" && t.priceScope === "PUBLIC" &&
      (methodology.cohort.regions.includes("*") || methodology.cohort.regions.includes(t.region)) &&
      point.knownAt <= at && point.observedAt <= point.knownAt && at - point.observedAt <= methodology.maxAgeMs &&
      (point.priceEffectiveAt === null || point.priceEffectiveAt <= point.observedAt) && (point.expiresAt === null || point.expiresAt > at);
  });
  const providers = registry.providers.flatMap(provider => {
    const matches = eligible.filter(value => value.series.terms.provider === provider.id);
    if (!matches.length) return [];
    const regions = [...new Set(matches.map(value => value.series.terms.region))].sort();
    return [{ group: provider.economicGroup, price: median(regions.map(region => median(matches.filter(value => value.series.terms.region === region)
      .map(value => toMicros(value.point.price))))), observedAt: Math.min(...matches.map(value => value.point.observedAt)) }];
  });
  return [...new Set(providers.map(value => value.group))].sort().map(group => {
    const matches = providers.filter(value => value.group === group);
    return { group, price: fromMicros(median(matches.map(value => value.price))), observedAt: Math.min(...matches.map(value => value.observedAt)) };
  });
}

function fixedPrint(groups: GroupPrice[], weights: Record<string, number>, methodology: Methodology, at: number, incomplete: boolean): Print {
  const panel = Object.keys(weights).sort(), inputs = groups.filter(value => panel.includes(value.group));
  const missingGroups = panel.filter(group => !inputs.some(value => value.group === group)), reasons: string[] = [];
  if (!panel.length) reasons.push("NO_RESEARCH_PANEL");
  if (missingGroups.length) reasons.push("MISSING_FIXED_CONSTITUENT");
  if (incomplete) reasons.push("INCOMPLETE_OR_ANOMALOUS_INPUT");
  const candidate = panel.length && !missingGroups.length ? weighted(inputs.map(value => ({ price: toMicros(value.price), weight: weights[value.group]! }))) : null;
  const spread = candidate === null ? null : inputs.reduce((maximum, value) => {
    const deviation = distance(toMicros(value.price), candidate); return deviation > maximum ? deviation : maximum;
  }, 0n);
  if (candidate !== null && spread! * 10_000n > candidate * BigInt(methodology.maxProviderDispersionBps)) reasons.push("EXCESSIVE_PROVIDER_DISPERSION");
  return { at, price: candidate !== null && !reasons.length ? fromMicros(candidate) : null,
    candidatePrice: candidate === null ? null : fromMicros(candidate), sourceAgeMs: inputs.length ? at - Math.min(...inputs.map(value => value.observedAt)) : null,
    dispersionBps: candidate === null ? null : studyChangeBps(candidate, candidate + spread!), missingGroups, reasons, groups: inputs };
}

export function shadowStudy(db: SqlDriver, registryInput: Registry, methodologyInput: Methodology, options: StudyOptions) {
  const registry = parseRegistry(registryInput), methodology = parseMethodology(methodologyInput);
  return db.transaction(() => {
    const study = operatingStudy(db, { ...options, maxCaptures: Math.min(options.maxCaptures ?? SHADOW_LIMITS.cycles, SHADOW_LIMITS.cycles) });
    const rows = db.query("SELECT DISTINCT collected_at FROM captures WHERE collected_at BETWEEN ? AND ? ORDER BY collected_at LIMIT ?")
      .all(study.window.from, study.asOf, SHADOW_LIMITS.cycles + 1) as Array<{ collected_at: number }>;
    const cycles = rows.slice(0, SHADOW_LIMITS.cycles).map(row => row.collected_at);
    const byCycle = new Map<number, Map<string, Quote>>(); let conflictingPoints = 0;
    for (const series of study.series.filter(value => value.terms.model === "B200")) for (const point of series.points) {
      const cycle = byCycle.get(point.knownAt) ?? new Map<string, Quote>();
      const previous = cycle.get(series.id);
      if (previous?.point.observedAt === point.observedAt && previous.point.price !== point.price) conflictingPoints++;
      if (!previous || previous.point.observedAt < point.observedAt) cycle.set(series.id, { series, point });
      byCycle.set(point.knownAt, cycle);
    }
    const unsupportedCohort = methodology.cohort.procurement !== "ON_DEMAND" || methodology.cohort.priceBasis !== "LIST";
    const inputIncomplete = unsupportedCohort || !study.completeness.complete || rows.length > SHADOW_LIMITS.cycles || conflictingPoints > 0 || Object.keys(study.anomalies.counts).length > 0;
    const pricesByCycle = cycles.map(at => ({ at, groups: groupPrices([...(byCycle.get(at)?.values() ?? [])], registry, methodology, at) }));
    // An explicit configured panel wins. Otherwise freeze the first observed panel for research only.
    const configuredWeights = methodology.providerWeights.B200;
    const weights = Object.keys(configuredWeights).length ? { ...configuredWeights } : Object.fromEntries((pricesByCycle.find(value => value.groups.length)?.groups ?? []).map(value => [value.group, 1]));
    const panelBasis = Object.keys(configuredWeights).length ? "CURRENT_CONFIGURED_WEIGHTS" : "FIRST_OBSERVED_PANEL_EQUAL_RESEARCH_WEIGHTS";
    const timeline: Print[] = [];
    for (let index = 0; index < pricesByCycle.length; index++) {
      const value = pricesByCycle[index]!, quotes = [...(byCycle.get(value.at)?.values() ?? [])];
      timeline.push(fixedPrint(value.groups, weights, methodology, value.at, inputIncomplete));
      const next = pricesByCycle[index + 1]?.at ?? study.asOf;
      // Check expiry boundaries between captures, including after an earlier irrelevant quote expired.
      const expiries = [...new Set(quotes.flatMap(quote => [quote.point.observedAt + methodology.maxAgeMs + 1,
        quote.point.expiresAt ?? Number.MAX_SAFE_INTEGER]).filter(expiry => expiry > value.at && expiry < next))].sort((a, b) => a - b);
      for (const expiry of expiries) timeline.push(fixedPrint(groupPrices(quotes, registry, methodology, expiry), weights, methodology, expiry, inputIncomplete));
    }
    const lastCycle = cycles.at(-1), lastQuotes = lastCycle === undefined ? [] : [...(byCycle.get(lastCycle)?.values() ?? [])];
    const current = fixedPrint(groupPrices(lastQuotes, registry, methodology, study.asOf), weights, methodology, study.asOf, inputIncomplete);
    const reference = [...timeline].reverse().find(value => value.price !== null) ?? null;
    const decimalLimit = toMicros("99999999999.999999");
    const stressWithinRange = reference !== null && toMicros(reference.price!) * 50n <= decimalLimit &&
      reference.groups.every(value => (toMicros(value.price) * 15000n + 5000n) / 10_000n <= decimalLimit);
    const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0);
    const scenarios: Array<{ name: string; inputKind: "HYPOTHETICAL_OVERLAY"; result: Print; accidentalReweightPrice: string | null; changeBps: string | null; positions: ReturnType<typeof positionStress>[] }> = [];
    if (reference && stressWithinRange) {
      const variants: Array<{ name: string; groups: GroupPrice[] }> = [{ name: "REFERENCE_WITH_MARK_AND_FUNDING_STRESS", groups: reference.groups }];
      for (const group of Object.keys(weights).sort()) {
        variants.push({ name: `REMOVE_GROUP:${group}`, groups: reference.groups.filter(value => value.group !== group) });
        for (const factor of [5000, 15000]) variants.push({ name: `GROUP_PRICE_${factor === 5000 ? "DOWN" : "UP"}_50_PERCENT:${group}`,
          groups: reference.groups.map(value => value.group === group ? { ...value, price: fromMicros((toMicros(value.price) * BigInt(factor) + 5000n) / 10_000n) } : value) });
      }
      variants.push({ name: "ALL_SOURCES_EXPIRED", groups: [] });
      for (const variant of variants) {
        const result = fixedPrint(variant.groups, weights, methodology, reference.at, inputIncomplete);
        const reweighted = variant.groups.length && result.missingGroups.length ? fromMicros(weighted(variant.groups.map(value => ({ price: toMicros(value.price), weight: weights[value.group]! })))) : null;
        const collateral = fromMicros(toMicros(reference.price!) * 50n);
        const positions = result.price === null ? [] : ([-2000, 0, 2000] as const).flatMap(markPremiumBps => (["LONG", "SHORT"] as const).map(side => positionStress({
          side, quantityGpuHours: 100, entryPrice: reference.price!, indexPrice: result.price!, collateralUsd: collateral,
          markPremiumBps, maintenanceMarginBps: 1000, fundingBpsPerDay: 10, elapsedMs: DAY })));
        scenarios.push({ name: variant.name, inputKind: "HYPOTHETICAL_OVERLAY", result, accidentalReweightPrice: reweighted,
          changeBps: result.candidatePrice === null ? null : studyChangeBps(toMicros(reference.price!), toMicros(result.candidatePrice)), positions });
      }
    }
    // Bounded read of archived signed inputs; never loads a private identity or initializes Store.
    const reportHeaders = db.query("SELECT r.hash,length(CAST(r.payload AS BLOB)) AS bytes FROM reports r JOIN (SELECT node_id,MAX(sequence) AS seq FROM reports WHERE received_at<=? GROUP BY node_id) l ON r.node_id=l.node_id AND r.sequence=l.seq WHERE r.node_id NOT IN (SELECT node_id FROM equivocations WHERE detected_at<=?) ORDER BY r.node_id LIMIT ?")
      .all(study.asOf, study.asOf, SHADOW_LIMITS.reports + 1) as Array<{ hash: string; bytes: number }>;
    const reportsComplete = reportHeaders.length <= SHADOW_LIMITS.reports && reportHeaders.reduce((sum, value) => sum + value.bytes, 0) <= SHADOW_LIMITS.reportBytes;
    const batches: SignedBatch[] = [];
    let reportsIntact = reportsComplete;
    if (reportsComplete) for (const header of reportHeaders) {
      const row = db.query("SELECT payload FROM reports WHERE hash=?").get(header.hash) as { payload: string };
      try { const raw = JSON.parse(row.payload) as SignedBatch; if (hash(raw) !== header.hash) reportsIntact = false; else batches.push(raw); }
      catch { reportsIntact = false; }
    }
    const qualification = reportsIntact ? qualifyModel(batches, registry, methodology, "B200", study.asOf) : null;
    return { schemaVersion: 1, kind: "B200_SHADOW_STUDY", privacy: "PRIVATE_RETAINED_DATA", publishable: false, liveMarketQualified: false, asOf: study.asOf,
      methodologyHash: hash(methodology), registryHash: hash(registry), studyHash: hash(study),
      completeness: { complete: !inputIncomplete && reportsIntact, inputIncomplete, reportsIntact, study: study.completeness, conflictingPoints, unsupportedCohort },
      qualification, qualificationError: reportsIntact ? null : "SIGNED_REPORT_SCAN_INCOMPLETE_OR_CORRUPT",
      panel: { basis: panelBasis, weights, groups: Object.keys(weights).length, requiredProductionGroups: methodology.minProviderGroups,
        largestWeightBps: totalWeight ? Math.ceil(Math.max(...Object.values(weights)) * 10_000 / totalWeight) : null },
      window: study.window, cadence: study.cadence, evidence: study.observations.evidenceLinks, anomalies: study.anomalies.counts,
      sustainedOperation: study.proposedThirtyDayStudy, timeline, current, stressReferenceAt: reference?.at ?? null,
      stressUnavailableReason: reference === null ? "NO_AVAILABLE_RESEARCH_REFERENCE" : stressWithinRange ? null : "SCENARIO_EXCEEDS_DECIMAL_RANGE", scenarios,
      riskAssumptions: { quantityGpuHours: 100, collateralFractionOfEntryNotional: "0.5", maintenanceMarginBps: 1000, markPremiumBps: [-2000, 0, 2000],
        fundingBpsPerDay: 10, elapsedDays: 1, calibrated: false, feesSlippageAndLiquidationExecutionIncluded: false },
      limitations: ["Private retrospective research with current configuration; not a historical membership reconstruction, approved oracle or venue backtest.",
        "Captured prices have no independent operator quorum. Source hosts, response authenticity and legal rights are not established by the research curve.",
        "Complete capture cycles use a fixed panel; missing constituents produce gaps. The current view ages the last capture without refreshing its source time.",
        "Synthetic stresses are separate overlays. Accidental reweight prices demonstrate the unsafe alternative and are never used for position calculations.",
        "Mark and simple funding scenarios are assumptions, not Hyperliquid rules, calibrated leverage, executable liquidity or liquidation outcomes.",
        "Per-model diagnostics retain the existing composite publication gate. Pyth approval and authenticated upstream/venue delivery remain external gates."] };
  })();
}
