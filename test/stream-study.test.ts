// Isolated synthetic capacity fixtures, never provider observations or production operating history.
import { afterEach, expect, test } from "bun:test";
import { Store } from "../src/store";
import { ChunkedJournal } from "../src/chunked-journal";
import { streamingStudy } from "../src/stream-study";
import { operatingStudy } from "../src/study";
import { NOW, environment } from "./helpers";
import type { Observation } from "../src/types";

const stores: Store[] = [], INTERVAL = 300_000;
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() { const store = new Store(":memory:"); stores.push(store); return { store, observation: environment().observations[0]! }; }
function quote(observation: Observation, at: number, price = "2", extra: Partial<Observation> = {}) {
  return { ...observation, observedAt: at, price, instancePrice: String(Number(price) * observation.gpuCount), ...extra };
}
const options = { from: NOW, asOf: NOW + 4 * INTERVAL, expectedIntervalMs: INTERVAL };

test("streaming aggregates match bounded point-study results without retaining points", () => {
  const { store, observation } = fixture();
  for (const i of [0, 2, 3]) store.capture([quote(observation, NOW + i * INTERVAL, String(2 + i)),
    quote(observation, NOW + i * INTERVAL, "4", { sku: "second" })], i === 2 ? ["PRIVATE-error"] : [], NOW + i * INTERVAL);
  const expected = operatingStudy(store, options), actual = streamingStudy(store, options);
  expect(actual.series).toEqual(expected.series.map(({ points, ...summary }) => summary));
  expect(actual.coverage).toEqual(expected.coverage); expect(actual.cadence).toEqual(expected.cadence);
  expect(actual.observations).toEqual(expected.observations);
  expect(actual.completeness.complete).toBe(true); expect(JSON.stringify(actual)).not.toContain("PRIVATE-error");
  expect(actual.proposedThirtyDayStudy.qualification).toBe("NOT_ESTABLISHED");
});

test("chunked batches count as one capture cycle with unambiguous markers", () => {
  const { store, observation } = fixture(), journal = new ChunkedJournal(store.db);
  // Two physical batches at one collection timestamp, as stored by the hosted journal.
  journal.capture([quote(observation, NOW)], [], NOW);
  store.db.query("INSERT INTO captures(collected_at,observations,errors) VALUES(?,?,?)").run(NOW, JSON.stringify([quote(observation, NOW, "2", { sku: "second" })]), "[]");
  const report = streamingStudy(store, options);
  expect(report.window).toMatchObject({ captures: 1, captureBatches: 2 });
  expect(report.coverage.sources[0]).toMatchObject({ observations: 2, captures: 1 });
  expect(report.completeness.complete).toBe(true);
  store.db.query("INSERT INTO collection_captures(collected_at) VALUES(?)").run(NOW);
  expect(streamingStudy(store, options).completeness.reasons).toContain("AMBIGUOUS_CAPTURE_CYCLE_MAPPING");
});

test("dated cycle-mapping problems outside a historical study window do not change its results", () => {
  const { store, observation } = fixture(), journal = new ChunkedJournal(store.db);
  journal.capture([quote(observation, NOW)], [], NOW);
  const original = streamingStudy(store, options), future = options.asOf + INTERVAL, before = NOW - INTERVAL;
  // Future orphan batch, future missing marker, duplicated marker before the
  // selected window: these matter to their own periods, never as-of inference.
  store.db.query("INSERT INTO captures(collected_at,observations,errors) VALUES(?,?,?)").run(future, "[]", "[]");
  store.db.query("INSERT INTO collection_captures(collected_at) VALUES(?)").run(future + INTERVAL);
  journal.capture([], [], before);
  store.db.query("INSERT INTO collection_captures(collected_at) VALUES(?)").run(before);
  const changed = streamingStudy(store, options);
  expect(changed.window).toEqual(original.window);
  expect(changed.completeness).toEqual(original.completeness);
  expect(changed.cadence).toEqual(original.cadence);
  expect(changed.series).toEqual(original.series);
  expect(streamingStudy(store, { ...options, asOf: future + INTERVAL }).completeness.reasons).toContain("AMBIGUOUS_CAPTURE_CYCLE_MAPPING");
  expect(streamingStudy(store, { ...options, from: before }).completeness.reasons).toContain("AMBIGUOUS_CAPTURE_CYCLE_MAPPING");
});

test("split batches deduplicate cycle coverage for interleaved series, models, sources and errors", () => {
  const { store, observation } = fixture(), journal = new ChunkedJournal(store.db);
  const second = { ...observation, provider: "beta", source: "beta-api", sourceUrl: "https://beta.example/prices" };
  for (let i = 0; i < 2; i++) {
    const at = NOW + i * INTERVAL;
    journal.capture([quote(observation, at), quote(second, at, "2", { model: "B300" })], ["PRIVATE split error"], at);
    for (let j = 0; j < 2; j++) store.db.query("INSERT INTO captures(collected_at,observations,errors) VALUES(?,?,?)").run(at,
      JSON.stringify([quote(second, at, "2", { model: "B300" }), quote(observation, at)]), '["PRIVATE repeated error"]');
  }
  const report = streamingStudy(store, options);
  expect(report.window).toMatchObject({ captures: 2, captureBatches: 6 });
  expect(report.observations).toMatchObject({ capturesWithErrors: 2, errorCount: 6 });
  expect(report.coverage.sources.every(source => source.captures === 2 && source.observations === 6)).toBe(true);
  expect(report.coverage.models.filter(model => model.observations).every(model => model.captures === 2 && model.observations === 6)).toBe(true);
  expect(report.series.every(series => series.captureCount === 2 && series.observationCount === 6)).toBe(true);
  expect(report.completeness).toMatchObject({ complete: true, capturesSelected: 6, observationsExamined: 12 });
  expect(JSON.stringify(report)).not.toContain("PRIVATE split error");
  expect(JSON.stringify(report)).not.toContain("PRIVATE repeated error");
});

test("undatable physical batches and invalid first-page IDs cannot disappear from study completeness", () => {
  const { store, observation } = fixture(), journal = new ChunkedJournal(store.db);
  journal.capture([quote(observation, NOW)], [], NOW);
  store.db.query("INSERT INTO captures(collected_at,observations,errors) VALUES(?,?,?)").run("invalid-time", "[]", "[]");
  const undated = streamingStudy(store, options);
  expect(undated.undatableCaptureBatches).toBe(1); expect(undated.undatableCaptures).toBe(0);
  expect(undated.completeness).toMatchObject({ complete: false, dataScanComplete: false });
  expect(undated.completeness.reasons).toContain("UNDATABLE_CAPTURE_ROWS"); expect(undated.cadence.complete).toBe(false);
  store.db.query("DELETE FROM captures WHERE typeof(collected_at)!='integer'").run();
  store.db.query("UPDATE captures SET id=0 WHERE id=1").run();
  const invalidId = streamingStudy(store, options);
  expect(invalidId.anomalies.counts.INVALID_CAPTURE_ID).toBe(1);
  expect(invalidId.completeness).toMatchObject({ complete: false, dataScanComplete: false, capturesSelected: 1 });
});

test("limits and malformed rows remain explicit, and unfinished scans cannot imply cadence", () => {
  const { store, observation } = fixture();
  for (let i = 0; i < 3; i++) store.capture([quote(observation, NOW + i * INTERVAL)], [], NOW + i * INTERVAL);
  const partial = streamingStudy(store, { ...options, maxCaptures: 1 });
  expect(partial.completeness).toMatchObject({ complete: false, dataScanComplete: false });
  expect(partial.completeness.reasons).toContain("CAPTURE_LIMIT"); expect(partial.cadence.emptyBuckets).toBeNull();
  expect(streamingStudy(store, { ...options, maxObservations: 1 }).completeness.reasons).toContain("OBSERVATION_LIMIT");
  expect(streamingStudy(store, { ...options, maxInputBytes: 1 }).completeness.reasons).toContain("INPUT_BYTE_LIMIT");
  store.db.query("UPDATE captures SET observations=? WHERE id=2").run("SECRET-invalid-json");
  const corrupt = streamingStudy(store, options);
  expect(corrupt.anomalies.counts.INVALID_CAPTURE_JSON).toBe(1); expect(JSON.stringify(corrupt)).not.toContain("SECRET-invalid-json");
});

test("remapped hardware, future knowledge and repeated timestamps cannot create valid sensitivities", () => {
  const { store, observation } = fixture();
  store.capture([quote(observation, NOW), quote(observation, NOW + 1)], [], NOW);
  store.capture([quote(observation, NOW, "3"), quote(observation, NOW + INTERVAL, "3", { model: "B300" })], [], NOW + INTERVAL);
  store.capture([quote(observation, NOW, "99")], [], NOW + INTERVAL * 10);
  const report = streamingStudy(store, options);
  expect(report.window.captures).toBe(2); expect(report.anomalies.counts.OBSERVED_AFTER_KNOWLEDGE_TIME).toBe(1);
  expect(report.anomalies.counts.CONFLICTING_PRICE_AT_SAME_OBSERVED_TIME).toBe(1);
  expect(report.series.every(series => series.sensitivity.status === "BLOCKED_BY_ANOMALY")).toBe(true);
});

test("streaming study exceeds the old 100000-observation ceiling without retaining point arrays", () => {
  // The full on-disk 31-day build/export/inspect/restore/study drill is separate
  // in scripts/verify-stream-capacity.ts with fresh-process memory measurement.
  const { store, observation } = fixture(), cycles = 1600, width = 64;
  store.db.transaction(() => {
    for (let i = 0; i < cycles; i++) store.capture(Array.from({ length: width }, (_, j) => quote(observation, NOW + i * INTERVAL, "2", { sku: `capacity-${j}` })), [], NOW + i * INTERVAL);
  })();
  store.db.exec("PRAGMA query_only=ON");
  const report = streamingStudy(store.db, { from: NOW, asOf: NOW + (cycles - 1) * INTERVAL, expectedIntervalMs: INTERVAL });
  expect(report.completeness).toMatchObject({ complete: true, observationsExamined: 102400, retainedPricePoints: 102400 });
  expect(report.series).toHaveLength(width); expect(report.series.every(series => !Object.hasOwn(series, "points"))).toBe(true);
  expect(report.series[0]!.observationCount).toBe(cycles);
  expect(report.proposedThirtyDayStudy).toMatchObject({ minimumCalendarSpanMet: false, continuousCaptureCadenceMet: true, qualification: "NOT_ESTABLISHED" });
  expect(report.cadence.emptyBuckets).toBe(0);
}, 180_000);
