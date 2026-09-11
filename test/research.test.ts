// Isolated source fixtures; real provider calls are not part of this suite.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultRegistry, defaultMethodology, type NodeConfig } from "../src/config";
import { collectResearch, researchHealth, validateResearch } from "../src/research";
import { Store } from "../src/store";
import { RECOVERY_MARKER } from "../src/recovery";
import type { SqlDriver } from "../src/journal";
import { NOW } from "./helpers";

const stores: Store[] = [], directories: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function config(): NodeConfig { return { schemaVersion: 1, network: "sbx-mainnet", identityPath: "missing-private-identity.json", databasePath: "data/node.sqlite",
  registryPath: "config/registry.local.json", methodologyPath: "config/methodology.local.json", host: "127.0.0.1", port: 3410,
  intervalMs: 300_000, collectors: ["oracle-public"], peers: [], allowLoopbackPeers: false }; }
function fixture(path = ":memory:") { const store = new Store(path); stores.push(store); return { store, config: config(), registry: defaultRegistry("sbx-mainnet"), methodology: defaultMethodology() }; }
const oracleFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  expect(url.origin).toBe("https://apexapps.oracle.com"); expect(init?.redirect).toBe("manual");
  return new Response(JSON.stringify({ items: [{ partNumber: url.searchParams.get("partNumber"), metricName: "GPU Per Hour",
    currencyCodeLocalizations: [{ currencyCode: "USD", prices: [{ model: "PAY_AS_YOU_GO", value: 14 }] }] }] }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

test("research captures real collector outputs without a signer, reports, snapshots or publication", async () => {
  const f = fixture();
  const result = await collectResearch(f.store, f.config, f.registry, f.methodology, { now: () => NOW, fetch: oracleFetch });
  expect(result.status).toBe("HEALTHY_RESEARCH"); expect(result.observationCount).toBe(4);
  expect(result.publishable).toBe(false); expect(result.liveMarketQualified).toBe(false);
  expect(result.sources[0]).toMatchObject({ id: "oracle-public", fresh: true, count: 4 });
  expect(f.store.db.query("SELECT COUNT(*) AS count FROM captures").get()).toEqual({ count: 1 });
  expect(f.store.db.query("SELECT COUNT(*) AS count FROM reports").get()).toEqual({ count: 0 });
  expect(f.store.db.query("SELECT COUNT(*) AS count FROM snapshots").get()).toEqual({ count: 0 });
  expect(JSON.stringify(result)).not.toContain("14.000000");
});

test("research rejects publishing, peers, authenticated sources and expired rights without external requests", async () => {
  for (const patch of [{ peers: ["https://example.com"] }, { pythManifestPath: "secret.json" }, { collectors: ["runpod-secure"] }, { collectors: [] }, { collectors: ["oracle-public", "oracle-public"] }]) {
    const f = fixture(); expect(() => validateResearch({ ...f.config, ...patch }, f.registry, f.methodology)).toThrow("RESEARCH_ONLY_CONFIGURATION_REQUIRED");
  }
  const f = fixture(); f.registry.providers[0]!.rights.derive = true;
  expect(() => validateResearch(f.config, f.registry, f.methodology)).toThrow();
  f.registry.providers[0]!.rights.derive = false; f.registry.providers[0]!.rights.expiresAt = NOW - 1;
  let requests = 0;
  const result = await collectResearch(f.store, f.config, f.registry, f.methodology, { now: () => NOW, fetch: (async () => { requests++; throw new Error("FORBIDDEN"); }) as unknown as typeof fetch });
  expect(requests).toBe(0); expect(result.status).toBe("DEGRADED"); expect(result.errorCount).toBe(1);
});

test("research transport rejects unadmitted hosts and honors existing Retry-After across cycles", async () => {
  const f = fixture(); f.registry.providers[0]!.allowedHosts = [];
  let requests = 0;
  const fetch = (async () => { requests++; return new Response(null, { status: 429, headers: { "retry-after": "900" } }); }) as unknown as typeof globalThis.fetch;
  const denied = await collectResearch(f.store, f.config, f.registry, f.methodology, { now: () => NOW, fetch });
  expect(requests).toBe(0); expect(denied.status).toBe("DEGRADED");
  const allowed = fixture();
  await collectResearch(allowed.store, allowed.config, allowed.registry, allowed.methodology, { now: () => NOW, fetch });
  const backoff = await collectResearch(allowed.store, allowed.config, allowed.registry, allowed.methodology, { now: () => NOW + 300_000, fetch });
  expect(requests).toBe(1); expect(backoff.status).toBe("DEGRADED"); expect(backoff.sources[0]!.fresh).toBe(false);
});

test("health catches stopped collection, source loss, future times, and corrupt or oversized captures", async () => {
  const f = fixture(); expect(researchHealth(f.store.db, f.config, f.methodology, NOW).status).toBe("DEGRADED");
  await collectResearch(f.store, f.config, f.registry, f.methodology, { now: () => NOW, fetch: oracleFetch });
  expect(researchHealth(f.store.db, f.config, f.methodology, NOW + 720_001).reasons).toContain("CAPTURE_STALE_OR_FUTURE");
  expect(researchHealth(f.store.db, f.config, f.methodology, NOW - 1).reasons).toContain("CAPTURE_STALE_OR_FUTURE");
  expect(researchHealth(f.store.db, { ...f.config, collectors: ["oracle-public", "verda-public"] }, f.methodology, NOW).reasons).toContain("SOURCE_MISSING_STALE_OR_FUTURE");
  f.store.db.query("UPDATE captures SET errors=?").run(JSON.stringify(["PRIVATE_PROVIDER_ERROR"]));
  const errors = researchHealth(f.store.db, f.config, f.methodology, NOW); expect(errors.reasons).toContain("COLLECTION_ERRORS"); expect(JSON.stringify(errors)).not.toContain("PRIVATE_PROVIDER_ERROR");
  f.store.db.query("UPDATE captures SET observations='private-invalid-json'").run();
  expect(researchHealth(f.store.db, f.config, f.methodology, NOW).reasons).toContain("CAPTURE_INVALID");
  f.store.db.query("UPDATE captures SET observations=?").run("x".repeat(4 * 1024 * 1024 + 1));
  expect(researchHealth(f.store.db, f.config, f.methodology, NOW).reasons).toContain("CAPTURE_SIZE_INVALID");
});

test("research refuses chunked journals before requests or captures, so a clean final chunk cannot hide errors", async () => {
  const f = fixture();
  await collectResearch(f.store, f.config, f.registry, f.methodology, { now: () => NOW, fetch: oracleFetch });
  f.store.db.exec("CREATE TABLE local_journal_storage(id INTEGER,version TEXT)");
  const before = f.store.db.query("SELECT * FROM captures").all();
  expect(() => researchHealth(f.store.db, f.config, f.methodology, NOW)).toThrow("RESEARCH_REQUIRES_ORDINARY_JOURNAL");
  let requests = 0;
  await expect(collectResearch(f.store, f.config, f.registry, f.methodology, { now: () => NOW, fetch: (async () => { requests++; throw new Error("FORBIDDEN"); }) as unknown as typeof fetch })).rejects.toThrow("RESEARCH_REQUIRES_ORDINARY_JOURNAL");
  expect(requests).toBe(0); expect(f.store.db.query("SELECT * FROM captures").all()).toEqual(before);
});

test("research CLI ignores poisoned credential files, enforces recovery review and leaves health reads unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "sbx-research-test-")); directories.push(root);
  mkdirSync(join(root, "config")); mkdirSync(join(root, "data"));
  const f = fixture(join(root, "data/node.sqlite"));
  for (const [name, value] of [["node", f.config], ["registry", f.registry], ["methodology", f.methodology]] as const) writeFileSync(join(root, `config/${name}.local.json`), JSON.stringify(value));
  const poison = "PRIVATE_CREDENTIAL_FILE_MUST_NOT_LOAD";
  writeFileSync(join(root, "data/credentials.json"), poison); writeFileSync(join(root, ".env"), `RUNPOD_API_KEY=${poison}`);
  const preload = join(root, "fixture.ts");
  writeFileSync(preload, `globalThis.fetch = async input => { const url = new URL(String(input)); if(url.origin !== 'https://apexapps.oracle.com')throw Error('FORBIDDEN');
    return new Response(JSON.stringify({items:[{partNumber:url.searchParams.get('partNumber'),metricName:'GPU Per Hour',currencyCodeLocalizations:[{currencyCode:'USD',prices:[{model:'PAY_AS_YOU_GO',value:14}]}]}]})); };
    process.on('exit',()=>{if(process.env.RUNPOD_API_KEY!==undefined)process.exitCode=91;});`);
  const command = (name: string, extra: string[] = []) => spawnSync(process.execPath, ["--no-env-file", "--preload", preload, resolve(import.meta.dir, "../src/cli.ts"), name, "--dir", root, ...extra],
    { cwd: root, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10_000 });
  const collected = command("research-collect"); expect(collected.status).toBe(0); expect(JSON.parse(collected.stdout).status).toBe("HEALTHY_RESEARCH");
  expect(readFileSync(join(root, "data/credentials.json"), "utf8")).toBe(poison);
  const before = f.store.db.query("SELECT * FROM captures").all();
  const health = command("research-health"); expect(health.status).toBe(0); expect(health.stdout).not.toContain(poison);
  expect(f.store.db.query("SELECT * FROM captures").all()).toEqual(before);
  const readOnly = new Database(join(root, "data/node.sqlite"), { readonly: true });
  try { expect(researchHealth(readOnly as unknown as SqlDriver, f.config, f.methodology).status).toBe("HEALTHY_RESEARCH"); } finally { readOnly.close(); }
  writeFileSync(join(root, RECOVERY_MARKER), "review-pending");
  expect(command("research-collect").stderr).toContain("RECOVERY_REVIEW_REQUIRED");
  expect(command("research-health").status).toBe(0);
  expect(f.store.db.query("SELECT * FROM captures").all()).toEqual(before);
});
