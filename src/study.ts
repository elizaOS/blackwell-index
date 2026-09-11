/** Descriptive study of retained local captures. No publication, backfill, or network IO. */
import { hash } from "./crypto";
import { fromMicros, toMicros } from "./decimal";
import type { Journal, SqlDriver } from "./journal";
import { MODELS, type Observation } from "./types";
import { observationSchema } from "./validation";
import { observationOfferKey } from "./offer-schedule";

const DAY = 86_400_000;
export const STUDY_LIMITS = Object.freeze({ maxCaptures: 100_000, maxObservations: 100_000, maxInputBytes: 256 * 1024 * 1024,
  maxRowBytes: 4 * 1024 * 1024, maxSeries: 2000, maxAnomalySamples: 1000, maxGapSamples: 1000 });
export interface StudyOptions {
  expectedIntervalMs: number;
  /** Knowledge cutoff: neither captures nor prices learned after this time are used. */
  asOf?: number;
  from?: number;
  maxCaptures?: number;
  maxObservations?: number;
  maxInputBytes?: number;
  maxSeries?: number;
  maxAnomalySamples?: number;
  maxGapSamples?: number;
}

interface Bounds { count: number; first: number | null; last: number | null }

interface Terms {
  provider: string; source: string; model: Observation["model"]; sku: string; region: string;
  procurement: Observation["procurement"]; priceBasis: Observation["priceBasis"]; tenancy: Observation["tenancy"];
  gpuCount: number; includes: string[]; priceScope: NonNullable<Observation["priceScope"]>;
  topology: NonNullable<Observation["topology"]>; minimumOrderGpuCount: number | null;
  currency: "USD"; unit: "USD_PER_GPU_HOUR";
  instanceResources?: Observation["instanceResources"];
  /** Opt-in exact offer identity; never emits retained source URLs or record IDs. */
  offerIdentityHash?: string | null;
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error("Invalid operating study limit");
  return result;
}
function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid operating study time");
  return value;
}
export function studyTerms(observation: Observation): Terms {
  return { provider: observation.provider, source: observation.source, model: observation.model, sku: observation.sku, region: observation.region,
    procurement: observation.procurement, priceBasis: observation.priceBasis, tenancy: observation.tenancy, gpuCount: observation.gpuCount,
    includes: [...observation.includes].sort(), priceScope: observation.priceScope ?? "PUBLIC", topology: observation.topology ?? "UNKNOWN",
    minimumOrderGpuCount: observation.minimumOrderGpuCount ?? null, currency: observation.currency, unit: observation.unit,
    ...(observation.instanceResources ? { instanceResources: { ...observation.instanceResources } } : {}) };
}
/** Signed basis-point change, rounded half away from zero to four decimals. */
export function studyChangeBps(first: bigint, last: bigint): string {
  const numerator = (last - first) * 100_000_000n;
  const absolute = numerator < 0n ? -numerator : numerator;
  const value = (absolute + first / 2n) / first;
  return `${numerator < 0n && value !== 0n ? "-" : ""}${value / 10_000n}.${(value % 10_000n).toString().padStart(4, "0")}`;
}

/** Uses SELECTs in one read transaction; the caller controls private storage/output. */
export function operatingStudy(input: Pick<Journal, "db"> | SqlDriver, options: StudyOptions & { exactB200OfferIdentity?: boolean }) {
  const db = "db" in input ? input.db : input;
  const asOf = timestamp(options.asOf ?? Date.now());
  const interval = bounded(options.expectedIntervalMs, 300_000, DAY);
  const limits = { maxCaptures: bounded(options.maxCaptures, 10_000, STUDY_LIMITS.maxCaptures),
    maxObservations: bounded(options.maxObservations, 50_000, STUDY_LIMITS.maxObservations),
    maxInputBytes: bounded(options.maxInputBytes, 32 * 1024 * 1024, STUDY_LIMITS.maxInputBytes),
    maxSeries: bounded(options.maxSeries, 1000, STUDY_LIMITS.maxSeries),
    maxAnomalySamples: bounded(options.maxAnomalySamples, 100, STUDY_LIMITS.maxAnomalySamples),
    maxGapSamples: bounded(options.maxGapSamples, 100, STUDY_LIMITS.maxGapSamples), maxRowBytes: STUDY_LIMITS.maxRowBytes };
  return db.transaction(() => {
    const retained = db.query("SELECT COUNT(*) AS count,MIN(collected_at) AS first,MAX(collected_at) AS last FROM captures WHERE typeof(collected_at)='integer' AND collected_at BETWEEN 1 AND ?").get(asOf) as Bounds;
    const from = timestamp(options.from ?? retained.first ?? asOf);
    if (from > asOf) throw new Error("Operating study start must not exceed its knowledge cutoff");
    const window = db.query("SELECT COUNT(*) AS count,MIN(collected_at) AS first,MAX(collected_at) AS last FROM captures WHERE typeof(collected_at)='integer' AND collected_at BETWEEN ? AND ?").get(from, asOf) as Bounds;
    const undatable = db.query("SELECT COUNT(*) AS count FROM captures WHERE typeof(collected_at)!='integer' OR collected_at<=0 OR collected_at>?").get(Number.MAX_SAFE_INTEGER) as { count: number };
    const headers = db.query("SELECT id,collected_at,length(CAST(observations AS BLOB))+length(CAST(errors AS BLOB)) AS bytes FROM captures WHERE typeof(collected_at)='integer' AND collected_at BETWEEN ? AND ? ORDER BY collected_at,id LIMIT ?").all(from, asOf, limits.maxCaptures) as { id: number; collected_at: number; bytes: number }[];
    const reasons = new Set<string>(), anomalyCounts: Record<string, number> = {}, anomalySamples: { code: string; captureId: number; observationIndex: number | null; seriesId?: string }[] = [];
    let dataScanComplete = headers.length === window.count;
    if (!dataScanComplete) reasons.add("CAPTURE_LIMIT");
    if (undatable.count) { reasons.add("UNDATABLE_CAPTURE_ROWS"); dataScanComplete = false; }
    const anomaly = (code: string, captureId: number, observationIndex: number | null, seriesId?: string) => {
      anomalyCounts[code] = (anomalyCounts[code] ?? 0) + 1;
      if (anomalySamples.length < limits.maxAnomalySamples) anomalySamples.push({ code, captureId, observationIndex, ...(seriesId ? { seriesId } : {}) });
      else reasons.add("ANOMALY_SAMPLE_LIMIT");
    };
    // Completed, half-open time buckets anchored at `from`; never invent a price
    // for an empty bucket. The final incomplete bucket is not expected yet.
    const expectedBuckets = Math.floor((asOf - from) / interval);
    const occupied = [...new Set(headers.map(row => Math.floor((row.collected_at - from) / interval)).filter(slot => slot < expectedBuckets))].sort((a, b) => a - b);
    const cadenceComplete = headers.length === window.count;
    const gaps: Array<{ from: number; toExclusive: number; expectedCaptures: number }> = [];
    let gapCount = 0, cursor = 0;
    const gap = (end: number) => {
      if (end > cursor) {
        gapCount++;
        if (gaps.length < limits.maxGapSamples) gaps.push({ from: from + cursor * interval, toExclusive: from + end * interval, expectedCaptures: end - cursor });
        else reasons.add("GAP_SAMPLE_LIMIT");
      }
    };
    if (cadenceComplete) {
      for (const slot of occupied) { gap(slot); cursor = slot + 1; }
      gap(expectedBuckets);
    }
    const series = new Map<string, {
      id: string; terms: Terms; captureIds: Set<number>; issues: Set<string>;
      points: {
        captureId: number; knownAt: number; observedAt: number; observationLagMs: number; price: string; instancePrice: string;
        priceEffectiveAt: number | null; expiresAt: number | null;
        availability: NonNullable<Observation["availability"]>; availableGpuCount: number | null;
        evidenceHash: string; evidenceRetainedAtCapture: boolean; observationHash: string;
      }[];
    }>();
    const mappings = new Map<string, Map<string, Set<string>>>();
    const evidenceDates = new Map<string, number | null>();
    let capturesParsed = 0, capturesWithErrors = 0, errorCount = 0, inputBytes = 0, observationsExamined = 0, validObservations = 0, retainedPoints = 0;
    let firstObservationAt: number | null = null, lastObservationAt: number | null = null;
    let evidencePresent = 0, evidenceMissing = 0;
    scan: for (const header of headers) {
      if (!Number.isSafeInteger(header.id) || header.id <= 0) { anomaly("INVALID_CAPTURE_ID", header.id, null); continue; }
      if (header.bytes > limits.maxRowBytes) { reasons.add("CAPTURE_BYTE_LIMIT"); dataScanComplete = false; continue; }
      if (inputBytes + header.bytes > limits.maxInputBytes) { reasons.add("INPUT_BYTE_LIMIT"); dataScanComplete = false; break; }
      const row = db.query("SELECT observations,errors FROM captures WHERE id=?").get(header.id) as { observations: string; errors: string };
      inputBytes += header.bytes;
      let raw: unknown, errors: unknown;
      try { raw = JSON.parse(row.observations); errors = JSON.parse(row.errors); }
      catch { anomaly("INVALID_CAPTURE_JSON", header.id, null); continue; }
      capturesParsed++;
      if (!Array.isArray(errors) || errors.some(error => typeof error !== "string")) anomaly("INVALID_CAPTURE_ERRORS", header.id, null);
      else { errorCount += errors.length; if (errors.length) capturesWithErrors++; }
      if (!Array.isArray(raw)) { anomaly("OBSERVATIONS_NOT_ARRAY", header.id, null); continue; }
      for (let index = 0; index < raw.length; index++) {
        if (observationsExamined >= limits.maxObservations) { reasons.add("OBSERVATION_LIMIT"); dataScanComplete = false; break scan; }
        observationsExamined++;
        let observation: Observation;
        // Report corrupt retained records without aborting the entire study.
        try { observation = observationSchema.parse(raw[index]) as Observation; }
        catch { anomaly("OBSERVATION_SCHEMA_INVALID", header.id, index); continue; }
        if (observation.observedAt > header.collected_at || observation.observedAt > asOf) { anomaly("OBSERVED_AFTER_KNOWLEDGE_TIME", header.id, index); continue; }
        validObservations++;
        firstObservationAt = Math.min(firstObservationAt ?? observation.observedAt, observation.observedAt);
        lastObservationAt = Math.max(lastObservationAt ?? observation.observedAt, observation.observedAt);
        const commercialTerms = studyTerms(observation);
        if (options.exactB200OfferIdentity) {
          const key = observationOfferKey(observation);
          commercialTerms.offerIdentityHash = key === undefined ? null : hash(key);
        }
        const id = hash(commercialTerms);
        let item = series.get(id);
        if (!item) {
          if (series.size >= limits.maxSeries) { reasons.add("SERIES_LIMIT"); dataScanComplete = false; continue; }
          item = { id, terms: commercialTerms, points: [], captureIds: new Set(), issues: new Set() }; series.set(id, item);
        }
        const issue = (code: string) => { anomaly(code, header.id, index, id); item!.issues.add(code); };
        if (observation.priceEffectiveAt !== null && observation.priceEffectiveAt > observation.observedAt) issue("PRICE_NOT_EFFECTIVE_AT_OBSERVATION");
        if (observation.expiresAt !== null && observation.expiresAt <= observation.observedAt) issue("EXPIRED_AT_OBSERVATION");
        const previous = item.points.at(-1);
        if (previous && observation.observedAt < previous.observedAt) issue("OBSERVATION_TIME_REGRESSION");
        if (previous?.observedAt === observation.observedAt && toMicros(previous.price) !== toMicros(observation.price)) issue("CONFLICTING_PRICE_AT_SAME_OBSERVED_TIME");
        // A stable source/SKU/region naming multiple hardware mappings needs review.
        // Different commercial terms are retained separately, not price-averaged.
        const mappingKey = hash([observation.provider, observation.source, observation.sku, observation.region]);
        const specifications = mappings.get(mappingKey) ?? new Map<string, Set<string>>();
        const specification = `${observation.model}:${observation.gpuCount}`;
        const mappedSeries = specifications.get(specification) ?? new Set<string>(); mappedSeries.add(id); specifications.set(specification, mappedSeries); mappings.set(mappingKey, specifications);
        if (specifications.size > 1) {
          issue("SKU_HARDWARE_MAPPING_CHANGED");
          for (const ids of specifications.values()) for (const affected of ids) series.get(affected)!.issues.add("SKU_HARDWARE_MAPPING_CHANGED");
        }
        if (!evidenceDates.has(observation.evidenceHash)) {
          const evidence = db.query("SELECT received_at FROM evidence WHERE hash=?").get(observation.evidenceHash) as { received_at: number } | null;
          evidenceDates.set(observation.evidenceHash, evidence?.received_at ?? null);
        }
        const evidenceDate = evidenceDates.get(observation.evidenceHash)!;
        const evidenceRetainedAtCapture = evidenceDate !== null && Number.isSafeInteger(evidenceDate) && evidenceDate > 0 && evidenceDate <= header.collected_at;
        if (evidenceRetainedAtCapture) evidencePresent++; else evidenceMissing++;
        item.points.push({ captureId: header.id, knownAt: header.collected_at, observedAt: observation.observedAt, observationLagMs: header.collected_at - observation.observedAt, price: fromMicros(toMicros(observation.price)),
          instancePrice: fromMicros(toMicros(observation.instancePrice)), priceEffectiveAt: observation.priceEffectiveAt, expiresAt: observation.expiresAt,
          availability: observation.availability ?? "UNKNOWN", availableGpuCount: observation.availableGpuCount, evidenceHash: observation.evidenceHash, evidenceRetainedAtCapture,
          observationHash: hash(observation) });
        item.captureIds.add(header.id); retainedPoints++;
      }
    }
    const sources = new Map<string, { provider: string; source: string; observations: number; captureIds: Set<number>; models: Set<string> }>();
    const models = new Map(MODELS.map(model => [model, { observations: 0, captureIds: new Set<number>(), sources: new Set<string>() }]));
    const resultSeries = [...series.values()].sort((a, b) => a.id.localeCompare(b.id)).map(item => {
      const sourceKey = `${item.terms.provider}/${item.terms.source}`;
      const source = sources.get(sourceKey) ?? { provider: item.terms.provider, source: item.terms.source, observations: 0, captureIds: new Set<number>(), models: new Set<string>() };
      source.observations += item.points.length; source.models.add(item.terms.model);
      const model = models.get(item.terms.model)!; model.observations += item.points.length; model.sources.add(sourceKey);
      for (const id of item.captureIds) { source.captureIds.add(id); model.captureIds.add(id); }
      sources.set(sourceKey, source);
      const first = item.points[0]!, last = item.points.at(-1)!;
      const prices = item.points.map(point => toMicros(point.price));
      const minimum = prices.reduce((a, b) => a < b ? a : b), maximum = prices.reduce((a, b) => a > b ? a : b);
      const distinctDates = new Set(item.points.map(point => point.observedAt)).size;
      const sensitivityStatus = item.issues.size ? "BLOCKED_BY_ANOMALY" : distinctDates < 2 ? "INSUFFICIENT_DISTINCT_OBSERVATIONS" : "DATED_CHANGE_ONLY";
      return { id: item.id, terms: item.terms, captureCount: item.captureIds.size, observationCount: item.points.length,
        firstKnownAt: first.knownAt, lastKnownAt: last.knownAt, firstObservedAt: first.observedAt, lastObservedAt: last.observedAt,
        firstPrice: first.price, lastPrice: last.price, minimumPrice: fromMicros(minimum), maximumPrice: fromMicros(maximum),
        issues: [...item.issues].sort(), points: item.points,
        sensitivity: { status: sensitivityStatus, firstToLastChangeBps: sensitivityStatus === "DATED_CHANGE_ONLY" ? studyChangeBps(prices[0]!, prices.at(-1)!) : null,
          elapsedKnowledgeMs: last.knownAt - first.knownAt, elapsedObservationMs: last.observedAt - first.observedAt } };
    });
    const observedSpanMs = window.first === null || window.last === null ? 0 : window.last - window.first;
    return { schemaVersion: 1, kind: "RETAINED_CAPTURE_OPERATING_STUDY", privacy: "PRIVATE_RETAINED_DATA", asOf,
      window: { from, to: asOf, captures: window.count, firstCaptureAt: window.first, lastCaptureAt: window.last },
      retainedAsOf: { captures: retained.count, firstCaptureAt: retained.first, lastCaptureAt: retained.last }, undatableCaptures: undatable.count,
      completeness: { complete: reasons.size === 0, dataScanComplete, reasons: [...reasons].sort(), limits,
        capturesSelected: headers.length, capturesParsed, observationsExamined, validObservations, retainedPricePoints: retainedPoints, inputBytes },
      cadence: { definition: "COMPLETED_HALF_OPEN_BUCKETS_ANCHORED_AT_WINDOW_START", expectedIntervalMs: interval, complete: cadenceComplete,
        expectedBuckets, occupiedBuckets: occupied.length, emptyBuckets: cadenceComplete ? expectedBuckets - occupied.length : null,
        gapCount: cadenceComplete ? gapCount : null, gaps, gapSamplesTruncated: reasons.has("GAP_SAMPLE_LIMIT") },
      observations: { firstObservedAt: firstObservationAt, lastObservedAt: lastObservationAt, capturesWithErrors, errorCount,
        evidenceLinks: { retainedAtCapture: evidencePresent, missingAtCapture: evidenceMissing, contentHashesVerified: false } },
      coverage: { sources: [...sources.values()].sort((a, b) => `${a.provider}/${a.source}`.localeCompare(`${b.provider}/${b.source}`)).map(source => ({ provider: source.provider, source: source.source,
        observations: source.observations, captures: source.captureIds.size, models: [...source.models].sort() })),
        models: [...models].map(([model, value]) => ({ model, observations: value.observations, captures: value.captureIds.size, sources: value.sources.size })) },
      series: resultSeries, anomalies: { counts: anomalyCounts, samples: anomalySamples, samplesTruncated: reasons.has("ANOMALY_SAMPLE_LIMIT") },
      proposedThirtyDayStudy: { targetDays: 30, observedSpanMs, minimumCalendarSpanMet: observedSpanMs >= 30 * DAY,
        continuousCaptureCadenceMet: cadenceComplete && expectedBuckets > 0 && occupied.length === expectedBuckets,
        qualification: "NOT_ESTABLISHED" },
      limitations: ["Descriptive local observations only; not an approved benchmark, economic-owner census, market weight, trading backtest, return forecast, or financing validation.",
        "Capture cadence is not provider availability or successful price coverage. No missing prices are filled and repeated quotes are not independent market trades.",
        "Only captures known by the cutoff are used. Price effective dates do not backdate knowledge; future or regressing observation times are excluded or flagged.",
        "SKU series keep provider, source, model, region, procurement, price basis, tenancy, GPU count, bundle, account scope and topology separate. Dated changes are not annualized returns.",
        "Capture records are private local research inputs, not signed quorum votes. Linked evidence existence is checked, not response-body authenticity, rights, or provider approval.",
        "Limits and anomaly samples are explicit. An incomplete scan cannot establish missing-source counts or qualify a sustained operating study."] };
  })();
}
export type OperatingStudy = ReturnType<typeof operatingStudy>;
