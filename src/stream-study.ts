/** Read-only descriptive aggregates. Memory is bounded by one capture and configured series, never history length. */
import { hash } from "./crypto";
import { fromMicros, toMicros } from "./decimal";
import type { Journal, SqlDriver } from "./journal";
import { studyChangeBps, studyTerms } from "./study";
import { MODELS, type Observation } from "./types";
import { observationSchema } from "./validation";

const DAY = 86_400_000;
export const STREAM_STUDY_LIMITS = Object.freeze({ maxCaptures: 2_000_000, maxObservations: 10_000_000,
  maxInputBytes: 16 * 1024 ** 3, maxRowBytes: 4 * 1024 ** 2, maxSeries: 2000, maxSamples: 1000 });
export interface StreamStudyOptions {
  expectedIntervalMs: number; asOf?: number; from?: number; maxCaptures?: number; maxObservations?: number;
  maxInputBytes?: number; maxSeries?: number; maxSamples?: number;
}

interface Header { id: number; collected_at: number; bytes: number }
interface Point { knownAt: number; observedAt: number; price: string }

interface Coverage { observations: number; captures: number; lastCapture: number; sources: Set<string>; models: Set<string> }
function integer(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) throw new Error("INVALID_STREAM_STUDY_LIMIT");
  return result;
}
const time = (value: number) => integer(value, value, 8_640_000_000_000_000);
const coverage = (): Coverage => ({ observations: 0, captures: 0, lastCapture: -1, sources: new Set(), models: new Set() });

export function streamingStudy(input: Pick<Journal, "db"> | SqlDriver, options: StreamStudyOptions) {
  const db = "db" in input ? input.db : input, asOf = time(options.asOf ?? Date.now());
  const interval = integer(options.expectedIntervalMs, 300_000, DAY);
  const limits = { maxCaptures: integer(options.maxCaptures, 100_000, STREAM_STUDY_LIMITS.maxCaptures),
    maxObservations: integer(options.maxObservations, 2_000_000, STREAM_STUDY_LIMITS.maxObservations),
    maxInputBytes: integer(options.maxInputBytes, 4 * 1024 ** 3, STREAM_STUDY_LIMITS.maxInputBytes),
    maxSeries: integer(options.maxSeries, 1000, STREAM_STUDY_LIMITS.maxSeries),
    maxSamples: integer(options.maxSamples, 100, STREAM_STUDY_LIMITS.maxSamples), maxRowBytes: STREAM_STUDY_LIMITS.maxRowBytes };
  return db.transaction(() => {
    // A restored hosted journal retains physical batches and separate cycle markers.
    const chunked = !!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='collection_captures'").get();
    const cycleTable = chunked ? "collection_captures" : "captures";
    const bounds = (table: string, start: number) => db.query(`SELECT COUNT(*) AS count,MIN(collected_at) AS first,MAX(collected_at) AS last FROM ${table} WHERE typeof(collected_at)='integer' AND collected_at BETWEEN ? AND ?`).get(start, asOf) as { count: number; first: number | null; last: number | null };
    const retained = bounds(cycleTable, 1), from = time(options.from ?? retained.first ?? asOf);
    if (from > asOf) throw new Error("INVALID_STREAM_STUDY_WINDOW");
    const window = bounds(cycleTable, from), batches = bounds("captures", from);
    const undatable = (db.query(`SELECT COUNT(*) AS count FROM ${cycleTable} WHERE typeof(collected_at)!='integer' OR collected_at<=0 OR collected_at>?`).get(8_640_000_000_000_000) as { count: number }).count;
    const undatableBatches = chunked ? (db.query("SELECT COUNT(*) AS count FROM captures WHERE typeof(collected_at)!='integer' OR collected_at<=0 OR collected_at>?").get(8_640_000_000_000_000) as { count: number }).count : undatable;
    const reasons = new Set<string>(), counts: Record<string, number> = {};
    const samples: Array<{ code: string; captureId: number; observationIndex: number | null; seriesId?: string }> = [];
    let dataScanComplete = true;
    const anomaly = (code: string, captureId: number, observationIndex: number | null, seriesId?: string) => {
      counts[code] = (counts[code] ?? 0) + 1;
      if (samples.length < limits.maxSamples) samples.push({ code, captureId, observationIndex, ...(seriesId ? { seriesId } : {}) });
      else reasons.add("ANOMALY_SAMPLE_LIMIT");
    };
    if (undatable || undatableBatches) { reasons.add("UNDATABLE_CAPTURE_ROWS"); dataScanComplete = false; }
    if (chunked) {
      // Correctly dated rows outside this knowledge window cannot change a
      // historical study. Undatable markers are still reported separately.
      const ambiguous = db.query("SELECT collected_at FROM collection_captures WHERE typeof(collected_at)='integer' AND collected_at BETWEEN ? AND ? GROUP BY collected_at HAVING COUNT(*)>1 LIMIT 1").get(from, asOf);
      const orphan = db.query("SELECT 1 FROM captures c WHERE typeof(c.collected_at)='integer' AND c.collected_at BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM collection_captures m WHERE m.collected_at=c.collected_at) LIMIT 1").get(from, asOf);
      const missing = db.query("SELECT 1 FROM collection_captures m WHERE typeof(m.collected_at)='integer' AND m.collected_at BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM captures c WHERE c.collected_at=m.collected_at) LIMIT 1").get(from, asOf);
      if (ambiguous || orphan || missing) { reasons.add("AMBIGUOUS_CAPTURE_CYCLE_MAPPING"); dataScanComplete = false; }
    }
    // Cadence uses a separate ordered cursor. Neither bucket IDs nor capture IDs are retained.
    const expectedBuckets = Math.floor((asOf - from) / interval);
    const cadenceComplete = window.count <= limits.maxCaptures && !undatable && !undatableBatches && !reasons.has("AMBIGUOUS_CAPTURE_CYCLE_MAPPING");
    const gaps: Array<{ from: number; toExclusive: number; expectedCaptures: number }> = [];
    let occupied = 0, cursor = 0, gapCount = 0;
    const gap = (end: number) => {
      if (end > cursor) {
        gapCount++;
        if (gaps.length < limits.maxSamples) gaps.push({ from: from + cursor * interval, toExclusive: from + end * interval, expectedCaptures: end - cursor });
        else reasons.add("GAP_SAMPLE_LIMIT");
      }
    };
    if (cadenceComplete) {
      for (const row of db.query(`SELECT collected_at FROM ${cycleTable} WHERE typeof(collected_at)='integer' AND collected_at BETWEEN ? AND ? ORDER BY collected_at,id`).iterate(from, asOf) as Iterable<{ collected_at: number }>) {
        const slot = Math.floor((row.collected_at - from) / interval);
        if (slot < cursor || slot >= expectedBuckets) continue;
        gap(slot); occupied++; cursor = slot + 1;
      }
      gap(expectedBuckets);
    }
    const series = new Map<string, {
      id: string; terms: ReturnType<typeof studyTerms>; first: Point; last: Point; minimum: bigint; maximum: bigint;
      observations: number; captures: number; lastCapture: number; distinctTimes: boolean; issues: Set<string>;
    }>(), mappings = new Map<string, Map<string, Set<string>>>();
    const sources = new Map<string, Coverage & { provider: string; source: string }>();
    const models = new Map(MODELS.map(model => [model, coverage()]));
    // Tiny LRU bounds repeated evidence receipt lookups even when every capture has new evidence.
    const evidenceDates = new Map<string, number | null>();
    let selected = 0, parsed = 0, examined = 0, valid = 0, retainedPoints = 0, inputBytes = 0;
    let errorCount = 0, capturesWithErrors = 0, lastErrorCycle = -1, evidencePresent = 0, evidenceMissing = 0;
    let firstObservationAt: number | null = null, lastObservationAt: number | null = null;
    function* headers(): Generator<Header> {
      let lastTime = from, lastId = 0, remaining = limits.maxCaptures, first = true;
      while (remaining > 0) {
        // A bounded metadata page leaves no native SQLite cursor open on an early
        // observation/byte-budget exit. No capture payload is prefetched here.
        const page = (first ? db.query("SELECT id,collected_at,length(CAST(observations AS BLOB))+length(CAST(errors AS BLOB)) AS bytes FROM captures WHERE typeof(collected_at)='integer' AND collected_at BETWEEN ? AND ? ORDER BY collected_at,id LIMIT ?").all(from, asOf, Math.min(256, remaining))
          : db.query("SELECT id,collected_at,length(CAST(observations AS BLOB))+length(CAST(errors AS BLOB)) AS bytes FROM captures WHERE typeof(collected_at)='integer' AND collected_at BETWEEN ? AND ? AND (collected_at>? OR (collected_at=? AND id>?)) ORDER BY collected_at,id LIMIT ?").all(from, asOf, lastTime, lastTime, lastId, Math.min(256, remaining))) as Header[];
        first = false;
        if (!page.length) return;
        for (const header of page) { remaining--; lastTime = header.collected_at; lastId = header.id; yield header; }
      }
    }
    scan: for (const header of headers()) {
      selected++;
      if (!Number.isSafeInteger(header.id) || header.id <= 0) { anomaly("INVALID_CAPTURE_ID", header.id, null); dataScanComplete = false; continue; }
      if (!Number.isSafeInteger(header.bytes) || header.bytes < 0 || header.bytes > limits.maxRowBytes) { reasons.add("CAPTURE_BYTE_LIMIT"); dataScanComplete = false; continue; }
      if (inputBytes + header.bytes > limits.maxInputBytes) { reasons.add("INPUT_BYTE_LIMIT"); dataScanComplete = false; break; }
      const row = db.query("SELECT observations,errors FROM captures WHERE id=?").get(header.id) as { observations: string; errors: string };
      inputBytes += header.bytes;
      const cycleId = chunked ? header.collected_at : header.id;
      let raw: unknown, errors: unknown;
      try { raw = JSON.parse(row.observations); errors = JSON.parse(row.errors); }
      catch { anomaly("INVALID_CAPTURE_JSON", header.id, null); continue; }
      parsed++;
      if (!Array.isArray(errors) || errors.some(error => typeof error !== "string")) anomaly("INVALID_CAPTURE_ERRORS", header.id, null);
      else { errorCount += errors.length; if (errors.length && cycleId !== lastErrorCycle) { capturesWithErrors++; lastErrorCycle = cycleId; } }
      if (!Array.isArray(raw)) { anomaly("OBSERVATIONS_NOT_ARRAY", header.id, null); continue; }
      for (let index = 0; index < raw.length; index++) {
        if (examined >= limits.maxObservations) { reasons.add("OBSERVATION_LIMIT"); dataScanComplete = false; break scan; }
        examined++;
        let observation: Observation;
        try { observation = observationSchema.parse(raw[index]) as Observation; }
        catch { anomaly("OBSERVATION_SCHEMA_INVALID", header.id, index); continue; }
        if (observation.observedAt > header.collected_at || observation.observedAt > asOf) { anomaly("OBSERVED_AFTER_KNOWLEDGE_TIME", header.id, index); continue; }
        valid++;
        firstObservationAt = Math.min(firstObservationAt ?? observation.observedAt, observation.observedAt);
        lastObservationAt = Math.max(lastObservationAt ?? observation.observedAt, observation.observedAt);
        const commercialTerms = studyTerms(observation), id = hash(commercialTerms), price = toMicros(observation.price);
        const point = { knownAt: header.collected_at, observedAt: observation.observedAt, price: fromMicros(price) };
        let item = series.get(id);
        if (!item) {
          if (series.size >= limits.maxSeries) { reasons.add("SERIES_LIMIT"); dataScanComplete = false; continue; }
          item = { id, terms: commercialTerms, first: point, last: point, minimum: price, maximum: price,
            observations: 0, captures: 0, lastCapture: -1, distinctTimes: false, issues: new Set() };
          series.set(id, item);
        }
        const issue = (code: string) => { anomaly(code, header.id, index, id); item!.issues.add(code); };
        if (observation.priceEffectiveAt !== null && observation.priceEffectiveAt > observation.observedAt) issue("PRICE_NOT_EFFECTIVE_AT_OBSERVATION");
        if (observation.expiresAt !== null && observation.expiresAt <= observation.observedAt) issue("EXPIRED_AT_OBSERVATION");
        if (item.observations && observation.observedAt < item.last.observedAt) issue("OBSERVATION_TIME_REGRESSION");
        if (item.observations && observation.observedAt === item.last.observedAt && price !== toMicros(item.last.price)) issue("CONFLICTING_PRICE_AT_SAME_OBSERVED_TIME");
        const mappingKey = hash([observation.provider, observation.source, observation.sku, observation.region]);
        const specifications = mappings.get(mappingKey) ?? new Map<string, Set<string>>(), specification = `${observation.model}:${observation.gpuCount}`;
        const mappedSeries = specifications.get(specification) ?? new Set<string>(); mappedSeries.add(id);
        specifications.set(specification, mappedSeries); mappings.set(mappingKey, specifications);
        if (specifications.size > 1) {
          issue("SKU_HARDWARE_MAPPING_CHANGED");
          for (const ids of specifications.values()) for (const affected of ids) series.get(affected)!.issues.add("SKU_HARDWARE_MAPPING_CHANGED");
        }
        if (!evidenceDates.has(observation.evidenceHash)) {
          const record = db.query("SELECT received_at FROM evidence WHERE hash=?").get(observation.evidenceHash) as { received_at: number } | null;
          if (evidenceDates.size >= 64) evidenceDates.delete(evidenceDates.keys().next().value!);
          evidenceDates.set(observation.evidenceHash, record?.received_at ?? null);
        }
        const receipt = evidenceDates.get(observation.evidenceHash)!;
        if (receipt !== null && Number.isSafeInteger(receipt) && receipt > 0 && receipt <= header.collected_at) evidencePresent++; else evidenceMissing++;
        item.observations++; if (item.lastCapture !== cycleId) { item.captures++; item.lastCapture = cycleId; }
        item.distinctTimes ||= observation.observedAt !== item.first.observedAt;
        item.last = point; if (price < item.minimum) item.minimum = price; if (price > item.maximum) item.maximum = price;
        const sourceKey = hash([observation.provider, observation.source]);
        const source = sources.get(sourceKey) ?? { ...coverage(), provider: observation.provider, source: observation.source };
        const model = models.get(observation.model)!;
        for (const entry of [source, model]) { entry.observations++; if (entry.lastCapture !== cycleId) { entry.captures++; entry.lastCapture = cycleId; } }
        source.models.add(observation.model); model.sources.add(sourceKey); sources.set(sourceKey, source); retainedPoints++;
      }
    }
    if (selected < batches.count) { if (selected >= limits.maxCaptures) reasons.add("CAPTURE_LIMIT"); dataScanComplete = false; }
    const resultSeries = [...series.values()].sort((a, b) => a.id.localeCompare(b.id)).map(item => {
      const status = item.issues.size ? "BLOCKED_BY_ANOMALY" : !item.distinctTimes ? "INSUFFICIENT_DISTINCT_OBSERVATIONS" : "DATED_CHANGE_ONLY";
      return { id: item.id, terms: item.terms, captureCount: item.captures, observationCount: item.observations,
        firstKnownAt: item.first.knownAt, lastKnownAt: item.last.knownAt, firstObservedAt: item.first.observedAt, lastObservedAt: item.last.observedAt,
        firstPrice: item.first.price, lastPrice: item.last.price, minimumPrice: fromMicros(item.minimum), maximumPrice: fromMicros(item.maximum),
        issues: [...item.issues].sort(), sensitivity: { status, firstToLastChangeBps: status === "DATED_CHANGE_ONLY" ? studyChangeBps(toMicros(item.first.price), toMicros(item.last.price)) : null,
          elapsedKnowledgeMs: item.last.knownAt - item.first.knownAt, elapsedObservationMs: item.last.observedAt - item.first.observedAt } };
    });
    const observedSpanMs = window.first === null || window.last === null ? 0 : window.last - window.first;
    return { schemaVersion: 2, kind: "RETAINED_CAPTURE_STREAMING_STUDY", privacy: "PRIVATE_RETAINED_DATA", asOf,
      window: { from, to: asOf, captures: window.count, captureBatches: batches.count, firstCaptureAt: window.first, lastCaptureAt: window.last },
      retainedAsOf: { captures: retained.count, firstCaptureAt: retained.first, lastCaptureAt: retained.last }, undatableCaptures: undatable, undatableCaptureBatches: undatableBatches,
      completeness: { complete: reasons.size === 0 && dataScanComplete, dataScanComplete, reasons: [...reasons].sort(), limits,
        capturesSelected: selected, capturesParsed: parsed, observationsExamined: examined, validObservations: valid, retainedPricePoints: retainedPoints, inputBytes },
      cadence: { definition: "COMPLETED_HALF_OPEN_BUCKETS_ANCHORED_AT_WINDOW_START", expectedIntervalMs: interval, complete: cadenceComplete,
        expectedBuckets, occupiedBuckets: cadenceComplete ? occupied : null, emptyBuckets: cadenceComplete ? expectedBuckets - occupied : null,
        gapCount: cadenceComplete ? gapCount : null, gaps, gapSamplesTruncated: reasons.has("GAP_SAMPLE_LIMIT") },
      observations: { firstObservedAt: firstObservationAt, lastObservedAt: lastObservationAt, capturesWithErrors, errorCount,
        evidenceLinks: { retainedAtCapture: evidencePresent, missingAtCapture: evidenceMissing, contentHashesVerified: false } },
      coverage: { sources: [...sources.values()].sort((a, b) => `${a.provider}/${a.source}`.localeCompare(`${b.provider}/${b.source}`)).map(source => ({ provider: source.provider, source: source.source,
        observations: source.observations, captures: source.captures, models: [...source.models].sort() })),
        models: [...models].map(([model, value]) => ({ model, observations: value.observations, captures: value.captures, sources: value.sources.size })) },
      series: resultSeries, anomalies: { counts, samples, samplesTruncated: reasons.has("ANOMALY_SAMPLE_LIMIT") },
      proposedThirtyDayStudy: { targetDays: 30, observedSpanMs, minimumCalendarSpanMet: observedSpanMs >= 30 * DAY,
        continuousCaptureCadenceMet: cadenceComplete && expectedBuckets > 0 && occupied === expectedBuckets, qualification: "NOT_ESTABLISHED" },
      limitations: ["Private descriptive aggregates only. No price publication, synthetic backfill, returns, or benchmark qualification.",
        "No point arrays are retained. Every selected observation is examined within explicit record, input-byte and series budgets.",
        "Capture cadence is not source availability. Repeated quotes are not independent trades; commercial terms remain separate.",
        "Linked evidence receipt is checked, not body authenticity, data rights or provider approval. Cryptographic archive verification is separate."] };
  })();
}
