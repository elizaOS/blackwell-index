/**
 * Isolated synthetic capacity acceptance. Never contacts providers, hosts, Pyth
 * or production databases. The default spans 31 days, not operating evidence.
 * Every expensive phase runs in a fresh process with OS-reported peak RSS.
 */
import "./capacity-offline-preload";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { archiveDescriptorHash, type ArchiveDescriptor } from "../src/archive-protocol";
import { beginCheckpoint, initializeCheckpointStorage, readCheckpointBlock, releaseCheckpoint, sealCheckpoint, type CheckpointMetadata } from "../src/checkpoint";
import { ChunkedJournal } from "../src/chunked-journal";
import { canonical, hash, signBatch } from "../src/crypto";
import { calculate } from "../src/engine";
import type { SqlDriver } from "../src/journal";
import { backupLocalStreamNode } from "../src/local-backup";
import { createRecoveryKey, RECOVERY_MARKER } from "../src/recovery";
import { backupStreamFrames, inspectStreamBackup, restoreStreamNode } from "../src/stream-recovery";
import { streamingStudy } from "../src/stream-study";
import type { NodeIdentity, Observation, SignedBatch, Snapshot } from "../src/types";
import { parseMethodology, parseRegistry } from "../src/validation";
import { environment, NOW } from "../test/helpers";

const KIND = "SBX_SYNTHETIC_STREAM_CAPACITY_ONLY", INTERVAL = 300_000, FULL_CYCLES = 8929, WIDTH = 64;
const SYNTHETIC_QUOTES = environment().observations;
const PHASES = ["build", "export", "inspect", "restore", "study", "local-backup", "local-restore"] as const;
type Phase = (typeof PHASES)[number];
interface Manifest { kind: typeof KIND; cycles: number; width: number; firstAt: number; lastAt: number; identities: NodeIdentity[]; metadata: CheckpointMetadata }
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`CAPACITY_${message}`); }
function json(path: string): unknown { check(lstatSync(path).isFile() && statSync(path).size < 128 * 1024, "MANIFEST_LIMIT"); return JSON.parse(readFileSync(path, "utf8")); }
function privateJson(path: string, value: unknown): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, canonical(value)); fsyncSync(fd); } finally { closeSync(fd); }
}
function manifest(directory: string): Manifest {
  const value = json(join(directory, "fixture-private.json")) as Manifest;
  check(value.kind === KIND && Number.isSafeInteger(value.cycles) && value.cycles > 0 && value.cycles <= FULL_CYCLES && value.width === WIDTH, "FIXTURE_MARKER_REQUIRED");
  check(lstatSync(directory).isDirectory() && (statSync(directory).mode & 0o077) === 0, "PRIVATE_DIRECTORY_REQUIRED");
  return value;
}
function openJournal(path: string) {
  const database = new Database(path, { create: true, strict: true }); chmodSync(path, 0o600);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-4096; PRAGMA mmap_size=0");
  return { database, journal: new ChunkedJournal(database as unknown as SqlDriver) };
}
function checkpointOptions(m: Manifest) { return { expectedNodeId: m.identities[0]!.nodeId, expectedRelease: m.metadata.release }; }
async function addCycle(journal: ChunkedJournal, m: Manifest, index: number, at: number) {
  const base = SYNTHETIC_QUOTES.map(observation => ({ ...observation, observedAt: at, expiresAt: null }));
  // Unique, real-shaped response bodies include a changing cycle and all quoted
  // models. Periodic >512KiB bodies force record fragmentation and chunk recovery.
  const padding = index % 256 === 0 ? 512 * 1024 + 37 : 16 * 1024;
  const body = Buffer.from(canonical({ fixture: KIND, cycle: index, collectedAt: at, quotes: base, padding: "x".repeat(padding) }));
  const evidenceHash = createHash("sha256").update(body).digest("hex");
  await journal.archive({ hash: evidenceHash, source: "capacity-fixture", url: "https://alpha.example/capacity-fixture-only", receivedAt: at,
    contentType: "application/json", body });
  const captures: Observation[] = Array.from({ length: WIDTH }, (_, i) => ({ ...base[i % base.length]!, sku: `capacity-sku-${i}`, evidenceHash }));
  // Twelve provider/model quotes per signer, plus 64 retained raw quotes per
  // collection cycle. This fixture states both widths instead of equating them.
  const signedObservations = base.map(observation => ({ ...observation, evidenceHash }));
  journal.db.transaction(() => {
    journal.capture(captures, [], at);
    const batches = m.identities.map(identity => signBatch({ schemaVersion: 1, network: m.metadata.network, nodeId: identity.nodeId,
      publicKey: identity.publicKey, sequence: journal.nextSequence(identity.nodeId), createdAt: at, observations: signedObservations }, identity));
    for (const batch of batches) check(journal.accept(batch, at, true) === "ACCEPTED", "FIXTURE_REPORT_REJECTED");
    const snapshot = calculate(batches, m.metadata.registry, m.metadata.methodology, at);
    check(snapshot.publishable, "FIXTURE_SNAPSHOT_NOT_READY"); journal.snapshot(snapshot);
  })();
}
function sourceCounters(journal: ChunkedJournal) { return journal.db.query("SELECT id,value FROM counters ORDER BY id").all(); }
async function phaseRun(phase: Phase, directory: string) {
  const m = manifest(directory), databasePath = join(directory, "source.sqlite"), keyPath = join(directory, "recovery.key"), archivePath = join(directory, "archive.sbx-stream");
  const options = checkpointOptions(m);
  if (phase === "build") {
    check(!existsSync(databasePath), "BUILD_OUTPUT_EXISTS"); createRecoveryKey(keyPath);
    const { database, journal } = openJournal(databasePath);
    try {
      journal.saveConfiguration(m.metadata.registry); journal.saveConfiguration(m.metadata.methodology);
      for (let i = 0; i < m.cycles; i++) {
        await addCycle(journal, m, i, NOW + i * INTERVAL);
        if (i && i % 1000 === 0) { process.stdout.write(`${JSON.stringify({ progress: phase, cycles: i })}\n`); await setImmediate(); }
      }
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      return { counts: journal.counts(), databaseBytes: statSync(databasePath).size, evidenceBytes: (database.query("SELECT SUM(bytes) AS bytes FROM evidence_sizes").get() as { bytes: number }).bytes,
        cycles: m.cycles, capturedObservations: m.cycles * WIDTH, signedOperators: m.identities.length, signedObservationsPerReport: 12 };
    } finally { database.close(); }
  }
  if (phase === "export") {
    const { database, journal } = openJournal(databasePath), createdAt = m.lastAt + 1000;
    try {
      const before = sourceCounters(journal), migrationStart = performance.now(); initializeCheckpointStorage(journal);
      const migrationMs = performance.now() - migrationStart, beginStart = performance.now();
      const descriptor = beginCheckpoint(journal, m.identities[0]!, m.metadata, { now: createdAt });
      const beginMs = performance.now() - beginStart; check(canonical(sourceCounters(journal)) === canonical(before), "EXPORT_INCREMENTED_COUNTER");
      privateJson(join(directory, "descriptor.json"), descriptor);
      let blocks = 0, retryChecks = 0;
      async function* source() {
        yield Buffer.from(canonical(descriptor));
        // A complete new collection after begin must not leak into the immutable
        // checkpoint or change its frozen counters/snapshot head.
        await addCycle(journal, m, m.cycles, createdAt + 1);
        for (;;) {
          const block = readCheckpointBlock(journal, m.identities[0]!, m.metadata, descriptor.payload.checkpointId, blocks, createdAt + 2);
          if (!block) break;
          if (blocks % 257 === 0) { check(canonical(readCheckpointBlock(journal, m.identities[0]!, m.metadata, descriptor.payload.checkpointId, blocks, createdAt + 2)) === canonical(block), "RETRY_BYTES_CHANGED"); retryChecks++; }
          blocks++; yield Buffer.from(canonical(block));
          if (blocks % 1000 === 0) { process.stdout.write(`${JSON.stringify({ progress: phase, blocks, memory: process.memoryUsage() })}\n`); await setImmediate(); }
        }
        yield Buffer.from(canonical(sealCheckpoint(journal, m.identities[0]!, m.metadata, descriptor.payload.checkpointId, createdAt + 2)));
      }
      const result = await backupStreamFrames(source(), archivePath, keyPath, options);
      check(journal.captureCounts().count === m.cycles + 1, "CONCURRENT_COLLECTION_MISSING");
      const after = sourceCounters(journal) as { id: string; value: number }[];
      check(canonical(after) === canonical(m.identities.map(identity => ({ id: identity.nodeId, value: m.cycles + 1 })).sort((a, b) => a.id.localeCompare(b.id))), "COUNTER_CHANGED_BEYOND_COLLECTION");
      check(canonical(manifest(directory).identities) === canonical(m.identities), "SOURCE_IDENTITY_CHANGED");
      releaseCheckpoint(journal, descriptor.payload.checkpointId, createdAt + 2, true);
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      return { ...result, blocks, retryChecks, migrationMs, beginMs, sourceCapturesAfterBegin: m.cycles + 1, checkpointCaptures: m.cycles,
        sourceIdentityUnchanged: true, counterIncrementsFromCollectionOnly: true, descriptorHash: archiveDescriptorHash(descriptor) };
    } finally { database.close(); }
  }
  if (phase === "inspect" || phase === "restore") {
    const result = phase === "inspect" ? await inspectStreamBackup(archivePath, keyPath, options)
      : await restoreStreamNode(archivePath, keyPath, join(directory, "restored"), options);
    check(result.reproducedSnapshots === m.cycles && result.observations === m.cycles * WIDTH && result.counts.captures === m.cycles && result.counts.reports === m.cycles * 3, "RESTORE_COUNTS");
    if (phase === "restore") {
      const identity = json(join(directory, "restored/data/node-identity.json")) as NodeIdentity;
      check(!m.identities.some(source => source.nodeId === identity.nodeId), "RESTORE_REUSED_IDENTITY");
      check(existsSync(join(directory, "restored", RECOVERY_MARKER)), "RESTORE_REVIEW_MARKER_MISSING");
    }
    return result;
  }
  if (phase === "local-backup" || phase === "local-restore") {
    const root=join(directory,"restored"),identity=json(join(root,"data/node-identity.json")) as NodeIdentity;
    const localArchive=join(directory,"local.sbx-stream"),localOptions={expectedNodeId:identity.nodeId,expectedRelease:m.metadata.release,operatorGroup:"capacity-local-fixture-only"};
    // Only this isolated, network-disabled fixture advances the clock to its synthetic last day.
    const realNow=Date.now;Date.now=()=>m.lastAt+2000;
    try {
      const result=phase==="local-backup"?await backupLocalStreamNode(root,join(root,"config/node.local.json"),localArchive,keyPath,localOptions)
        :await restoreStreamNode(localArchive,keyPath,join(directory,"local-restored"),localOptions);
      check(result.reproducedSnapshots===m.cycles&&result.observations===m.cycles*WIDTH&&result.counts.captures===m.cycles&&result.counts.reports===m.cycles*3,"LOCAL_RECOVERY_COUNTS");
      check(result.recoveryProvenance.records===1&&result.recoveryProvenance.linkedRecords===1,"LOCAL_RECOVERY_PROVENANCE");
      if(phase==="local-restore") {
        const nextIdentity=json(join(directory,"local-restored/data/node-identity.json")) as NodeIdentity;
        check(nextIdentity.nodeId!==identity.nodeId&&!m.identities.some(source=>source.nodeId===nextIdentity.nodeId),"LOCAL_RESTORE_REUSED_IDENTITY");
        check(existsSync(join(directory,"local-restored",RECOVERY_MARKER)),"LOCAL_RESTORE_REVIEW_MARKER_MISSING");
        const copy=new Database(join(directory,"local-restored/data/node.sqlite"),{readonly:true,strict:true});
        try {
          const counters=copy.query("SELECT id,value FROM counters ORDER BY id").all();
          check(canonical(counters)===canonical(m.identities.map(source=>({id:source.nodeId,value:m.cycles})).sort((a,b)=>a.id.localeCompare(b.id))),"LOCAL_FROZEN_COUNTER_MISMATCH");
          const original=json(join(directory,"descriptor.json")) as ArchiveDescriptor;
          check(canonical(copy.query("SELECT id,hash FROM snapshots ORDER BY id DESC LIMIT 1").get())===canonical(original.payload.snapshotHead),"LOCAL_FROZEN_HEAD_MISMATCH");
        }finally{copy.close();}
      }
      return result;
    }finally{Date.now=realNow;}
  }
  const restored = join(directory, "restored/data/node.sqlite"), db = new Database(restored, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA cache_size=-4096; PRAGMA mmap_size=0");
    const study = streamingStudy(db as unknown as SqlDriver, { from: m.firstAt, asOf: m.lastAt, expectedIntervalMs: INTERVAL });
    check(study.completeness.complete && study.completeness.observationsExamined === m.cycles * WIDTH, "STUDY_INCOMPLETE");
    check(study.window.captures === m.cycles && study.series.length === WIDTH && study.cadence.emptyBuckets === 0, "STUDY_COVERAGE");
    let reproduced = 0;
    for (const row of db.query("SELECT payload FROM snapshots ORDER BY id").iterate() as Iterable<{ payload: string }>) {
      const snapshot = JSON.parse(row.payload) as Snapshot;
      const registryRow = db.query("SELECT payload FROM configurations WHERE hash=?").get(snapshot.registryHash) as { payload: string };
      const methodologyRow = db.query("SELECT payload FROM configurations WHERE hash=?").get(snapshot.methodologyHash) as { payload: string };
      const hashes = [...new Set([...snapshot.inputBatchHashes, ...snapshot.rejected.map(item => item.batchHash)])];
      const reports = hashes.map(digest => JSON.parse((db.query("SELECT payload FROM reports WHERE hash=?").get(digest) as { payload: string }).payload) as SignedBatch);
      check(hash(calculate(reports, parseRegistry(JSON.parse(registryRow.payload)), parseMethodology(JSON.parse(methodologyRow.payload)), snapshot.calculatedAt)) === hash(snapshot), "INDEPENDENT_REPRODUCTION_MISMATCH");
      reproduced++;
    }
    check(reproduced === m.cycles, "INDEPENDENT_REPRODUCTION_COUNT");
    const counters = db.query("SELECT id,value FROM counters ORDER BY id").all() as { id: string; value: number }[];
    check(canonical(counters) === canonical(m.identities.map(identity => ({ id: identity.nodeId, value: m.cycles })).sort((a, b) => a.id.localeCompare(b.id))), "FROZEN_COUNTER_MISMATCH");
    const descriptor = json(join(directory, "descriptor.json")) as ArchiveDescriptor;
    check(canonical(db.query("SELECT id,hash FROM snapshots ORDER BY id DESC LIMIT 1").get()) === canonical(descriptor.payload.snapshotHead), "FROZEN_HEAD_MISMATCH");
    return { complete: study.completeness.complete, cycles: study.window.captures, capturedObservations: study.completeness.observationsExamined,
      inputBytes: study.completeness.inputBytes, series: study.series.length, emptyBuckets: study.cadence.emptyBuckets,
      independentReproducedSnapshots: reproduced, frozenCountersVerified: true, frozenSnapshotHeadVerified: true,
      calendarDays: (m.lastAt - m.firstAt) / 86_400_000, qualification: "SYNTHETIC_CAPACITY_ONLY_NOT_MARKET_HISTORY" };
  } finally { db.close(); }
}

async function subprocess(phase: Phase, directory: string, memoryLimitBytes: number) {
  check(process.platform === "darwin" || process.platform === "linux", "PEAK_RSS_PLATFORM_UNSUPPORTED");
  const started = performance.now(), args = [process.platform === "darwin" ? "-l" : "-v", process.execPath, import.meta.path, "--phase", phase, "--directory", directory];
  const child = spawn("/usr/bin/time", args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
  const terminate = () => { if (child.pid) try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ } };
  process.once("SIGINT", terminate); process.once("SIGTERM", terminate);
  let output = "", errors = "", progress = "";
  child.stdout.on("data", chunk => {
    const text = String(chunk); output += text; progress += text;
    const lines = progress.split("\n"); progress = lines.pop()!;
    for (const line of lines) if (line.startsWith('{"progress":')) process.stdout.write(`${line}\n`);
    if (output.length > 1024 * 1024) terminate();
  });
  child.stderr.on("data", chunk => { errors += String(chunk); if (errors.length > 1024 * 1024) terminate(); });
  let code: number | null;
  try { code = await new Promise<number | null>((resolveCode, reject) => { child.once("error", reject); child.once("close", resolveCode); }); }
  finally { process.removeListener("SIGINT", terminate); process.removeListener("SIGTERM", terminate); }
  const match = process.platform === "darwin" ? errors.match(/(\d+)\s+maximum resident set size/) : errors.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
  check(match, "OS_PEAK_RSS_MISSING");
  const peakRssBytes = Number(match[1]) * (process.platform === "darwin" ? 1 : 1024);
  if (code !== 0) throw new Error(`CAPACITY_PHASE_FAILED:${phase}:${errors.slice(0, 6000)}`);
  check(peakRssBytes <= memoryLimitBytes, `MEMORY_BUDGET:${phase}:${peakRssBytes}`);
  const final = output.trim().split("\n").at(-1); check(final, "PHASE_RESULT_MISSING");
  return { phase, elapsedMs: performance.now() - started, peakRssBytes, result: JSON.parse(final) as Record<string, unknown> };
}

const { values } = parseArgs({ args: process.argv.slice(2), options: { phase: { type: "string" }, directory: { type: "string" }, cycles: { type: "string" }, "memory-limit-mib": { type: "string" }, keep: { type: "boolean" } }, strict: true });
if (values.phase) {
  check(PHASES.includes(values.phase as Phase) && values.directory, "PHASE_ARGUMENTS");
  process.stdout.write(`${JSON.stringify(await phaseRun(values.phase as Phase, resolve(values.directory)))}\n`);
} else {
  check(!values.directory, "NEW_TEMPORARY_DIRECTORY_REQUIRED");
  const cycles = Number(values.cycles ?? FULL_CYCLES), memoryLimitMiB = Number(values["memory-limit-mib"] ?? 384);
  check(Number.isSafeInteger(cycles) && cycles > 0 && cycles <= FULL_CYCLES, "CYCLE_LIMIT");
  check(Number.isSafeInteger(memoryLimitMiB) && memoryLimitMiB >= 64 && memoryLimitMiB <= 2048, "MEMORY_LIMIT");
  const directory = mkdtempSync(join(tmpdir(), "sbx-stream-capacity-")); chmodSync(directory, 0o700);
  const e = environment(), metadata: CheckpointMetadata = { nodeName: "primary", operatorGroup: e.registry.operators[0]!.operatorGroup, release: "ca".repeat(20),
    network: e.registry.network, intervalMs: INTERVAL, registry: e.registry, methodology: e.methodology };
  privateJson(join(directory, "fixture-private.json"), { kind: KIND, cycles, width: WIDTH, firstAt: NOW, lastAt: NOW + (cycles - 1) * INTERVAL, identities: e.identities, metadata } satisfies Manifest);
  const phases = [];
  try {
    for (const phase of PHASES) {
      process.stdout.write(`${JSON.stringify({ starting: phase, fixture: KIND, cycles, directory })}\n`);
      const result = await subprocess(phase, directory, memoryLimitMiB * 1024 * 1024); phases.push(result); process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    const full = cycles === FULL_CYCLES;
    if (full) {
      check(Number(phases[0]!.result.evidenceBytes) > 128 * 1024 * 1024, "EVIDENCE_CAPACITY_TOO_SMALL");
      check(Number(phases[0]!.result.databaseBytes) > 64 * 1024 * 1024, "DATABASE_CAPACITY_TOO_SMALL");
      check(Number(phases[1]!.result.archiveBytes) > 128 * 1024 * 1024, "ENCRYPTED_ARCHIVE_CAPACITY_TOO_SMALL");
      check(Number(phases[5]!.result.archiveBytes) > 128 * 1024 * 1024, "LOCAL_ARCHIVE_CAPACITY_TOO_SMALL");
      check(Number(phases[6]!.result.databaseBytes) > 64 * 1024 * 1024, "LOCAL_RESTORE_CAPACITY_TOO_SMALL");
    }
    const summary = { kind: KIND, fullThirtyOneDayCapacityPassed: full, cycles, capturedObservations: cycles * WIDTH,
      calendarDays: (cycles - 1) * INTERVAL / 86_400_000, memoryLimitBytes: memoryLimitMiB * 1024 * 1024,
      memoryMeasurement: "FRESH_PROCESS_OS_PEAK_RSS", phases, retainedDirectory: values.keep ? directory : null,
      capacityScope: { signedOperators: 3, signedObservationsPerReport: 12, capturedObservationsPerCycle: WIDTH, collectionIntervalMs: INTERVAL,
        doesNotEstablishMaximumOperatorRetention: true }, networkGuard: "PRELOADED_FETCH_NODE_SOCKETS_AND_BUN_NETWORK_DISABLED",
      qualification: "SYNTHETIC_CAPACITY_ONLY_NOT_MARKET_HISTORY", liveHostedAcceptance: "SEPARATE_REQUIRED" };
    if (values.keep) privateJson(join(directory, "result.json"), summary);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally { if (!values.keep) rmSync(directory, { recursive: true, force: true }); }
}
