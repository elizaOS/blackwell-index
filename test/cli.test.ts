import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { NodeConfig } from "../src/config";
import type { Methodology, NodeIdentity, Registry, SignedBatch, Snapshot } from "../src/types";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const directories: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
type JsonRecord = Record<string, unknown>;

function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "sbx-cli-test-"));
  directories.push(directory);
  return directory;
}
function readJson<T>(directory: string, path: string): T {
  return JSON.parse(readFileSync(join(directory, path), "utf8")) as T;
}
function writeJson(directory: string, path: string, value: unknown): void {
  writeFileSync(join(directory, path), JSON.stringify(value), { mode: 0o600 });
}
interface LaunchOptions { cwd?: string; env?: Record<string, string>; preload?: string }
function launch(directory: string, args: string[], options: LaunchOptions = {}) {
  // Do not inherit provider keys, cloud metadata configuration or the repository's .env.
  const child = spawn(process.execPath, [...(options.preload ? ["--preload", options.preload] : []), cli, ...args, "--dir", directory], {
    cwd: options.cwd ?? directory, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...options.env }, stdio: "pipe",
  });
  children.add(child);
  child.stdin.end();
  let stdout = "", stderr = "", buffer = "";
  const frames: JsonRecord[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString(); buffer += chunk.toString();
    // CLI objects are pretty-printed with a root closing brace on its own line.
    let boundary: number;
    while ((boundary = buffer.indexOf("\n}\n")) >= 0) {
      frames.push(JSON.parse(buffer.slice(0, boundary + 2)) as JsonRecord);
      buffer = buffer.slice(boundary + 3);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number>((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", code => { children.delete(child); resolveExit(code ?? -1); });
  });
  return { child, frames, exited, stdout: () => stdout, stderr: () => stderr };
}
async function command(directory: string, ...args: string[]) {
  return commandAt(directory, args);
}
async function commandAt(directory: string, args: string[], options: LaunchOptions = {}) {
  const process = launch(directory, args, options);
  const timer = setTimeout(() => process.child.kill("SIGKILL"), 10_000);
  try {
    const code = await process.exited;
    return { code, stdout: process.stdout(), stderr: process.stderr(), json: <T>() => JSON.parse(process.stdout()) as T };
  } finally { clearTimeout(timer); }
}
async function setup(directory: string, providers = "") {
  const result = await command(directory, "setup", "--providers", providers, "--port", "0");
  expect(result.code).toBe(0);
  return readJson<NodeIdentity>(directory, "data/node-identity.json");
}
async function until(check: () => boolean, description: () => string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(description());
    await Bun.sleep(10);
  }
}
async function start(directory: string) {
  const process = launch(directory, ["run"]);
  await until(() => process.frames.some(frame => frame.collectedAt), () => `Node did not collect: ${process.stdout()} ${process.stderr()}`);
  const running = process.frames.find(frame => frame.status === "RUNNING");
  expect(typeof running?.address).toBe("string");
  return { ...process, address: running!.address as string };
}
async function stop(process: ReturnType<typeof launch>): Promise<void> {
  process.child.kill("SIGTERM");
  expect(await process.exited).toBe(0);
}
function admit(directory: string, identities: NodeIdentity[]): void {
  const registry = readJson<Registry>(directory, "config/registry.local.json");
  registry.operators = identities.map((identity, index) => ({
    nodeId: identity.nodeId, publicKey: identity.publicKey, operatorGroup: `test-operator-${index}`, enabled: true,
  }));
  writeJson(directory, "config/registry.local.json", registry);
}
function localCredentials(directory: string, value: unknown): void {
  mkdirSync(join(directory, "data"), { mode: 0o700 });
  writeJson(directory, "data/credentials.json", value);
}
function assertChildEnvironment(directory: string, expected: Record<string, string | null>): string {
  const path = join(directory, "assert-credentials.preload.ts");
  // Test-only exit assertions inspect exact loaded bytes without printing any credential.
  writeFileSync(path, `process.on("exit", () => {
    for (const [name, value] of Object.entries(${JSON.stringify(expected)})) {
      if (process.env[name] !== (value === null ? undefined : value)) process.exitCode = 23;
    }
  });\n`, { mode: 0o600 });
  return path;
}

afterEach(async () => {
  const pending = [...children].map(child => new Promise<void>(resolveClose => {
    child.once("close", () => resolveClose()); child.kill("SIGKILL");
  }));
  await Promise.all(pending);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CLI subprocess lifecycle (empty-source test configuration; no provider requests)", () => {
  test("setup generates unique private identities and refuses to overwrite an existing node", async () => {
    const first = freshDirectory(), second = freshDirectory();
    const [a, b] = await Promise.all([setup(first), setup(second)]);
    expect(a.nodeId).not.toBe(b.nodeId);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKeyPem).not.toBe(b.privateKeyPem);
    expect(readJson<NodeConfig>(first, "config/node.local.json").collectors).toEqual([]);
    for (const path of ["data/node-identity.json", "config/node.local.json", "config/registry.local.json", "config/methodology.local.json"]) {
      expect(statSync(join(first, path)).mode & 0o777).toBe(0o600);
    }
    expect(statSync(join(first, "data")).mode & 0o777).toBe(0o700);
    const duplicate = await command(first, "setup", "--providers", "");
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain("Configuration already exists");
    expect(readJson<NodeIdentity>(first, "data/node-identity.json")).toEqual(a);
    const status = await command(first, "status");
    expect(status.code).toBe(0);
    expect(status.json<{ nodeId: string }>().nodeId).toBe(a.nodeId);
    expect(status.stdout).not.toContain("privateKeyPem");
    expect(status.stdout).not.toContain("BEGIN PRIVATE KEY");
    expect(statSync(join(first, "data/node.sqlite")).mode & 0o777).toBe(0o600);
  }, 20_000);

  test("collect and status persist honest empty coverage and reproduce using archived configuration", async () => {
    const directory = freshDirectory(), identity = await setup(directory);
    admit(directory, [identity]);
    const collected = await command(directory, "collect");
    expect(collected.code).toBe(0);
    const first = collected.json<{ realObservationCount: number; sharedObservationCount: number; errors: string[]; publishable: boolean; snapshotHash: string }>();
    expect(first).toMatchObject({ realObservationCount: 0, sharedObservationCount: 0, errors: [], publishable: false });
    const methodology = readJson<Methodology>(directory, "config/methodology.local.json");
    methodology.version = "test-new-current-config";
    methodology.modelWeights.B200 = 2;
    writeJson(directory, "config/methodology.local.json", methodology);
    const registry = readJson<Registry>(directory, "config/registry.local.json");
    registry.version = "test-new-current-registry";
    writeJson(directory, "config/registry.local.json", registry);
    expect((await command(directory, "collect")).code).toBe(0);
    const statusResult = await command(directory, "status");
    expect(statusResult.code).toBe(0);
    const status = statusResult.json<{ counts: Record<string, number>; coverage: { count: number }; history: { valid: boolean; count: number }; snapshot: Snapshot }>();
    expect(status.counts.reports).toBe(2);
    expect(status.counts.evidence).toBe(0);
    expect(status.coverage.count).toBe(2);
    expect(status.history).toEqual({ valid: true, count: 2 });
    expect(status.snapshot.methodologyVersion).toBe("test-new-current-config");
    expect(status.snapshot.feeds.every(feed => feed.price === null && feed.status === "UNAVAILABLE")).toBe(true);
    const reproduced = await command(directory, "reproduce", "--sequence", "1");
    expect(reproduced.code).toBe(0);
    expect(reproduced.json()).toMatchObject({ sequence: 1, matches: true, originalHash: first.snapshotHash, reproducedHash: first.snapshotHash });
    const absent = await command(directory, "reproduce", "--sequence", "999");
    expect(absent.code).toBe(1);
    expect(absent.stderr).toContain("Snapshot does not exist");
    const missing = await command(directory, "reproduce");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("INVALID_SNAPSHOT_SEQUENCE");
  }, 30_000);

  test("recovery CLI encrypts, inspects and restores without reusing identity or enabling providers", async () => {
    const source = freshDirectory(), foreignCwd = freshDirectory(), identity = await setup(source);
    admit(source, [identity]);
    const collected = await command(source, "collect");
    expect(collected.code).toBe(0);
    const snapshotHash = collected.json<{ snapshotHash: string }>().snapshotHash;
    expect(collected.json()).toMatchObject({ realObservationCount: 0, sharedObservationCount: 0, publishable: false });

    // These protected placeholders are never used in a request. Recovery must not
    // load them, copy their files, or carry the enabled configuration into restore.
    const credential = "test-recovery-credential-not-a-real-provider-key";
    writeJson(source, "data/credentials.json", { LAMBDA_API_KEY: credential });
    writeFileSync(join(source, ".env"), 'RUNPOD_API_KEY="test-recovery-env-must-not-load"\n', { mode: 0o600 });
    writeJson(source, "data/private-pyth.json", { testOnly: "not-a-production-pyth-manifest" });
    const sourceConfig = readJson<NodeConfig>(source, "config/node.local.json");
    sourceConfig.collectors = ["lambda-cloud"];
    sourceConfig.peers = ["https://never-contacted.invalid"];
    sourceConfig.pythManifestPath = "data/private-pyth.json";
    writeJson(source, "config/node.local.json", sourceConfig);
    const originals = Object.fromEntries([
      "data/node-identity.json", "data/node.sqlite", "data/credentials.json", "data/private-pyth.json", ".env",
      "config/node.local.json", "config/registry.local.json", "config/methodology.local.json",
    ].map(path => [path, readFileSync(join(source, path))]));
    const options = { cwd: foreignCwd, preload: assertChildEnvironment(source, { LAMBDA_API_KEY: null, RUNPOD_API_KEY: null }) };
    const runRecovery = (...args: string[]) => commandAt(source, args, options);

    const generated = await runRecovery("backup-keygen", "--output", "data/recovery.key");
    expect(generated.code).toBe(0);
    expect(generated.json<{ keyFile: string }>().keyFile).toBe(join(source, "data/recovery.key"));
    const keyBytes = readFileSync(join(source, "data/recovery.key"));
    expect(statSync(join(source, "data/recovery.key")).mode & 0o777).toBe(0o600);
    const duplicateKey = await runRecovery("backup-keygen", "--output", "data/recovery.key");
    expect(duplicateKey.code).toBe(1);expect(readFileSync(join(source, "data/recovery.key"))).toEqual(keyBytes);

    const backedUp = await runRecovery("backup", "--key-file", "data/recovery.key", "--output", "data/recovery.sbx-backup");
    expect(backedUp.code).toBe(0);
    expect(backedUp.json()).toMatchObject({ sourceNodeId: identity.nodeId, privateKeysIncluded: false, providerCredentialsIncluded: false, reproducedSnapshots: 1 });
    const bundleBytes = readFileSync(join(source, "data/recovery.sbx-backup"));
    expect(statSync(join(source, "data/recovery.sbx-backup")).mode & 0o777).toBe(0o600);
    expect(bundleBytes.toString()).not.toContain(credential);expect(bundleBytes.toString()).not.toContain(identity.privateKeyPem);
    const duplicateBundle = await runRecovery("backup", "--key-file", "data/recovery.key", "--output", "data/recovery.sbx-backup");
    expect(duplicateBundle.code).toBe(1);expect(duplicateBundle.stderr).toContain("already exists");
    expect(readFileSync(join(source, "data/recovery.sbx-backup"))).toEqual(bundleBytes);

    const inspected = await runRecovery("backup-inspect", "--key-file", "data/recovery.key", "--input", "data/recovery.sbx-backup");
    expect(inspected.code).toBe(0);
    expect(inspected.json()).toMatchObject({ sourceNodeId: identity.nodeId, history: { valid: true, count: 1 }, reproducedSnapshots: 1,
      counts: { reports: 1, captures: 1, evidence: 0 }, quarantineProofs: { verified: 0, unavailable: 0, requiresReview: false } });
    expect((await runRecovery("backup-keygen", "--output", "data/wrong.key")).code).toBe(0);
    const wrongInspection = await runRecovery("backup-inspect", "--key-file", "data/wrong.key", "--input", "data/recovery.sbx-backup");
    expect(wrongInspection.code).toBe(1);expect(wrongInspection.stderr).toContain("authentication failed");
    const wrongRestore = await runRecovery("restore", "--key-file", "data/wrong.key", "--input", "data/recovery.sbx-backup", "--target", "must-not-exist");
    expect(wrongRestore.code).toBe(1);expect(wrongRestore.stderr).toContain("authentication failed");
    expect(existsSync(join(source, "must-not-exist"))).toBe(false);

    const restored = join(source, "restored");
    const restore = await runRecovery("restore", "--key-file", "data/recovery.key", "--input", "data/recovery.sbx-backup", "--target", "restored");
    expect(restore.code).toBe(0);
    const restoredIdentity = readJson<NodeIdentity>(restored, "data/node-identity.json");
    expect(restore.json()).toMatchObject({ destination: restored, sourceNodeId: identity.nodeId, newNodeId: restoredIdentity.nodeId, status: "RECOVERY_REVIEW_REQUIRED" });
    expect(restoredIdentity.nodeId).not.toBe(identity.nodeId);expect(restoredIdentity.privateKeyPem).not.toBe(identity.privateKeyPem);
    const restoredConfig = readJson<NodeConfig>(restored, "config/node.local.json");
    expect(restoredConfig).toMatchObject({ collectors: [], peers: [], host: "127.0.0.1", allowLoopbackPeers: false });
    expect(restoredConfig.pythManifestPath).toBeUndefined();
    expect(readJson<Registry>(restored, "config/registry.local.json").operators.some(operator => operator.nodeId === identity.nodeId)).toBe(false);
    const marker = readJson<{ status: string; sourceNodeId: string; newNodeId: string }>(restored, "data/RECOVERY_REVIEW_REQUIRED.json");
    expect(marker).toMatchObject({ status: "RECOVERY_REVIEW_REQUIRED", sourceNodeId: identity.nodeId, newNodeId: restoredIdentity.nodeId });
    for (const path of ["data/credentials.json", "data/private-pyth.json", "data/recovery.key", ".env"]) expect(existsSync(join(restored, path))).toBe(false);
    expect(statSync(join(restored, "data/node-identity.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(restored, "data/node.sqlite")).mode & 0o777).toBe(0o600);

    const status = await commandAt(restored, ["status"], { cwd: foreignCwd });
    expect(status.code).toBe(0);
    expect(status.json()).toMatchObject({ nodeId: restoredIdentity.nodeId, counts: { reports: 1, captures: 1 }, history: { valid: true, count: 1 } });
    const reproduction = await commandAt(restored, ["reproduce", "--sequence", "1"], { cwd: foreignCwd });
    expect(reproduction.code).toBe(0);
    expect(reproduction.json()).toMatchObject({ sequence: 1, matches: true, originalHash: snapshotHash, reproducedHash: snapshotHash });

    const duplicateRestore = await runRecovery("restore", "--key-file", "data/recovery.key", "--input", "data/recovery.sbx-backup", "--target", "restored");
    expect(duplicateRestore.code).toBe(1);expect(duplicateRestore.stderr).toContain("existing data will not be overwritten");
    expect(readJson<NodeIdentity>(restored, "data/node-identity.json")).toEqual(restoredIdentity);
    for (const [path, bytes] of Object.entries(originals)) expect(readFileSync(join(source, path))).toEqual(bytes);
    expect(readFileSync(join(source, "data/recovery.sbx-backup"))).toEqual(bundleBytes);

    // Failures must occur at the recovery marker, before the CLI parses credentials
    // or loads environment values. A foreign cwd also avoids Bun's own dotenv preload.
    writeJson(restored, "data/credentials.json", ["invalid-credential-object-must-not-be-read"]);
    writeFileSync(join(restored, ".env"), 'LAMBDA_API_KEY="test-marker-must-not-load"\n', { mode: 0o600 });
    const markerOptions = { cwd: foreignCwd, preload: assertChildEnvironment(restored, { LAMBDA_API_KEY: null }) };
    for (const action of ["run", "collect"]) {
      const blocked = await commandAt(restored, [action], markerOptions);
      expect(blocked.code).toBe(1);expect(blocked.stderr).toContain("RECOVERY_REVIEW_REQUIRED");
      expect(blocked.stderr).not.toContain("Invalid local credential file");expect(blocked.stdout).toBe("");
    }
    for (const result of [generated, duplicateKey, backedUp, duplicateBundle, inspected, wrongInspection, wrongRestore, restore, status, reproduction, duplicateRestore]) {
      expect(result.stdout + result.stderr).not.toContain(credential);
      expect(result.stdout + result.stderr).not.toContain(identity.privateKeyPem);
      expect(result.stdout + result.stderr).not.toContain(keyBytes.toString().trim());
    }
  }, 60_000);

  test("separate localhost processes exchange signed batches and reuse their keys and nonces after restart", async () => {
    const aDirectory = freshDirectory(), bDirectory = freshDirectory();
    const identities = await Promise.all([setup(aDirectory), setup(bDirectory)]);
    admit(aDirectory, identities); admit(bDirectory, identities);
    const a = await start(aDirectory);
    const bConfig = readJson<NodeConfig>(bDirectory, "config/node.local.json");
    bConfig.peers = [a.address]; bConfig.allowLoopbackPeers = true;
    writeJson(bDirectory, "config/node.local.json", bConfig);
    const b = await start(bDirectory);
    expect(b.frames.find(frame => frame.collectedAt)?.peers).toEqual([{ peer: a.address, ok: true }]);
    for (const node of [a, b]) {
      expect((await fetch(new URL("/healthz", node.address))).status).toBe(200);
      expect((await fetch(new URL("/v1/ready", node.address))).status).toBe(503);
      const reports = await (await fetch(new URL("/v1/reports", node.address))).json() as { reports: SignedBatch[] };
      expect(reports.reports).toHaveLength(2);
      expect(reports.reports.map(report => report.payload.nodeId).sort()).toEqual(identities.map(identity => identity.nodeId).sort());
      expect(reports.reports.every(report => report.payload.observations.length === 0 && report.payload.sequence === 1)).toBe(true);
      const status = await (await fetch(new URL("/v1/status", node.address))).json() as { pyth: string };
      expect(status.pyth).toBe("NOT_PUBLISHED");
    }
    await stop(b);
    const restarted = await start(bDirectory);
    expect(restarted.frames.find(frame => frame.status === "RUNNING")?.nodeId).toBe(identities[1]!.nodeId);
    expect(readJson<NodeIdentity>(bDirectory, "data/node-identity.json")).toEqual(identities[1]!);
    const reports = await (await fetch(new URL("/v1/reports", a.address))).json() as { reports: SignedBatch[] };
    expect(reports.reports.find(report => report.payload.nodeId === identities[1]!.nodeId)?.payload.sequence).toBe(2);
    await stop(restarted); await stop(a);
    const reproduced = await command(bDirectory, "reproduce", "--sequence", "1");
    expect(reproduced.code).toBe(0);
    expect(reproduced.json<{ matches: boolean }>().matches).toBe(true);
    const status = await command(bDirectory, "status");
    expect(status.json<{ history: { valid: boolean; count: number } }>().history).toEqual({ valid: true, count: 2 });
  }, 20_000);

  test("unknown collectors fail before setup writes and credential errors do not create secrets", async () => {
    const directory = freshDirectory();
    const unknown = await command(directory, "setup", "--providers", "unknown-provider");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown collector");
    expect(existsSync(join(directory, "config/node.local.json"))).toBe(false);
    expect(existsSync(join(directory, "data/node-identity.json"))).toBe(false);
    for (const args of [["credentials", "unknown-provider"], ["credentials", "oracle-public"], ["credentials", "aws-pricing", "LAMBDA_API_KEY"]]) {
      expect((await command(directory, ...args)).code).toBe(1);
    }
    const noTerminal = await command(directory, "credentials", "lambda-cloud");
    expect(noTerminal.code).toBe(1);
    expect(noTerminal.stderr).toContain("Credentials require a terminal");
    expect(existsSync(join(directory, ".env"))).toBe(false);
  }, 20_000);

  test("--dir loads only that node's saved credentials while explicit environment values take precedence", async () => {
    const saved = freshDirectory(), overridden = freshDirectory(), foreignCwd = freshDirectory();
    const placeholder = "test-only-not-a-provider-credential";
    for (const directory of [saved, overridden]) {
      writeFileSync(join(directory, ".env"), `LAMBDA_API_KEY="${placeholder}"\n`, { mode: 0o600 });
    }
    const loaded = await commandAt(saved, ["setup", "--providers", "lambda-cloud"], { cwd: foreignCwd });
    expect(loaded.code).toBe(0);
    expect(loaded.json<{ credentials: { variables: { name: string; configured: boolean }[] }[] }>().credentials[0]!.variables)
      .toEqual([{ name: "LAMBDA_API_KEY", configured: true }]);
    const explicit = await commandAt(overridden, ["setup", "--providers", "lambda-cloud"], { cwd: foreignCwd, env: { LAMBDA_API_KEY: "" } });
    expect(explicit.code).toBe(0);
    expect(explicit.json<{ credentials: { variables: { name: string; configured: boolean }[] }[] }>().credentials[0]!.variables)
      .toEqual([{ name: "LAMBDA_API_KEY", configured: false }]);
    expect(loaded.stdout + loaded.stderr + explicit.stdout + explicit.stderr).not.toContain(placeholder);
  }, 20_000);

  test("protected JSON credentials preserve dollar signs, quotes and Unicode without expansion or disclosure", async () => {
    const directory = freshDirectory(), foreignCwd = freshDirectory();
    const credentials = {
      LAMBDA_API_KEY: "test-only-$UNSET_VARIABLE-${EXPANSION}-literal",
      RUNPOD_API_KEY: "test-only-\"double\"-'single'-\\backslash",
      VAST_API_KEY: "test-only-λ-日本語-🔐",
    };
    localCredentials(directory, credentials);
    writeFileSync(join(directory, ".env"), 'LAMBDA_API_KEY="legacy-value-must-not-replace-JSON"\n', { mode: 0o600 });
    const result = await commandAt(directory, ["setup", "--providers", "lambda-cloud,runpod-secure,vast-offers"], {
      cwd: foreignCwd, preload: assertChildEnvironment(directory, credentials),
    });
    expect(result.code).toBe(0);
    const metadata = result.json<{ credentials: { variables: { name: string; configured: boolean }[] }[] }>();
    expect(metadata.credentials.flatMap(item => item.variables)).toEqual([
      { name: "LAMBDA_API_KEY", configured: true },
      { name: "RUNPOD_API_KEY", configured: true },
      { name: "VAST_API_KEY", configured: true },
    ]);
    expect(readJson<typeof credentials>(directory, "data/credentials.json")).toEqual(credentials);
    expect(statSync(join(directory, "data/credentials.json")).mode & 0o777).toBe(0o600);
    for (const value of Object.values(credentials)) expect(result.stdout + result.stderr).not.toContain(value);
  }, 20_000);

  test("explicit environment overrides protected JSON credentials, including deliberately empty values", async () => {
    const foreignCwd = freshDirectory();
    for (const explicit of ['test-process-$literal-"quoted"-λ', ""]) {
      const directory = freshDirectory();
      localCredentials(directory, { LAMBDA_API_KEY: "test-file-value-not-used" });
      const result = await commandAt(directory, ["setup", "--providers", "lambda-cloud"], {
        cwd: foreignCwd, env: { LAMBDA_API_KEY: explicit },
        preload: assertChildEnvironment(directory, { LAMBDA_API_KEY: explicit }),
      });
      expect(result.code).toBe(0);
      expect(result.json<{ credentials: { variables: { name: string; configured: boolean }[] }[] }>().credentials[0]!.variables)
        .toEqual([{ name: "LAMBDA_API_KEY", configured: explicit.length > 0 }]);
      if (explicit) expect(result.stdout + result.stderr).not.toContain(explicit);
      expect(result.stdout + result.stderr).not.toContain("test-file-value-not-used");
    }
  }, 20_000);

  test("protected credential loading rejects non-object files and ignores unknown or non-string entries", async () => {
    const foreignCwd = freshDirectory();
    for (const invalid of [null, [], 42, "not-an-object"]) {
      const directory = freshDirectory();
      localCredentials(directory, invalid);
      const result = await commandAt(directory, ["setup", "--providers", ""], { cwd: foreignCwd });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Invalid local credential file");
      expect(existsSync(join(directory, "config/node.local.json"))).toBe(false);
      expect(existsSync(join(directory, "data/node-identity.json"))).toBe(false);
    }
    const directory = freshDirectory();
    localCredentials(directory, {
      LAMBDA_API_KEY: 123, RUNPOD_API_KEY: null, VAST_API_KEY: true,
      NODE_OPTIONS: "test-unknown-entry", PATH: "test-must-not-replace-path", UNKNOWN_PROVIDER_SECRET: "test-unknown-key",
    });
    const result = await commandAt(directory, ["setup", "--providers", "lambda-cloud,runpod-secure,vast-offers"], {
      cwd: foreignCwd,
      preload: assertChildEnvironment(directory, {
        LAMBDA_API_KEY: null, RUNPOD_API_KEY: null, VAST_API_KEY: null,
        NODE_OPTIONS: null, UNKNOWN_PROVIDER_SECRET: null, PATH: process.env.PATH ?? "/usr/bin:/bin",
      }),
    });
    expect(result.code).toBe(0);
    expect(result.json<{ credentials: { variables: { configured: boolean }[] }[] }>().credentials
      .flatMap(item => item.variables).every(variable => !variable.configured)).toBe(true);
    expect(result.stdout + result.stderr).not.toContain("test-unknown-key");
  }, 30_000);

  test("an enabled authenticated source without a key records NO_KEY and zero observations", async () => {
    const directory = freshDirectory();
    await setup(directory, "lambda-cloud");
    const registry = readJson<Registry>(directory, "config/registry.local.json");
    registry.providers.find(provider => provider.id === "lambda")!.rights.collect = true;
    writeJson(directory, "config/registry.local.json", registry);
    const result = await command(directory, "collect");
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ realObservationCount: 0, sharedObservationCount: 0, publishable: false });
    expect(result.json<{ errors: string[] }>().errors).toEqual(["NO_KEY: LAMBDA_API_KEY is required for lambda-cloud"]);
    const status = await command(directory, "status");
    expect(status.json<{ counts: Record<string, number> }>().counts).toMatchObject({ evidence: 0, captures: 1, candidates: 1, reports: 0 });
  }, 20_000);
});
