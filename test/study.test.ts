// Isolated synthetic fixtures only. This suite is not real operating history.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonical } from "../src/crypto";
import { operatingStudy, STUDY_LIMITS, type StudyOptions } from "../src/study";
import { Store } from "../src/store";
import type { Observation } from "../src/types";
import { environment, NOW } from "./helpers";

const stores: Store[] = [], INTERVAL = 300_000, DAY = 86_400_000;
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  return { store, observation: environment().observations[0]! };
}
function quote(observation: Observation, observedAt: number, price = "2", extra: Partial<Observation> = {}): Observation {
  return { ...observation, observedAt, price, instancePrice: String(Number(price) * observation.gpuCount), ...extra };
}
function study(store: Store, options: Partial<StudyOptions> = {}) {
  return operatingStudy(store, { asOf: NOW + INTERVAL * 3, from: NOW, expectedIntervalMs: INTERVAL, ...options });
}

test("empty journals report absent completed cadence buckets without fabricating observations", () => {
  const { store } = fixture(), result = study(store);
  expect(result.completeness.complete).toBe(true); expect(result.window).toMatchObject({ captures: 0, firstCaptureAt: null, lastCaptureAt: null });
  expect(result.cadence).toMatchObject({ expectedBuckets: 3, occupiedBuckets: 0, emptyBuckets: 3, gapCount: 1 });
  expect(result.cadence.gaps).toEqual([{ from: NOW, toExclusive: NOW + INTERVAL * 3, expectedCaptures: 3 }]);
  expect(result.series).toEqual([]); expect(result.coverage.models.every(model => model.observations === 0)).toBe(true);
  expect(result.proposedThirtyDayStudy).toMatchObject({ minimumCalendarSpanMet: false, continuousCaptureCadenceMet: false, qualification: "NOT_ESTABLISHED" });
});

test("retained SKU prices preserve real knowledge dates and exact dated change, not returns", () => {
  const { store, observation } = fixture();
  store.capture([quote(observation, NOW)], [], NOW);
  store.capture([quote(observation, NOW + INTERVAL * 2, "3")], ["test secret error must not appear"], NOW + INTERVAL * 2);
  const result = study(store), series = result.series[0]!;
  expect(result.retainedAsOf).toEqual({ captures: 2, firstCaptureAt: NOW, lastCaptureAt: NOW + INTERVAL * 2 });
  expect(result.cadence.gaps).toEqual([{ from: NOW + INTERVAL, toExclusive: NOW + INTERVAL * 2, expectedCaptures: 1 }]);
  expect(series.points.map(point => [point.knownAt, point.observedAt, point.price])).toEqual([[NOW, NOW, "2.000000"], [NOW + INTERVAL * 2, NOW + INTERVAL * 2, "3.000000"]]);
  expect(series.sensitivity).toEqual({ status: "DATED_CHANGE_ONLY", firstToLastChangeBps: "5000.0000", elapsedKnowledgeMs: INTERVAL * 2, elapsedObservationMs: INTERVAL * 2 });
  expect(series).toMatchObject({ minimumPrice: "2.000000", maximumPrice: "3.000000", captureCount: 2, observationCount: 2 });
  expect(result.observations).toMatchObject({ capturesWithErrors: 1, errorCount: 1, evidenceLinks: { retainedAtCapture: 0, missingAtCapture: 2, contentHashesVerified: false } });
  expect(result.coverage.sources[0]).toMatchObject({ provider: "alpha", source: "alpha-api", observations: 2, captures: 2, models: ["B200"] });
  expect(JSON.stringify(result)).not.toContain("test secret error"); expect(JSON.stringify(result)).not.toContain(observation.sourceUrl);
  expect(result.privacy).toBe("PRIVATE_RETAINED_DATA");
});

test("series never pool providers, sources, regions, procurement, pricing basis or commercial bundles", () => {
  const { store, observation } = fixture();
  const changes: Array<Partial<Observation>> = [{}, { provider: "different-provider" }, { source: "different-source" }, { region: "different-region" },
    { procurement: "SPOT" }, { priceBasis: "EXECUTABLE" }, { tenancy: "FRACTIONAL" }, { priceScope: "ACCOUNT_SPECIFIC" },
    { topology: "HGX" }, { minimumOrderGpuCount: 72 }, { includes: ["network"] }, { sku: "different-sku" }];
  store.capture(changes.map(change => quote(observation, NOW, "2", change)), [], NOW);
  const result = study(store);
  expect(result.series).toHaveLength(changes.length); expect(new Set(result.series.map(series => series.id)).size).toBe(changes.length);
  expect(result.series.every(series => series.sensitivity.firstToLastChangeBps === null)).toBe(true);
  expect(result.series.some(series => series.terms.priceScope === "ACCOUNT_SPECIFIC")).toBe(true);
  expect(result.anomalies.counts).toEqual({});
});

test("future capture receipts cannot backdate their prices into an earlier study", () => {
  const { store, observation } = fixture();
  store.capture([quote(observation, NOW)], [], NOW);
  // This later capture carries an old effective/observed timestamp. It was not known at the cutoff.
  store.capture([quote(observation, NOW, "99")], [], NOW + DAY);
  const early = study(store), later = study(store, { asOf: NOW + DAY });
  expect(early.retainedAsOf.captures).toBe(1); expect(early.series[0]!.points).toHaveLength(1);
  expect(early.series[0]!.lastPrice).toBe("2.000000");
  expect(later.series[0]!.points.at(-1)!.knownAt).toBe(NOW + DAY);
  expect(later.series[0]!.sensitivity.status).toBe("BLOCKED_BY_ANOMALY");
});

test("future observed times are excluded and future effective tariffs cannot yield drift comparisons", () => {
  const { store, observation } = fixture();
  store.capture([quote(observation, NOW + 1), quote(observation, NOW, "2")], [], NOW);
  store.capture([quote(observation, NOW + INTERVAL, "4", { priceEffectiveAt: NOW + DAY })], [], NOW + INTERVAL);
  const result = study(store);
  expect(result.completeness.validObservations).toBe(2); expect(result.anomalies.counts.OBSERVED_AFTER_KNOWLEDGE_TIME).toBe(1);
  expect(result.anomalies.counts.PRICE_NOT_EFFECTIVE_AT_OBSERVATION).toBe(1);
  expect(result.series[0]!.sensitivity.firstToLastChangeBps).toBeNull();
});

test("historical window starts constrain captures, not a tariff's older effective date", () => {
  const { store, observation } = fixture();
  store.capture([quote(observation, NOW)], [], NOW);
  store.capture([quote(observation, NOW + INTERVAL, "3")], [], NOW + INTERVAL);
  const result = study(store, { from: NOW + INTERVAL });
  expect(result.retainedAsOf.captures).toBe(2); expect(result.window.captures).toBe(1);
  expect(result.series[0]!.points).toHaveLength(1); expect(result.series[0]!.firstPrice).toBe("3.000000");
});

test("hardware remapping keeps separate series and blocks all affected drift comparisons", () => {
  const { store, observation } = fixture();
  store.capture([quote(observation, NOW)], [], NOW);
  store.capture([quote(observation, NOW + INTERVAL, "3"), quote(observation, NOW + INTERVAL, "3", { model: "B300" }),
    quote(observation, NOW + INTERVAL, "3", { gpuCount: 16, instancePrice: "48" })], [], NOW + INTERVAL);
  const result = study(store);
  expect(result.series).toHaveLength(3); expect(result.anomalies.counts.SKU_HARDWARE_MAPPING_CHANGED).toBe(2);
  expect(result.series.every(series => series.issues.includes("SKU_HARDWARE_MAPPING_CHANGED"))).toBe(true);
  expect(result.series.every(series => series.sensitivity.status === "BLOCKED_BY_ANOMALY")).toBe(true);
});

test("repeated observation timestamps cannot masquerade as independent drift history", () => {
  const { store, observation } = fixture();
  store.capture([quote(observation, NOW)], [], NOW);
  store.capture([quote(observation, NOW)], [], NOW + INTERVAL);
  expect(study(store).series[0]!.sensitivity.status).toBe("INSUFFICIENT_DISTINCT_OBSERVATIONS");
  store.capture([quote(observation, NOW - 1, "3")], [], NOW + INTERVAL * 2);
  expect(study(store).anomalies.counts.OBSERVATION_TIME_REGRESSION).toBe(1);
  expect(study(store).series[0]!.sensitivity.status).toBe("BLOCKED_BY_ANOMALY");
});

test("evidence linked only after a capture is not counted as available at that capture", async () => {
  const { store, observation } = fixture(), body = Buffer.from("isolated evidence bytes");
  const evidenceHash = createHash("sha256").update(body).digest("hex");
  store.capture([quote(observation, NOW, "2", { evidenceHash })], [], NOW);
  await store.archive({ hash: evidenceHash, source: "alpha-api", url: observation.sourceUrl, receivedAt: NOW + 1, contentType: "text/plain", body });
  store.capture([quote(observation, NOW + INTERVAL, "3", { evidenceHash })], [], NOW + INTERVAL);
  const result = study(store);
  expect(result.series[0]!.points.map(point => point.evidenceRetainedAtCapture)).toEqual([false, true]);
  expect(result.observations.evidenceLinks).toEqual({ retainedAtCapture: 1, missingAtCapture: 1, contentHashesVerified: false });
});

test("corrupt schemas, decimals, JSON and error shapes are summarized without copying their contents", () => {
  const { store, observation } = fixture();
  store.capture([quote(observation, NOW, "2")], [], NOW);
  store.db.query("UPDATE captures SET observations=?,errors=? WHERE id=1").run(canonical([{ ...observation, price: "SECRET-invalid-price" }, { ...observation, instancePrice: "99" }]), "{}");
  store.db.query("INSERT INTO captures(collected_at,observations,errors) VALUES(?,?,?)").run(NOW + 1, "PRIVATE-invalid-json", "[]");
  store.db.query("INSERT INTO captures(collected_at,observations,errors) VALUES(?,?,?)").run(NOW + 2, "{}", "[]");
  const result = study(store);
  expect(result.anomalies.counts).toEqual({ INVALID_CAPTURE_ERRORS: 1, OBSERVATION_SCHEMA_INVALID: 2, INVALID_CAPTURE_JSON: 1, OBSERVATIONS_NOT_ARRAY: 1 });
  expect(result.series).toEqual([]); expect(JSON.stringify(result)).not.toContain("SECRET"); expect(JSON.stringify(result)).not.toContain("PRIVATE-invalid-json");
});

test("capture limits never turn unexamined rows into asserted cadence gaps", () => {
  const { store, observation } = fixture();
  for (let i = 0; i < 3; i++) store.capture([quote(observation, NOW + INTERVAL * i)], [], NOW + INTERVAL * i);
  const result = study(store, { maxCaptures: 1 });
  expect(result.window.captures).toBe(3); expect(result.completeness).toMatchObject({ complete: false, dataScanComplete: false, reasons: ["CAPTURE_LIMIT"], capturesSelected: 1 });
  expect(result.cadence).toMatchObject({ complete: false, emptyBuckets: null, gapCount: null, gaps: [] });
});

test("observation, series and aggregate input-byte limits explicitly mark partial results", () => {
  const { store, observation } = fixture();
  store.capture([quote(observation, NOW), quote(observation, NOW, "3", { sku: "second-sku" })], [], NOW);
  const observationLimited = study(store, { maxObservations: 1 });
  expect(observationLimited.completeness).toMatchObject({ complete: false, dataScanComplete: false, reasons: ["OBSERVATION_LIMIT"], retainedPricePoints: 1 });
  const seriesLimited = study(store, { maxSeries: 1 });
  expect(seriesLimited.completeness).toMatchObject({ complete: false, dataScanComplete: false, reasons: ["SERIES_LIMIT"], validObservations: 2, retainedPricePoints: 1 });
  const byteLimited = study(store, { maxInputBytes: 1 });
  expect(byteLimited.completeness).toMatchObject({ complete: false, dataScanComplete: false, reasons: ["INPUT_BYTE_LIMIT"], inputBytes: 0, retainedPricePoints: 0 });
});

test("oversized rows are not decoded and later bounded records remain analyzable", () => {
  const { store, observation } = fixture();
  store.db.query("INSERT INTO captures(collected_at,observations,errors) VALUES(?,?,?)").run(NOW, "[]", JSON.stringify(["x".repeat(STUDY_LIMITS.maxRowBytes)]));
  store.capture([quote(observation, NOW + INTERVAL)], [], NOW + INTERVAL);
  const result = study(store);
  expect(result.completeness).toMatchObject({ complete: false, dataScanComplete: false, reasons: ["CAPTURE_BYTE_LIMIT"], capturesParsed: 1, retainedPricePoints: 1 });
});

test("bounded anomaly and gap samples disclose clipping while retaining exact aggregate counts", () => {
  const { store } = fixture();
  for (let i = 0; i < 3; i++) store.db.query("INSERT INTO captures(collected_at,observations,errors) VALUES(?,?,?)").run(NOW + INTERVAL * i * 2, "[{}]", "[]");
  const result = study(store, { asOf: NOW + INTERVAL * 6, maxAnomalySamples: 1, maxGapSamples: 1 });
  expect(result.completeness).toMatchObject({ complete: false, dataScanComplete: true, reasons: ["ANOMALY_SAMPLE_LIMIT", "GAP_SAMPLE_LIMIT"] });
  expect(result.anomalies.counts.OBSERVATION_SCHEMA_INVALID).toBe(3); expect(result.anomalies.samples).toHaveLength(1); expect(result.anomalies.samplesTruncated).toBe(true);
  expect(result.cadence).toMatchObject({ emptyBuckets: 3, gapCount: 3, gapSamplesTruncated: true }); expect(result.cadence.gaps).toHaveLength(1);
});

test("calendar span and frequent duplicate captures cannot qualify a thirty-day operating study", () => {
  const { store, observation } = fixture();
  for (let i = 0; i < 20; i++) store.capture([quote(observation, NOW)], [], NOW);
  store.capture([quote(observation, NOW + 30 * DAY)], [], NOW + 30 * DAY);
  const result = study(store, { asOf: NOW + 30 * DAY });
  expect(result.proposedThirtyDayStudy).toMatchObject({ minimumCalendarSpanMet: true, continuousCaptureCadenceMet: false, qualification: "NOT_ESTABLISHED" });
  expect(result.cadence.occupiedBuckets).toBe(1); expect(result.cadence.emptyBuckets).toBe(8639);
});

test("dated declines use fixed precision and the study accepts a read-only SQL driver", () => {
  const { store, observation } = fixture();
  store.capture([quote(observation, NOW, "3")], [], NOW);
  store.capture([quote(observation, NOW + INTERVAL, "2")], [], NOW + INTERVAL);
  const before = store.counts(); store.db.exec("PRAGMA query_only=ON");
  const result = operatingStudy(store.db, { expectedIntervalMs: INTERVAL, asOf: NOW + INTERVAL * 2 });
  expect(result.series[0]!.sensitivity.firstToLastChangeBps).toBe("-3333.3333"); expect(store.counts()).toEqual(before);
  expect(result.window.from).toBe(NOW);
});

test("invalid times and unbounded options are rejected before studying records", () => {
  const { store } = fixture();
  for (const options of [{ asOf: 0 }, { from: NOW + DAY }, { expectedIntervalMs: 0 }, { maxCaptures: STUDY_LIMITS.maxCaptures + 1 },
    { maxObservations: 0 }, { maxInputBytes: Infinity }, { maxSeries: -1 }, { maxGapSamples: 1.5 }]) expect(() => study(store, options)).toThrow();
});

test("captures with unusable timestamps are disclosed rather than silently assigned to history", () => {
  const { store, observation } = fixture();
  store.capture([quote(observation, NOW)], [], NOW);
  for (const invalid of [0, "not-a-time"]) store.db.query("INSERT INTO captures(collected_at,observations,errors) VALUES(?,?,?)").run(invalid, "[]", "[]");
  const result = study(store);
  expect(result.undatableCaptures).toBe(2); expect(result.window.captures).toBe(1);
  expect(result.completeness).toMatchObject({ complete: false, dataScanComplete: false, reasons: ["UNDATABLE_CAPTURE_ROWS"] });
  expect(result.series[0]!.points[0]!.observationLagMs).toBe(0);
});
