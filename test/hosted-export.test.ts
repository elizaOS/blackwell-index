// Synthetic evidence is confined to this test and private temporary directories.
// These tests make no provider requests and never connect to deployed nodes.
import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CloudflareJournal } from "../src/cloudflare/sql";
import { collectorSchedule } from "../src/collection-control";
import type { NodeConfig } from "../src/config";
import { canonical, hash, signBatch } from "../src/crypto";
import { calculate } from "../src/engine";
import { createHostedExport, HOSTED_EXPORT_FORMAT, HOSTED_EXPORT_LIMITS, parseHostedExport, type HostedExport } from "../src/hosted-export";
import { backupHostedExport } from "../src/hosted-recovery";
import { createRecoveryKey, inspectBackup, RECOVERY_MARKER, restoreNode } from "../src/recovery";
import { Store } from "../src/store";
import type { NodeIdentity, Observation } from "../src/types";
import { environment, NOW } from "./helpers";

const RELEASE = "1a".repeat(20);
const CHUNK_BYTES = 512 * 1024;
const directories: string[] = [];
const stores = new Set<Store>();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const digest = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");

async function fixture(splitCaptures = false, evidenceBytes = CHUNK_BYTES + 37) {
  const directory = mkdtempSync(join(tmpdir(), "sbx-hosted-export-test-"));
  directories.push(directory);
  const store = new Store(join(directory, "source.sqlite"));
  stores.add(store);
  const journal = new CloudflareJournal(store.db);
  const e = environment(), identity = e.identities[0]!;
  journal.saveConfiguration(e.registry);
  journal.saveConfiguration(e.methodology);
  // The default spans two chunks; small schema fixtures use the same nonuniform bytes.
  const body = Buffer.alloc(evidenceBytes);
  for (let i = 0; i < body.length; i++) body[i] = i % 251;
  const evidenceHash = digest(body);
  await journal.archive({ hash: evidenceHash, source: "isolated-hosted-test", url: "https://alpha.example/test-only",
    receivedAt: NOW - 1000, contentType: "application/octet-stream", body });
  const observations: Observation[] = Array.from({ length: splitCaptures ? 1100 : 2 }, (_, i) => ({
    ...e.observations[i % e.observations.length]!, sku: `isolated-test-sku-${i}`, evidenceHash,
  }));
  journal.capture(observations, ["isolated test capture diagnostic"], NOW);
  const batches = e.identities.map((signer, i) => signBatch({ ...e.batches[i]!.payload,
    sequence: i === 0 ? journal.nextSequence(identity.nodeId) : 1,
    observations: e.observations.map(observation => ({ ...observation, evidenceHash })),
  }, signer));
  for (const batch of batches) journal.accept(batch, NOW, true);
  const snapshot = calculate(batches, e.registry, e.methodology, NOW);
  journal.snapshot(snapshot);
  collectorSchedule(journal, "isolated-test", NOW);
  journal.db.query("INSERT INTO collector_schedules(collector_id,next_attempt_at,failures,reason,last_seen_at,version,lease_owner,lease_until) VALUES(?,?,?,?,?,?,?,?)")
    .run("isolated-test", NOW + 60_000, 1, "HTTP_429_BACKOFF", NOW, 1, null, 0);
  const metadata = { nodeName: "primary" as const, operatorGroup: "isolated-test-operator", release: RELEASE,
    network: e.registry.network, intervalMs: 300_000, registry: e.registry, methodology: e.methodology };
  const exportedAt = NOW + 3000;
  const encoded = createHostedExport(journal, identity, metadata, exportedAt);
  const keyPath = join(directory, "recovery.key"), outputPath = join(directory, "archive.sbx-backup");
  createRecoveryKey(keyPath);
  return { directory, store, journal, identity, body, evidenceHash, observations, batches, snapshot, metadata, exportedAt, encoded, keyPath, outputPath };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function table(envelope: HostedExport, name: string) {
  const result = envelope.payload.tables.find(item => item.name === name);
  if (!result) throw new Error(`Missing test table: ${name}`);
  return result;
}
function signedMutation(f: Fixture, mutate: (envelope: HostedExport) => void): string {
  const envelope = parseHostedExport(f.encoded, f.identity.nodeId, RELEASE);
  mutate(envelope);
  envelope.signature = sign(null, Buffer.from(`${HOSTED_EXPORT_FORMAT}\n${canonical(envelope.payload)}`),
    createPrivateKey(f.identity.privateKeyPem)).toString("base64");
  return canonical(envelope);
}
const backup = (f: Fixture, encoded = f.encoded) => backupHostedExport(encoded, f.outputPath, f.keyPath, f.identity.nodeId, RELEASE);
function counter(f: Fixture): number {
  return (f.journal.db.query("SELECT value FROM counters WHERE id=?").get(f.identity.nodeId) as { value: number }).value;
}

test("hosted export round-trips chunked evidence and split cycles through encrypted recovery without changing the source", async () => {
  const f = await fixture(true);
  expect(f.snapshot.publishable).toBe(true);
  expect(f.journal.counts().captureBatches).toBeGreaterThan(1);
  expect(f.journal.counts().captures).toBe(1);
  const parsed = parseHostedExport(f.encoded, f.identity.nodeId, RELEASE);
  expect(table(parsed, "evidence_chunks").rows).toHaveLength(2);
  expect(table(parsed, "collection_captures").rows).toHaveLength(1);
  expect(f.encoded).not.toContain(f.identity.privateKeyPem);
  expect(f.encoded).not.toContain("PRIVATE KEY");
  expect(counter(f)).toBe(1);

  const result = await backup(f), inspection = inspectBackup(f.outputPath, f.keyPath);
  expect(result.origin).toBe("CLOUDFLARE_SIGNED_LOGICAL_EXPORT");
  expect(result.exportEvidenceHash).toBe(digest(f.encoded));
  expect(result.sourceRelease).toBe(RELEASE);
  expect(result.privateKeysIncluded).toBe(false);
  expect(result.providerCredentialsIncluded).toBe(false);
  expect(inspection.sourceNodeId).toBe(f.identity.nodeId);
  expect(inspection.counts.captures).toBe(1);
  expect(inspection.counts.reports).toBe(3);
  expect(inspection.counts.evidence).toBe(2); // Original body plus exact signed logical export.
  expect(inspection.reproducedSnapshots).toBe(1);
  expect(inspection.history.valid).toBe(true);
  expect(statSync(f.keyPath).mode & 0o777).toBe(0o600);
  expect(statSync(f.outputPath).mode & 0o777).toBe(0o600);
  expect(readFileSync(f.outputPath, "utf8")).not.toContain("isolated-test-sku-");
  expect(readFileSync(f.outputPath, "utf8")).not.toContain(f.identity.privateKeyPem);

  const destination = join(f.directory, "restored");
  const restoredResult = restoreNode(f.outputPath, f.keyPath, destination);
  const identity = JSON.parse(readFileSync(join(destination, "data/node-identity.json"), "utf8")) as NodeIdentity;
  const config = JSON.parse(readFileSync(join(destination, "config/node.local.json"), "utf8")) as NodeConfig;
  expect(restoredResult.status).toBe("RECOVERY_REVIEW_REQUIRED");
  expect(identity.nodeId).not.toBe(f.identity.nodeId);
  expect(identity.privateKeyPem).not.toBe(f.identity.privateKeyPem);
  expect(existsSync(join(destination, RECOVERY_MARKER))).toBe(true);
  expect(config.collectors).toEqual([]);
  expect(config.peers).toEqual([]);
  expect(config.host).toBe("127.0.0.1");
  expect(config.pythManifestPath).toBeUndefined();
  const restored = new Store(join(destination, "data/node.sqlite"));
  stores.add(restored);
  const restoredBody = restored.db.query("SELECT body FROM evidence WHERE hash=?").get(f.evidenceHash) as { body: Uint8Array };
  expect(Buffer.from(restoredBody.body).equals(f.body)).toBe(true);
  const signed = restored.db.query("SELECT source,content_type,body FROM evidence WHERE hash=?").get(result.exportEvidenceHash) as { source: string; content_type: string; body: Uint8Array };
  expect(signed.source).toBe("sbx-hosted-export");
  expect(signed.content_type).toBe("application/vnd.sbx.hosted-journal+json");
  expect(Buffer.from(signed.body).toString()).toBe(f.encoded);
  const capture = restored.db.query("SELECT collected_at,observations,errors FROM captures").get() as { collected_at: number; observations: string; errors: string };
  expect(capture.collected_at).toBe(NOW);
  expect(JSON.parse(capture.observations)).toEqual(f.observations);
  expect(JSON.parse(capture.errors)).toEqual(["isolated test capture diagnostic"]);
  expect(restored.verifyHistory()).toEqual(f.journal.verifyHistory());
  expect(restored.configuration(hash(f.metadata.registry))).toEqual(f.metadata.registry);
  expect(collectorSchedule(restored, "isolated-test", NOW + 1).code).toBe("HTTP_429_BACKOFF");
  expect((restored.db.query("SELECT value FROM counters WHERE id=?").get(f.identity.nodeId) as { value: number }).value).toBe(1);
  expect(restored.db.query("SELECT value FROM counters WHERE id=?").get(identity.nodeId)).toBeNull();
  expect(readFileSync(join(destination, "data/node.sqlite")).includes(Buffer.from(f.identity.privateKeyPem))).toBe(false);

  expect(counter(f)).toBe(1);
  expect(createHostedExport(f.journal, f.identity, f.metadata, f.exportedAt)).toBe(f.encoded);
  expect(Buffer.from(f.journal.evidenceBody(f.evidenceHash)!).equals(f.body)).toBe(true);
  expect((f.journal.db.query("SELECT length(body) AS bytes FROM evidence WHERE hash=?").get(f.evidenceHash) as { bytes: number }).bytes).toBe(0);
  expect(f.journal.counts().evidence).toBe(1);
  expect(f.journal.counts().captureBatches).toBeGreaterThan(1);
}, 15_000);

test("hosted export rejects the wrong expected identity, release, and altered signature", async () => {
  const f = await fixture();
  expect(() => parseHostedExport(f.encoded, "f".repeat(64), RELEASE)).toThrow("HOSTED_EXPORT_SOURCE_MISMATCH");
  expect(() => parseHostedExport(f.encoded, f.identity.nodeId, "2b".repeat(20))).toThrow("HOSTED_EXPORT_SOURCE_MISMATCH");
  const altered = JSON.parse(f.encoded) as HostedExport;
  altered.signature = Buffer.alloc(64).toString("base64");
  expect(() => parseHostedExport(canonical(altered), f.identity.nodeId, RELEASE)).toThrow("HOSTED_EXPORT_SIGNATURE_INVALID");
  const changed = JSON.parse(f.encoded) as HostedExport;
  changed.payload.exportedAt++;
  expect(() => parseHostedExport(canonical(changed), f.identity.nodeId, RELEASE)).toThrow("HOSTED_EXPORT_SIGNATURE_INVALID");
});

for (const mutation of ["unknown table", "reserved-looking application table", "extra column"] as const) test(`hosted export refuses schema drift: ${mutation}`, async () => {
  const f = await fixture();
  if (mutation === "unknown table") f.journal.db.exec("CREATE TABLE future_private_state(id INTEGER PRIMARY KEY,value TEXT)");
  else if (mutation === "reserved-looking application table") f.journal.db.exec("CREATE TABLE __cf_unreviewed_application_state(id INTEGER PRIMARY KEY,value TEXT)");
  else f.journal.db.exec("ALTER TABLE captures ADD COLUMN future_private_state TEXT");
  expect(() => createHostedExport(f.journal, f.identity, f.metadata, f.exportedAt)).toThrow("HOSTED_EXPORT_SCHEMA_REVIEW_REQUIRED");
  expect(counter(f)).toBe(1);
});

test("hosted export excludes exact runtime KV tables without reading their synthetic secret markers", async () => {
  const f = await fixture(false, 64);
  const marker = "isolated-runtime-kv-secret-marker-not-a-real-credential";
  const names = ["_cf_KV", "_cf_METADATA", "__miniflare_do_name"] as const;
  f.journal.db.transaction(() => {
    for (const name of names) {
      f.journal.db.exec(`CREATE TABLE ${name}(key TEXT PRIMARY KEY,value TEXT NOT NULL)`);
      f.journal.db.query(`INSERT INTO ${name}(key,value) VALUES(?,?)`).run("isolated-secret", marker);
    }
  })();
  const encoded = createHostedExport(f.journal, f.identity, f.metadata, f.exportedAt);
  expect(encoded).toBe(f.encoded);
  expect(encoded).not.toContain(marker);
  expect(encoded).not.toContain(f.identity.privateKeyPem);
  const parsed = parseHostedExport(encoded, f.identity.nodeId, RELEASE);
  for (const name of names) {
    expect(parsed.payload.tables.some(item => item.name === name)).toBe(false);
    expect((f.journal.db.query(`SELECT value FROM ${name} WHERE key=?`).get("isolated-secret") as { value: string }).value).toBe(marker);
  }
  expect(counter(f)).toBe(1);
});

test("hosted export size limits refuse the whole export rather than truncating it", async () => {
  const f = await fixture();
  expect(() => createHostedExport(f.journal, f.identity, f.metadata, f.exportedAt, 1024)).toThrow("HOSTED_EXPORT_LIMIT_REQUIRES_STREAMING_ARCHIVE");
  expect(() => createHostedExport(f.journal, f.identity, f.metadata, f.exportedAt, Buffer.byteLength(f.encoded) - 1)).toThrow("HOSTED_EXPORT_LIMIT_REQUIRES_STREAMING_ARCHIVE");
  expect(() => createHostedExport(f.journal, f.identity, f.metadata, f.exportedAt, 0)).toThrow("INVALID_EXPORT_LIMIT");
  expect(() => createHostedExport(f.journal, f.identity, f.metadata, f.exportedAt, HOSTED_EXPORT_LIMITS.bytes + 1)).toThrow("INVALID_EXPORT_LIMIT");
  expect(() => parseHostedExport(" ".repeat(HOSTED_EXPORT_LIMITS.bytes + 1), f.identity.nodeId, RELEASE)).toThrow("HOSTED_EXPORT_TOO_LARGE");
  expect(counter(f)).toBe(1);
  expect(createHostedExport(f.journal, f.identity, f.metadata, f.exportedAt)).toBe(f.encoded);
});

for (const mutation of ["duplicate table", "invalid blob", "blob in non-blob column", "wrong columns", "wrong row width"] as const) test(`signed malformed export is rejected: ${mutation}`, async () => {
  const f = await fixture();
  const changed = signedMutation(f, envelope => {
    if (mutation === "duplicate table") envelope.payload.tables[1] = structuredClone(envelope.payload.tables[0]!);
    else if (mutation === "invalid blob") table(envelope, "evidence_chunks").rows[0]![2] = { base64: "%%%not-base64%%%" };
    else if (mutation === "blob in non-blob column") table(envelope, "counters").rows[0]![0] = { base64: "YQ==" };
    else if (mutation === "wrong columns") table(envelope, "counters").columns.reverse();
    else table(envelope, "counters").rows[0]!.push(null);
  });
  expect(() => parseHostedExport(changed, f.identity.nodeId, RELEASE)).toThrow();
  await expect(backup(f, changed)).rejects.toThrow();
  expect(existsSync(f.outputPath)).toBe(false);
});

for (const mutation of ["corrupt bytes", "missing chunk", "noncontiguous parts", "orphan chunk", "duplicate chunk", "incorrect size", "nonempty placeholder"] as const) test(`signed inconsistent evidence cannot become a backup: ${mutation}`, async () => {
  const f = await fixture();
  const changed = signedMutation(f, envelope => {
    const chunks = table(envelope, "evidence_chunks").rows;
    if (mutation === "corrupt bytes") {
      const body = Buffer.from((chunks[0]![2] as { base64: string }).base64, "base64");
      body[0] = body[0]! ^ 255;
      chunks[0]![2] = { base64: body.toString("base64") };
    } else if (mutation === "missing chunk") chunks.pop();
    else if (mutation === "noncontiguous parts") chunks[0]![1] = 3;
    else if (mutation === "orphan chunk") chunks[0]![0] = "b".repeat(64);
    else if (mutation === "duplicate chunk") chunks.push(structuredClone(chunks[0]!));
    else if (mutation === "incorrect size") table(envelope, "evidence_sizes").rows[0]![1] = f.body.length + 1;
    else table(envelope, "evidence").rows[0]![5] = { base64: "YQ==" };
  });
  expect(parseHostedExport(changed, f.identity.nodeId, RELEASE).payload.source.nodeId).toBe(f.identity.nodeId);
  await expect(backup(f, changed)).rejects.toThrow();
  expect(existsSync(f.outputPath)).toBe(false);
  expect(createHostedExport(f.journal, f.identity, f.metadata, f.exportedAt)).toBe(f.encoded);
});

for (const mutation of ["missing cycle", "duplicate cycle time", "cycle without batches", "future observation"] as const) test(`signed ambiguous captures cannot become a backup: ${mutation}`, async () => {
  const f = await fixture();
  const changed = signedMutation(f, envelope => {
    const cycles = table(envelope, "collection_captures").rows;
    if (mutation === "missing cycle") cycles.length = 0;
    else if (mutation === "duplicate cycle time") cycles.push([2, NOW]);
    else if (mutation === "cycle without batches") cycles.push([2, NOW + 1]);
    else {
      const capture = table(envelope, "captures").rows[0]!;
      const observations = JSON.parse(capture[2] as string) as Observation[];
      observations[0]!.observedAt = NOW + 1;
      capture[2] = canonical(observations);
    }
  });
  await expect(backup(f, changed)).rejects.toThrow();
  expect(existsSync(f.outputPath)).toBe(false);
  expect(createHostedExport(f.journal, f.identity, f.metadata, f.exportedAt)).toBe(f.encoded);
});

const numericColumns = [
  ["captures", "id"], ["captures", "collected_at"],
  ["collection_captures", "id"], ["collection_captures", "collected_at"],
  ["evidence_sizes", "bytes"], ["evidence_sizes", "parts"], ["evidence_chunks", "part"],
  ["evidence", "received_at"],
  ["collector_schedules", "next_attempt_at"], ["collector_schedules", "failures"],
  ["collector_schedules", "last_seen_at"], ["collector_schedules", "version"], ["collector_schedules", "lease_until"],
] as const;

for (const [tableName, column] of numericColumns) test(`signed ${tableName}.${column} rejects coercible text and invalid integers`, async () => {
  const f = await fixture(false, 64);
  for (const value of ["TEXT", String(column.includes("at") || column === "lease_until" ? NOW : 1), -1, 1.25, Number.MAX_SAFE_INTEGER + 1, null]) {
    const changed = signedMutation(f, envelope => {
      const item = table(envelope, tableName);
      item.rows[0]![item.columns.indexOf(column)] = value;
    });
    expect(() => parseHostedExport(changed, f.identity.nodeId, RELEASE)).toThrow();
    await expect(backup(f, changed)).rejects.toThrow();
    expect(existsSync(f.outputPath)).toBe(false);
  }
  expect(counter(f)).toBe(1);
  expect(createHostedExport(f.journal, f.identity, f.metadata, f.exportedAt)).toBe(f.encoded);
}, 15_000);

for (const tableName of ["captures", "collection_captures"] as const) test(`signed ${tableName} requires positive identifiers and timestamps`, async () => {
  const f = await fixture(false, 64);
  for (const column of ["id", "collected_at"]) {
    const changed = signedMutation(f, envelope => {
      const item = table(envelope, tableName);
      item.rows[0]![item.columns.indexOf(column)] = 0;
    });
    expect(() => parseHostedExport(changed, f.identity.nodeId, RELEASE)).toThrow();
    await expect(backup(f, changed)).rejects.toThrow();
    expect(existsSync(f.outputPath)).toBe(false);
  }
});

test("signed capture observations cannot reference absent archived evidence", async () => {
  const f = await fixture(false, 64);
  const changed = signedMutation(f, envelope => {
    const row = table(envelope, "captures").rows[0]!;
    const observations = JSON.parse(row[2] as string) as Observation[];
    observations[0]!.evidenceHash = "d".repeat(64);
    row[2] = canonical(observations);
  });
  expect(parseHostedExport(changed, f.identity.nodeId, RELEASE).payload.source.nodeId).toBe(f.identity.nodeId);
  await expect(backup(f, changed)).rejects.toThrow();
  expect(existsSync(f.outputPath)).toBe(false);
  expect(createHostedExport(f.journal, f.identity, f.metadata, f.exportedAt)).toBe(f.encoded);
});

test("graceful SIGTERM removes a materialized private hosted-import journal before returning", async () => {
  const f = await fixture(false, 64);
  const scratchRoot = join(f.directory, "child-private-tmp");
  mkdirSync(scratchRoot, { mode: 0o700 });
  // The archive wrapper only exists in this child. It pauses after the real private
  // database and signed-export evidence exist, then releases when SIGTERM aborts.
  const childCode = `
    import { Store } from ${JSON.stringify(resolve(import.meta.dir, "../src/store.ts"))};
    import { backupHostedExport } from ${JSON.stringify(resolve(import.meta.dir, "../src/hosted-recovery.ts"))};
    const controller = new AbortController();
    let releaseHold;
    process.once("SIGTERM", () => { controller.abort(); releaseHold?.(); });
    const originalArchive = Store.prototype.archive;
    Store.prototype.archive = async function(record) {
      await originalArchive.call(this, record);
      if (record.source === "sbx-hosted-export") {
        const timer = setInterval(() => {}, 1000);
        try {
          await new Promise(resolve => { releaseHold = resolve; process.stdout.write("SCRATCH_READY\\n"); });
        } finally { clearInterval(timer); }
      }
    };
    try {
      await backupHostedExport(await Bun.stdin.text(), ${JSON.stringify(f.outputPath)}, ${JSON.stringify(f.keyPath)},
        ${JSON.stringify(f.identity.nodeId)}, ${JSON.stringify(RELEASE)}, { signal: controller.signal });
      process.exitCode = 9;
    } catch (error) {
      if (!controller.signal.aborted) { console.error(error); process.exitCode = 8; }
      else { process.stdout.write("ABORTED_CLEANLY\\n"); process.exitCode = 2; }
    }
  `;
  const child = spawn(process.execPath, ["-e", childCode], {
    cwd: f.directory,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: scratchRoot },
    stdio: "pipe",
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.stdin.end(f.encoded);
  try {
    const deadline = Date.now() + 8000;
    while (!stdout.includes("SCRATCH_READY\n")) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
        throw new Error(`Import did not reach the protected scratch boundary: ${stdout} ${stderr}`);
      }
      await Bun.sleep(10);
    }
    // Bun may create its own runtime cache in TMPDIR. Only recovery owns this prefix.
    const scratchNames = readdirSync(scratchRoot).filter(name => name.startsWith("sbx-hosted-recovery-"));
    expect(scratchNames).toHaveLength(1);
    expect(scratchNames[0]!.startsWith("sbx-hosted-recovery-")).toBe(true);
    const scratch = join(scratchRoot, scratchNames[0]!);
    expect(statSync(scratch).mode & 0o777).toBe(0o700);
    expect(statSync(join(scratch, "data")).mode & 0o777).toBe(0o700);
    expect(existsSync(join(scratch, "data/node.sqlite"))).toBe(true);
    expect(existsSync(f.outputPath)).toBe(false);
    child.kill("SIGTERM");
    expect(await exited).toEqual({ code: 2, signal: null });
    expect(stdout).toContain("ABORTED_CLEANLY\n");
    expect(stderr).toBe("");
    expect(readdirSync(scratchRoot).filter(name => name.startsWith("sbx-hosted-recovery-"))).toEqual([]);
    expect(existsSync(f.outputPath)).toBe(false);
    expect(createHostedExport(f.journal, f.identity, f.metadata, f.exportedAt)).toBe(f.encoded);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
}, 15_000);
