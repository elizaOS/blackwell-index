// Synthetic stress fixtures stay in tests and never enter a real journal.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { signBatch } from "../src/crypto";
import { qualifyModel } from "../src/qualification";
import { positionStress, shadowStudy } from "../src/shadow";
import { environment, NOW } from "./helpers";

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sbx-shadow-")); directories.push(directory);
  const store = new Store(join(directory, "node.sqlite"));
  const env = environment();
  const observations = env.observations.filter(value => value.model === "B200").map(value => ({ ...value, observedAt: NOW }));
  return { ...env, store, observations };
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("individual model readiness does not bypass the composite or external launch gates", () => {
  const { identities, registry, methodology, observations } = environment();
  const batches = identities.map(identity => signBatch({ schemaVersion: 1, network: registry.network, nodeId: identity.nodeId,
    publicKey: identity.publicKey, sequence: 1, createdAt: NOW, observations: observations.filter(value => value.model === "B200") }, identity));
  const report = qualifyModel(batches, registry, methodology, "B200", NOW);
  expect(report.calculationReady).toBe(true); expect(report.currentSnapshotPublishable).toBe(false);
  expect(report.blockers).toEqual(["CURRENT_COMPOSITE_PUBLICATION_GATE_NOT_MET"]);
  expect(report.liveMarketQualified).toBe(false);
  expect(report.groups.every(value => value.rightsConfigured && value.matchedReportsReady)).toBe(true);
  const expired = qualifyModel(batches, registry, methodology, "B200", NOW + methodology.maxAgeMs + 1);
  expect(expired.calculationReady).toBe(false);
});

test("rights, fixed group membership and admitted operator quorum are diagnosed independently", () => {
  const { batches, registry, methodology } = environment();
  registry.providers[0]!.rights.derive = false;
  registry.operators[0]!.enabled = false;
  methodology.status = "DRAFT";
  const report = qualifyModel(batches, registry, methodology, "B200", NOW);
  expect(report.blockers).toContain("CONSTITUENT_RIGHTS_NOT_CONFIGURED");
  expect(report.blockers).toContain("INSUFFICIENT_ADMITTED_OPERATOR_GROUPS");
  expect(report.blockers).toContain("METHODOLOGY_NOT_APPROVED");
  expect(report.calculationReady).toBe(false);
});

test("known operator quarantine is retained in shadow production diagnostics", () => {
  const { store, registry, methodology, batches } = fixture();
  try {
    for (const batch of batches) store.accept(batch, NOW, true);
    expect(shadowStudy(store.db, registry, methodology, { asOf: NOW, expectedIntervalMs: 300_000 }).qualification!.calculationReady).toBe(true);
    store.db.query("INSERT INTO equivocations(node_id,detected_at,conflicting_payload) VALUES(?,?,?)").run(batches[0]!.payload.nodeId, NOW + 1, "{}");
    expect(shadowStudy(store.db, registry, methodology, { asOf: NOW, expectedIntervalMs: 300_000 }).qualification!.calculationReady).toBe(true);
    const report = shadowStudy(store.db, registry, methodology, { asOf: NOW + 1, expectedIntervalMs: 300_000 });
    expect(report.qualification!.calculationReady).toBe(false); expect(report.qualification!.acceptedBatchHashes).toHaveLength(2);
  } finally { store.close(); }
});

test("long and short cash PnL, signed funding and conservative maintenance are exact", () => {
  const input = { quantityGpuHours: 100, entryPrice: "10", indexPrice: "8", collateralUsd: "500", markPremiumBps: 0,
    maintenanceMarginBps: 1000, fundingBpsPerDay: 10, elapsedMs: 86_400_000 };
  expect(positionStress({ ...input, side: "LONG" })).toMatchObject({ markPrice: "8.000000", pnlUsd: "-200.000000", fundingCostUsd: "1.000000",
    equityUsd: "299.000000", maintenanceUsd: "80.000000", maintenanceBreached: false, executed: false });
  expect(positionStress({ ...input, side: "SHORT" })).toMatchObject({ pnlUsd: "200.000000", fundingCostUsd: "-1.000000", equityUsd: "701.000000" });
  expect(positionStress({ ...input, side: "LONG", indexPrice: "4" })).toMatchObject({ negativeEquity: true, maintenanceBreached: true });
  expect(positionStress({ ...input, side: "SHORT", markPremiumBps: 2500 })).toMatchObject({ markPrice: "10.000000", pnlUsd: "0.000000" });
  expect(() => positionStress({ ...input, side: "LONG", quantityGpuHours: 0.5 })).toThrow();
  expect(() => positionStress({ ...input, side: "LONG", markPremiumBps: -10000 })).toThrow();
});

test("fixed panel gaps never become accidental reweighting, synthetic inputs remain separate and replay is deterministic", () => {
  const { store, registry, methodology, observations } = fixture();
  try {
    store.capture(observations, [], NOW);
    store.capture(observations.filter(value => value.provider !== "gamma").map(value => ({ ...value, observedAt: NOW + 300_000 })), [], NOW + 300_000);
    const before = store.db.query("SELECT * FROM captures ORDER BY id").all();
    const options = { asOf: NOW + 600_000, expectedIntervalMs: 300_000 };
    const report = shadowStudy(store.db, registry, methodology, options);
    expect(shadowStudy(store.db, registry, methodology, options)).toEqual(report);
    expect(report.timeline[0]!.price).toBe("3.250000");
    expect(report.current.price).toBeNull(); expect(report.current.missingGroups).toEqual(["gamma"]);
    const removal = report.scenarios.find(value => value.name === "REMOVE_GROUP:gamma")!;
    expect(removal.result.price).toBeNull(); expect(removal.positions).toEqual([]); expect(removal.accidentalReweightPrice).toBe("2.500000");
    expect(report.scenarios.every(value => value.inputKind === "HYPOTHETICAL_OVERLAY")).toBe(true);
    expect(report.scenarios.find(value => value.name === "ALL_SOURCES_EXPIRED")!.result.price).toBeNull();
    expect(store.db.query("SELECT * FROM captures ORDER BY id").all()).toEqual(before);
    expect(report.publishable).toBe(false); expect(report.liveMarketQualified).toBe(false);
  } finally { store.close(); }
});

test("freeze a draft research panel; new providers cannot alter weights and source loss is a gap", () => {
  const { store, registry, methodology, observations } = fixture();
  methodology.status = "DRAFT"; methodology.providerWeights.B200 = {};
  try {
    store.capture(observations.slice(0, 2), [], NOW);
    store.capture(observations.map(value => ({ ...value, observedAt: NOW + 300_000 })), [], NOW + 300_000);
    const report = shadowStudy(store.db, registry, methodology, { asOf: NOW + 300_000, expectedIntervalMs: 300_000 });
    expect(report.panel.weights).toEqual({ alpha: 1, beta: 1 });
    expect(report.timeline.map(value => value.price)).toEqual(["2.500000", "2.500000"]);
    expect(report.qualification!.blockers).toContain("INSUFFICIENT_FIXED_PROVIDER_GROUPS");
  } finally { store.close(); }
});

test("empty captures and stale last observations remain unavailable without future knowledge", () => {
  const { store, registry, methodology, observations } = fixture();
  try {
    store.capture(observations, [], NOW);
    store.capture(observations.map(value => ({ ...value, observedAt: NOW + methodology.maxAgeMs + 5000 })), [], NOW + methodology.maxAgeMs + 5000);
    const report = shadowStudy(store.db, registry, methodology, { asOf: NOW + methodology.maxAgeMs + 2, expectedIntervalMs: 300_000 });
    expect(report.window.captures).toBe(1); expect(report.current.price).toBeNull();
    expect(report.timeline.at(-1)!.at).toBe(NOW + methodology.maxAgeMs + 1);
    expect(report.timeline.at(-1)!.price).toBeNull();
    store.capture([], ["failed"], NOW + 100);
    expect(shadowStudy(store.db, registry, methodology, { asOf: NOW + 100, expectedIntervalMs: 300_000 }).current.price).toBeNull();
  } finally { store.close(); }
});

test("spot and account-specific quotes cannot contaminate the public on-demand research curve", () => {
  const { store, registry, methodology, observations } = fixture();
  try {
    store.capture([...observations, ...observations.map(value => ({ ...value, procurement: "SPOT" as const, price: "999", instancePrice: "7992" })),
      ...observations.map(value => ({ ...value, priceScope: "ACCOUNT_SPECIFIC" as const, price: "888", instancePrice: "7104" }))], [], NOW);
    expect(shadowStudy(store.db, registry, methodology, { asOf: NOW, expectedIntervalMs: 300_000 }).current.price).toBe("3.250000");
  } finally { store.close(); }
});

test("truncation, corrupt signed reports and conflicting duplicate observations fail closed", () => {
  const { store, registry, methodology, observations, batches } = fixture();
  try {
    store.capture(observations, [], NOW); store.capture(observations, [], NOW + 1);
    expect(shadowStudy(store.db, registry, methodology, { asOf: NOW + 1, expectedIntervalMs: 300_000, maxCaptures: 1 }).current.price).toBeNull();
    store.accept(batches[0]!, NOW, true);
    store.db.query("UPDATE reports SET payload='{}'").run();
    const corrupt = shadowStudy(store.db, registry, methodology, { asOf: NOW + 1, expectedIntervalMs: 300_000 });
    expect(corrupt.qualification).toBeNull(); expect(corrupt.completeness.complete).toBe(false);
    store.capture([{ ...observations[0]!, price: "100", instancePrice: "800" }], [], NOW);
    const conflict = shadowStudy(store.db, registry, methodology, { asOf: NOW + 1, expectedIntervalMs: 300_000 });
    expect(conflict.current.price).toBeNull(); expect(conflict.completeness.conflictingPoints).toBe(1);
  } finally { store.close(); }
});

test("dispersion blocks stressed prints and decimal boundaries are explicit instead of crashing the study", () => {
  const { store, registry, methodology, observations } = fixture();
  try {
    methodology.maxProviderDispersionBps = 5000;
    store.capture(observations.map(value => ({ ...value, price: "0.000001", instancePrice: "0.000008" })), [], NOW);
    const tiny = shadowStudy(store.db, registry, methodology, { asOf: NOW, expectedIntervalMs: 300_000 });
    expect(tiny.current.price).toBe("0.000001"); expect(tiny.scenarios.length).toBeGreaterThan(0);
    const outlier = tiny.scenarios.find(value => value.name === "GROUP_PRICE_UP_50_PERCENT:alpha")!;
    expect(outlier.result.reasons).toContain("EXCESSIVE_PROVIDER_DISPERSION"); expect(outlier.positions).toEqual([]);
    store.capture(observations.map(value => ({ ...value, observedAt: NOW + 1, price: "10000000000", instancePrice: "80000000000" })), [], NOW + 1);
    const huge = shadowStudy(store.db, registry, methodology, { asOf: NOW + 1, expectedIntervalMs: 300_000 });
    expect(huge.current.price).toBe("10000000000.000000"); expect(huge.stressUnavailableReason).toBe("SCENARIO_EXCEEDS_DECIMAL_RANGE");
    expect(huge.scenarios).toEqual([]);
  } finally { store.close(); }
});
