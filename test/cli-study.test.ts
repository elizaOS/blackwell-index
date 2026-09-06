// Isolated local fixtures. No provider or hosted service is contacted.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultMethodology, defaultRegistry, type NodeConfig } from "../src/config";
import { canonical, generateIdentity } from "../src/crypto";
import { HOSTED_EXPORT_FORMAT, HOSTED_TABLES } from "../src/hosted-export";
import { Store } from "../src/store";
import type { OperatingStudy } from "../src/study";
import { environment, NOW } from "./helpers";

const CLI = resolve(import.meta.dir, "../src/cli.ts"), directories: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>(), PRIVATE_MARKER = "PRIVATE_STUDY_IMPORT_MARKER";
function temporary() { const path = mkdtempSync(join(tmpdir(), "sbx-cli-study-test-")); directories.push(path); return path; }
function config(directory: string): NodeConfig {
  mkdirSync(join(directory, "config"), { mode: 0o700 });
  const value: NodeConfig = { schemaVersion: 1, network: "sbx-mainnet", identityPath: "missing-private-identity.json", databasePath: "data/node.sqlite",
    registryPath: "missing-registry.json", methodologyPath: "missing-methodology.json", host: "127.0.0.1", port: 3410, intervalMs: 300_000,
    collectors: ["lambda-cloud"], peers: ["https://never-contacted.invalid"], allowLoopbackPeers: false, pythManifestPath: "missing-pyth-manifest.json" };
  writeFileSync(join(directory, "config/node.local.json"), JSON.stringify(value), { mode: 0o600 });
  return value;
}
function fixture() {
  const directory = temporary(); config(directory);
  const store = new Store(join(directory, "data/node.sqlite")), base = environment().observations[0]!;
  try {
    store.capture([{ ...base, observedAt: NOW, sku: PRIVATE_MARKER, price: "7.125000", instancePrice: "57", priceScope: "ACCOUNT_SPECIFIC", sourceRecordId: `${PRIVATE_MARKER}-reference` }], [PRIVATE_MARKER], NOW);
    store.capture([{ ...base, observedAt: NOW + 300_000, sku: PRIVATE_MARKER, price: "8.000000", instancePrice: "64", priceScope: "ACCOUNT_SPECIFIC" }], [], NOW + 300_000);
  } finally { store.close(); }
  writeFileSync(join(directory, "data/credentials.json"), JSON.stringify([PRIVATE_MARKER]), { mode: 0o600 });
  writeFileSync(join(directory, ".env"), `LAMBDA_API_KEY=${PRIVATE_MARKER}\n`, { mode: 0o600 });
  chmodSync(join(directory, "data/node.sqlite"), 0o444);
  return directory;
}
function launch(directory: string, args: string[], input: string | Buffer | null = "", preloadSource = "") {
  // A separate cwd prevents Bun's automatic dotenv handling from preloading node secrets.
  const cwd = temporary(), preload = join(cwd, "guard.ts");
  writeFileSync(preload, `globalThis.fetch = () => { throw new Error("TEST_NETWORK_REQUEST_FORBIDDEN"); };
    process.on("exit", () => { if (process.env.LAMBDA_API_KEY !== undefined) process.exitCode = 91; });
    ${preloadSource}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, ["--preload", preload, CLI, ...args, "--dir", directory], {
    cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: "pipe",
  });
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.on("error", () => { /* Rejected input can close the pipe before it drains. */ });
  if (input !== null) child.stdin.end(input);
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const result = new Promise<{ code: number; stdout: string; stderr: string }>((done, reject) => {
    child.on("error", reject);
    child.on("close", code => { clearTimeout(timer); children.delete(child); done({ code: code ?? -1, stdout, stderr }); });
  });
  return { child, result };
}
function files(directory: string): Array<{ path: string; mode: number; bytes: Buffer }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(directory, entry.name)).map(file => ({ ...file, path: `${entry.name}/${file.path}` }))
    : [{ path: entry.name, mode: statSync(join(directory, entry.name)).mode & 0o777, bytes: readFileSync(join(directory, entry.name)) }]).sort((a, b) => a.path.localeCompare(b.path));
}
function persistentNodeFiles(directory: string) {
  // WAL and SHM coordinate normal readers/writers and may change on read-only opens.
  // Do not hide the main database or any credential/configuration/private output file.
  return files(directory).filter(file => !["data/node.sqlite-wal", "data/node.sqlite-shm"].includes(file.path));
}
function logicalState(directory: string) {
  const database = new Database(join(directory, "data/node.sqlite"), { readonly: true, strict: true });
  try {
    return database.transaction(() => ({
      schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
      tables: Object.fromEntries(["captures", "evidence", "configurations", "snapshots", "counters", "reports", "candidates", "equivocations", "equivocation_proofs"]
        .map(table => [table, database.query(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    }))();
  } finally { database.close(); }
}
afterEach(async () => {
  await Promise.all([...children].map(child => new Promise<void>(done => { child.once("close", () => done()); child.kill("SIGKILL"); })));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("study prints only counts and preserves logical data, schema and private files", async () => {
  const directory = fixture(), before = persistentNodeFiles(directory), logicalBefore = logicalState(directory);
  const result = await launch(directory, ["study", "--at", String(NOW + 900_000), "--from", String(NOW)]).result;
  expect(result.code).toBe(0); expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({ kind: "RETAINED_CAPTURE_OPERATING_STUDY", reportSaved: false, complete: true,
    capturesParsed: 2, retainedPricePoints: 2, seriesCount: 1, sourceCount: 1, qualification: "NOT_ESTABLISHED",
    cadence: { expectedBuckets: 3, occupiedBuckets: 2, emptyBuckets: 1 } });
  expect(JSON.parse(result.stdout).series).toBeUndefined(); expect(result.stdout).not.toContain(PRIVATE_MARKER); expect(result.stdout).not.toContain("7.125000");
  expect(persistentNodeFiles(directory)).toEqual(before); expect(logicalState(directory)).toEqual(logicalBefore);
});

test("study writes full private JSON only to a new mode-0600 output and refuses overwrite", async () => {
  const directory = fixture(), inputBytes = readFileSync(join(directory, "data/node.sqlite")), logicalBefore = logicalState(directory);
  const args = ["study", "--at", String(NOW + 900_000), "--output", "data/studies/private.json"];
  const result = await launch(directory, args).result;
  expect(result.code).toBe(0); expect(JSON.parse(result.stdout).reportSaved).toBe(true);
  expect(result.stdout).not.toContain(PRIVATE_MARKER); expect(result.stdout).not.toContain("7.125000");
  const output = join(directory, "data/studies/private.json"), original = readFileSync(output);
  const report = JSON.parse(original.toString()) as OperatingStudy;
  expect(report.series[0]!.terms.priceScope).toBe("ACCOUNT_SPECIFIC"); expect(report.series[0]!.terms.sku).toBe(PRIVATE_MARKER);
  expect(report.series[0]!.points[0]!.price).toBe("7.125000");
  expect(statSync(output).mode & 0o777).toBe(0o600); expect(statSync(join(directory, "data/studies")).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(directory, "data/node.sqlite"))).toEqual(inputBytes); expect(statSync(join(directory, "data/node.sqlite")).mode & 0o777).toBe(0o444);
  expect(logicalState(directory)).toEqual(logicalBefore);
  const duplicate = await launch(directory, args).result;
  expect(duplicate.code).toBe(1); expect(duplicate.stderr).toContain("Study output already exists"); expect(duplicate.stdout).toBe("");
  expect(readFileSync(output)).toEqual(original);
});

test("study validates strict millisecond bounds before writes and cannot initialize a missing journal", async () => {
  const directory = fixture(), before = files(directory);
  for (const at of ["0", "-1", "1.5", "1e3", " 1000", "01", "9007199254740992", ""]) {
    const result = await launch(directory, ["study", `--at=${at}`, "--output", "must-not-exist.json"]).result;
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("positive safe integer epoch milliseconds");
  }
  const inverted = await launch(directory, ["study", "--at", String(NOW), "--from", String(NOW + 1), "--output", "must-not-exist.json"]).result;
  expect(inverted.code).toBe(1); expect(inverted.stderr).toContain("start must not exceed"); expect(files(directory)).toEqual(before);
  const missing = temporary(); config(missing); const missingBefore = files(missing);
  expect((await launch(missing, ["study"]).result).code).toBe(1); expect(files(missing)).toEqual(missingBefore);
}, 30_000);

test("study remains available under the recovery review marker without reading the signer", async () => {
  const directory = fixture();
  writeFileSync(join(directory, "data/RECOVERY_REVIEW_REQUIRED.json"), "{}", { mode: 0o600 });
  const before = persistentNodeFiles(directory), logicalBefore = logicalState(directory), result = await launch(directory, ["study", "--at", String(NOW + 900_000)]).result;
  expect(result.code).toBe(0); expect(persistentNodeFiles(directory)).toEqual(before); expect(logicalState(directory)).toEqual(logicalBefore);
  expect(existsSync(join(directory, "missing-private-identity.json"))).toBe(false);
});

test("study includes committed live WAL records without changing the writer's logical state", async () => {
  const directory = fixture();
  chmodSync(join(directory, "data/node.sqlite"), 0o600);
  const writer = new Store(join(directory, "data/node.sqlite"));
  try {
    writer.db.exec("PRAGMA wal_autocheckpoint=0");
    const observation = environment().observations[0]!;
    writer.capture([{ ...observation, observedAt: NOW + 600_000 }], [], NOW + 600_000);
    expect(statSync(join(directory, "data/node.sqlite-wal")).size).toBeGreaterThan(0);
    const before = persistentNodeFiles(directory), logicalBefore = logicalState(directory);
    const result = await launch(directory, ["study", "--at", String(NOW + 900_000)]).result;
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ capturesParsed: 3, retainedPricePoints: 3 });
    expect(persistentNodeFiles(directory)).toEqual(before); expect(logicalState(directory)).toEqual(logicalBefore);
  } finally { writer.close(); }
});

function hostedFixture() {
  const identity = generateIdentity(), release = "b".repeat(40), registry = defaultRegistry("sbx-mainnet");
  const payload = { format: HOSTED_EXPORT_FORMAT, exportedAt: NOW + 1000,
    source: { nodeId: identity.nodeId, publicKey: identity.publicKey, nodeName: "primary", operatorGroup: "test-only", release },
    configuration: { network: registry.network, intervalMs: 300_000, registry, methodology: defaultMethodology() },
    tables: HOSTED_TABLES.map(table => ({ name: table.name, columns: [...table.columns], rows: [] as unknown[][] })) };
  const encode = () => canonical({ payload, signature: sign(null, Buffer.from(`${HOSTED_EXPORT_FORMAT}\n${canonical(payload)}`), createPrivateKey(identity.privateKeyPem)).toString("base64") });
  return { payload, encode, identity, args: ["import-hosted-backup", "--expected-node-id", identity.nodeId, "--expected-release", release,
    "--key-file", `${PRIVATE_MARKER}.missing-key`, "--output", "must-not-exist.sbx-backup"] };
}

test("hosted import never exposes malformed JSON, schema keys, UTF-8 diagnostics or parser arguments", async () => {
  const directory = temporary(), hosted = hostedFixture();
  for (const input of [`{"${PRIVATE_MARKER}":`, JSON.stringify({ [PRIVATE_MARKER]: "schema-failure" }), Buffer.from([0xc3, 0x28])]) {
    const result = await launch(directory, hosted.args, input).result;
    expect(result).toEqual({ code: 1, stdout: "", stderr: "HOSTED_BACKUP_IMPORT_FAILED\n" });
    expect(files(directory)).toEqual([]);
  }
  const argumentsFailure = await launch(directory, [...hosted.args, `--${PRIVATE_MARKER}`]).result;
  expect(argumentsFailure).toEqual({ code: 1, stdout: "", stderr: "HOSTED_BACKUP_IMPORT_FAILED\n" });
  const missingArguments = await launch(directory, ["import-hosted-backup"]).result;
  expect(missingArguments).toEqual({ code: 1, stdout: "", stderr: "HOSTED_BACKUP_IMPORT_FAILED\n" });
}, 20_000);

test("signed hosted import failures in SQLite, capture JSON and key IO remain confidential", async () => {
  const directory = temporary();
  for (const failure of ["sqlite", "capture-json", "key-file"] as const) {
    const hosted = hostedFixture();
    if (failure === "sqlite") hosted.payload.tables.find(table => table.name === "counters")!.rows = [[hosted.identity.nodeId, 1], [hosted.identity.nodeId, 1]];
    if (failure === "capture-json") {
      hosted.payload.tables.find(table => table.name === "captures")!.rows = [[1, NOW, PRIVATE_MARKER, "[]"]];
      hosted.payload.tables.find(table => table.name === "collection_captures")!.rows = [[1, NOW]];
    }
    const result = await launch(directory, hosted.args, hosted.encode()).result;
    expect(result).toEqual({ code: 1, stdout: "", stderr: "HOSTED_BACKUP_IMPORT_FAILED\n" }); expect(files(directory)).toEqual([]);
  }
}, 20_000);

test("interrupted hosted stdin import exits with a fixed error and no output artifact", async () => {
  const directory = temporary(), ready = join(directory, "test-listener-ready"), hosted = hostedFixture();
  const preload = `import { writeFileSync } from "node:fs";
    process.on("newListener", (name) => { if (name === "SIGTERM") queueMicrotask(() => writeFileSync(${JSON.stringify(ready)}, "ready")); });`;
  const pending = launch(directory, hosted.args, null, preload);
  pending.child.stdin.write(`{"${PRIVATE_MARKER}":`);
  const deadline = Date.now() + 5000;
  while (!existsSync(ready)) { if (Date.now() > deadline) throw new Error("Import interrupt handler did not initialize"); await Bun.sleep(10); }
  pending.child.kill("SIGTERM");
  expect(await pending.result).toEqual({ code: 1, stdout: "", stderr: "HOSTED_BACKUP_IMPORT_FAILED\n" });
  expect(existsSync(join(directory, "must-not-exist.sbx-backup"))).toBe(false);
}, 15_000);
