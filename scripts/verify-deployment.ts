/** Public read checks and empty recovery-route denial probes for the development network. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultMethodology, defaultRegistry } from "../src/config";
import { hash } from "../src/crypto";
import { fromMicros, median, toMicros, weighted } from "../src/decimal";
import { demoRegistry } from "../src/demo";
import type { Feed, Methodology, Registry } from "../src/types";
import { parseMethodology, parseRegistry } from "../src/validation";

type RecordValue = Record<string, unknown>;
const MODELS = ["B200", "B300", "GB200", "GB300"];
const MAX_BYTES = 2_000_000;
// The reviewed browser rejects older response calculations independently of source age.
const DEMO_SNAPSHOT_MAX_AGE_MS = 120_000;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function record(value: unknown, label: string): RecordValue {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${label}: expected an object`);
  return value as RecordValue;
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function origin(value: string): URL {
  const url = new URL(value);
  requireValue(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "Verification URLs must be HTTPS host roots without credentials, paths or query strings");
  return url;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "Verification failed";
}

function exactKeys(value: RecordValue, keys: string[], label: string): void {
  requireValue(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), `${label}: unexpected or missing fields`);
}
const sameMembers = (actual: string[], expected: string[]) => actual.length === expected.length && [...actual].sort().join("\n") === [...expected].sort().join("\n");

/** Public demo contract only: does not authenticate private captures or grant oracle approval. */
export function validateDemo(value: unknown, policy: { registry: Registry; methodology: Methodology; now: number }) {
  const data = record(value, "demo"), { methodology, now } = policy, registry = demoRegistry(policy.registry);
  requireValue(positiveInteger(now) && positiveInteger(methodology.maxAgeMs) && Number.isSafeInteger(methodology.futureToleranceMs) && methodology.futureToleranceMs >= 0, "Invalid local demo time policy");
  exactKeys(data, ["schemaVersion", "network", "calculatedAt", "methodologyVersion", "methodologyHash", "registryHash", "publishable", "mode", "pythPublished", "feeds", "inputBatchHashes", "rejected"], "demo");
  requireValue(data.schemaVersion === 1 && data.network === registry.network && data.mode === "CENTRALIZED_DEMO" && data.publishable === false && data.pythPublished === false, "Demo scope or non-publishing flags are invalid");
  requireValue(data.registryHash === hash(registry) && data.methodologyVersion === `${methodology.version}-centralized-demo` && data.methodologyHash === hash({ basis: methodology, mode: "CENTRALIZED_DEMO", weights: "equal available provider groups; equal four models" }), "Demo does not match the reviewed local policy hashes");
  requireValue(Array.isArray(data.inputBatchHashes) && data.inputBatchHashes.length === 0 && Array.isArray(data.rejected) && data.rejected.length === 0, "Demo must not expose private batch references");
  const current = (time: unknown): time is number => positiveInteger(time) && BigInt(time) <= BigInt(now) + BigInt(methodology.futureToleranceMs) && BigInt(now) - BigInt(time) <= BigInt(methodology.maxAgeMs);
  requireValue(current(data.calculatedAt) && BigInt(now) - BigInt(data.calculatedAt) <= BigInt(Math.min(methodology.maxAgeMs, DEMO_SNAPSHOT_MAX_AGE_MS)), "Demo calculation is stale or future-dated");
  const calculatedAt = data.calculatedAt;
  requireValue(registry.providers.length <= 200 && Array.isArray(data.feeds) && data.feeds.length === registry.providers.length * MODELS.length + MODELS.length + 1, "Demo feed coverage is missing or exceeds the local policy");
  const expectedIds = ["SBX", ...MODELS.map(model => `SBX:${model}`), ...registry.providers.flatMap(provider => MODELS.map(model => `SBX:${provider.id}:${model}`))];
  const feeds = data.feeds.map(value => {
    const feed = record(value, "demo feed");
    exactKeys(feed, ["id", "kind", "model", "provider", "status", "price", "confidence", "observedAt", "calculatedAt", "reasons", "contributors", "weights"], "demo feed");
    requireValue(typeof feed.id === "string" && expectedIds.includes(feed.id) && feed.calculatedAt === calculatedAt && feed.confidence === null, "Invalid demo feed identity, time or confidence");
    requireValue(Array.isArray(feed.reasons) && feed.reasons.length <= 1 && feed.reasons.every(reason => reason === "NO_CURRENT_APPROVED_PRICE"), "Invalid demo availability reason");
    requireValue(Array.isArray(feed.contributors) && feed.contributors.length <= 200 && feed.contributors.every(item => typeof item === "string" && item.length <= 128) && new Set(feed.contributors).size === feed.contributors.length, "Invalid demo contributors");
    const weights = record(feed.weights, "demo weights");
    requireValue(Object.keys(weights).length <= 200 && Object.entries(weights).every(([key, weight]) => key.length <= 128 && weight === 1), "Invalid demo weights");
    if (feed.status === "READY") {
      requireValue(typeof feed.price === "string" && feed.price.length <= 24 && fromMicros(toMicros(feed.price)) === feed.price, "Demo price must be an exact positive six-decimal value");
      requireValue(current(feed.observedAt) && BigInt(feed.observedAt) <= BigInt(calculatedAt) + BigInt(methodology.futureToleranceMs) && BigInt(calculatedAt) - BigInt(feed.observedAt) <= BigInt(methodology.maxAgeMs) && feed.reasons.length === 0 && feed.contributors.length > 0, "Ready demo price has inconsistent source time or availability metadata");
    } else requireValue(feed.status === "UNAVAILABLE" && feed.price === null && feed.observedAt === null && feed.reasons.length === 1 && feed.contributors.length === 0, "Unavailable demo feed must contain no price or source time");
    return feed as unknown as Feed;
  });
  requireValue(new Set(feeds.map(feed => feed.id)).size === feeds.length && sameMembers(feeds.map(feed => feed.id), expectedIds), "Demo feeds are duplicated or missing");
  const byId = new Map(feeds.map(feed => [feed.id, feed]));
  for (const provider of registry.providers) for (const model of MODELS) {
    const feed = byId.get(`SBX:${provider.id}:${model}`)!;
    requireValue(feed.kind === "PROVIDER" && feed.provider === provider.id && feed.model === model && Object.keys(feed.weights).length === 0, "Invalid demo provider dimensions");
    if (feed.status === "READY") requireValue(provider.rights.collect && provider.rights.derive && provider.rights.redistribute && (provider.rights.expiresAt === null || provider.rights.expiresAt > now) && sameMembers(feed.contributors, [provider.id]), "Ready demo provider lacks current demo display permission");
  }
  for (const model of MODELS) {
    const feed = byId.get(`SBX:${model}`)!;
    requireValue(feed.kind === "MODEL" && feed.model === model && feed.provider === null, "Invalid demo model dimensions");
    const providers = registry.providers.filter(provider => byId.get(`SBX:${provider.id}:${model}`)!.status === "READY");
    const groups = [...new Set(providers.map(provider => provider.economicGroup))];
    requireValue(feed.status === (groups.length ? "READY" : "UNAVAILABLE") && sameMembers(Object.keys(feed.weights), groups) && sameMembers(feed.contributors, groups), "Demo model availability or economic-group weights do not reconcile");
    if (groups.length) {
      const price = weighted(groups.map(group => ({ weight: 1, price: median(providers.filter(provider => provider.economicGroup === group).map(provider => toMicros(byId.get(`SBX:${provider.id}:${model}`)!.price!))) })));
      requireValue(feed.price === fromMicros(price) && feed.observedAt === Math.min(...providers.map(provider => byId.get(`SBX:${provider.id}:${model}`)!.observedAt!)), "Demo model price or oldest source time does not reconcile");
    }
  }
  const composite = byId.get("SBX")!, models = MODELS.map(model => byId.get(`SBX:${model}`)!), complete = models.every(feed => feed.status === "READY");
  requireValue(composite.kind === "COMPOSITE" && composite.model === null && composite.provider === null && sameMembers(Object.keys(composite.weights), MODELS) && composite.status === (complete ? "READY" : "UNAVAILABLE"), "Demo composite dimensions, coverage or weights are invalid");
  if (complete) requireValue(composite.price === fromMicros(weighted(models.map(feed => ({ price: toMicros(feed.price!), weight: 1 })))) && composite.observedAt === Math.min(...models.map(feed => feed.observedAt!)) && sameMembers(composite.contributors, models.map(feed => feed.id)), "Demo composite does not reconcile to all four current models");
  const readyProviders = feeds.filter(feed => feed.kind === "PROVIDER" && feed.status === "READY").length;
  requireValue(readyProviders > 0, "Demo has no current provider prices");
  return { mode: "CENTRALIZED_DEMO", calculatedAt, registryHash: data.registryHash, methodologyHash: data.methodologyHash, feedCount: feeds.length, readyProviders, readyModels: models.filter(feed => feed.status === "READY").length, compositeStatus: composite.status, publishable: false, pythPublished: false };
}

export async function verifyDeployment(args: string[] = process.argv.slice(2), requestFetch: typeof fetch = fetch): Promise<RecordValue | undefined> {
  const { values } = parseArgs({ args, options: {
    release: { type: "string" }, index: { type: "string", default: "https://blackwellindex.com" },
    altx: { type: "string", default: "https://altx.exchange" }, primary: { type: "string", default: "https://primary.blackwellindex.com" },
    secondary: { type: "string", default: "https://secondary.blackwellindex.com" },
    aliases: { type: "string", default: "https://blackwell.fyi,https://blackwell.today" },
    "timeout-ms": { type: "string", default: "15000" }, "max-age-ms": { type: "string", default: "900000" },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("bun scripts/verify-deployment.ts --release <40-character commit SHA> [--index HTTPS_ORIGIN] [--altx HTTPS_ORIGIN] [--primary HTTPS_ORIGIN] [--secondary HTTPS_ORIGIN] [--aliases HTTPS_ORIGIN,HTTPS_ORIGIN] [--timeout-ms 15000] [--max-age-ms 900000]\n\nPublic GET checks and empty POST denial probes on recovery paths. Verifies local public assets and the current non-publishing development-network contract. No credentials, TLS bypass or provider calls; never contacts the authenticated recovery binding.");
    return;
  }
  requireValue(values.release && /^[a-f0-9]{40}$/.test(values.release), "--release requires the exact 40-character lowercase commit SHA");
  requireValue(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0", "TLS verification must not be disabled");
  const timeoutMs = Number(values["timeout-ms"]), maxAgeMs = Number(values["max-age-ms"]);
  requireValue(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 30_000, "--timeout-ms must be between 1000 and 30000");
  requireValue(Number.isInteger(maxAgeMs) && maxAgeMs >= 30_000 && maxAgeMs <= 3_600_000, "--max-age-ms must be between 30000 and 3600000");
  const index = origin(values.index!), altx = origin(values.altx!), primary = origin(values.primary!), secondary = origin(values.secondary!);
  const aliases = values.aliases!.split(",").map(value => origin(value.trim()));
  requireValue(aliases.length === 2 && new Set(aliases.map(url => url.origin)).size === 2, "Exactly two distinct alias origins are required");
  requireValue(primary.origin !== secondary.origin, "Primary and secondary origins must differ");
  const startedAt = Date.now(), deadline = AbortSignal.timeout(120_000), publicDir = resolve(import.meta.dir, "../public");
  const localConfigBytes = readFileSync(resolve(import.meta.dir, "../wrangler.jsonc"));
  requireValue(localConfigBytes.length <= MAX_BYTES, "Local deployment policy exceeds verifier byte limit");
  const localVars = record(record(JSON.parse(localConfigBytes.toString("utf8")), "local deployment config").vars, "local deployment variables");
  requireValue(typeof localVars.SBX_NETWORK === "string", "Local deployment network is missing");
  const registry = parseRegistry(typeof localVars.SBX_REGISTRY_JSON === "string" ? JSON.parse(localVars.SBX_REGISTRY_JSON) : defaultRegistry(localVars.SBX_NETWORK));
  const methodology = parseMethodology(typeof localVars.SBX_METHODOLOGY_JSON === "string" ? JSON.parse(localVars.SBX_METHODOLOGY_JSON) : defaultMethodology());
  requireValue(registry.network === localVars.SBX_NETWORK, "Local deployment network differs from registry");
  const failures: { check: string; error: string }[] = [];
  const assets: { url: string; bytes: number; sha256: string }[] = [];
  const redirects: { url: string; status: number; location: string }[] = [];
  const nodes: RecordValue[] = [];
  const demos: RecordValue[] = [];
  const deniedStatuses: Record<string, number> = {};
  let checks = 0, privateRoutesChecked = 0;

  async function request(url: URL, readBody = true, method:"GET"|"POST"="GET") {
    const response = await requestFetch(url, { method, redirect: "manual", headers: { "user-agent": "blackwell-index-release-verifier/0.1", "cache-control": "no-cache" }, signal: AbortSignal.any([deadline, AbortSignal.timeout(timeoutMs)]) });
    if (!readBody) { await response.body?.cancel(); return { status: response.status, headers: response.headers, bytes: new Uint8Array() }; }
    const reader = response.body?.getReader();
    requireValue(reader && Number(response.headers.get("content-length") ?? 0) <= MAX_BYTES, "Missing or oversized response body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        requireValue(size <= MAX_BYTES, "Response exceeds verifier byte limit");
        chunks.push(part.value);
      }
    } catch (error) { await reader.cancel(); throw error; }
    finally { reader.releaseLock(); }
    return { status: response.status, headers: response.headers, bytes: new Uint8Array(Buffer.concat(chunks)) };
  }
  async function json(url: URL, expectedStatus = 200): Promise<RecordValue> {
    const response = await request(url);
    requireValue(response.status === expectedStatus, `${url.pathname}: HTTP ${response.status}, expected ${expectedStatus}`);
    requireValue(response.headers.get("content-type")?.includes("application/json"), `${url.pathname}: expected JSON content type`);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes)); }
    catch { throw new Error(`${url.pathname}: invalid JSON`); }
    return record(value, url.pathname);
  }
  async function check(label: string, action: () => Promise<void>): Promise<void> {
    checks++;
    try { await action(); } catch (error) { failures.push({ check: label, error: errorMessage(error) }); }
  }
  async function asset(base: URL, path: string, file: string) {
    const url = new URL(path, base), local = readFileSync(resolve(publicDir, file)), response = await request(url);
    requireValue(response.status === 200, `Asset returned HTTP ${response.status}`);
    requireValue(sha256(response.bytes) === sha256(local), `Deployed bytes differ from public/${file}`);
    assets.push({ url: url.toString(), bytes: response.bytes.length, sha256: sha256(response.bytes) });
  }
  async function node(base: URL, retainIdentity = true) {
    const [status, snapshot, ready, reports, health] = await Promise.all([
      json(new URL("/v1/status", base)), json(new URL("/v1/feeds", base)), json(new URL("/v1/ready", base), 503),
      json(new URL("/v1/reports", base)), json(new URL("/healthz", base)),
    ]);
    const hosting = record(status.hosting, "hosting"), collection = record(status.collection, "collection"), cycle = record(collection.lastCycle, "last completed collection");
    requireValue(typeof status.nodeId === "string" && /^[a-f0-9]{64}$/.test(status.nodeId), "Invalid node identity");
    requireValue(typeof status.publicKey === "string" && sha256(status.publicKey) === status.nodeId, "Node ID does not bind its public key");
    requireValue(hosting.release === values.release, "Hosted release does not match --release");
    requireValue(hosting.runtime === "cloudflare-durable-object" && hosting.operatorGroupCount === 1, "Expected one controlling Cloudflare operator group");
    requireValue(typeof hosting.operatorGroup === "string" && hosting.operatorGroup.length > 0, "Missing operator group");
    requireValue(status.methodologyStatus === "DRAFT" && status.pyth === "NOT_PUBLISHED", "Unexpected methodology or Pyth publication state");
    requireValue(status.registryHash === hash(registry) && status.methodologyHash === hash(methodology), "Oracle policy differs from the reviewed local deployment configuration");
    requireValue(health.status === "RUNNING", "Process is not running");
    requireValue(collection.status === "COMPLETE" || collection.status === "RUNNING", "Collection is failed, idle or absent");
    requireValue(positiveInteger(cycle.startedAt) && positiveInteger(cycle.collectedAt) && cycle.startedAt <= cycle.collectedAt, "Invalid completed-cycle timestamps");
    const now = Date.now();
    requireValue(cycle.collectedAt <= now + 10_000 && now - cycle.collectedAt <= maxAgeMs, "Latest completed collection is stale or future-dated");
    if (collection.status === "COMPLETE") requireValue(positiveInteger(collection.completedAt) && collection.completedAt >= cycle.collectedAt, "Collection completion time is missing or inconsistent");
    requireValue(positiveInteger(cycle.realObservationCount) && cycle.sharedObservationCount === 0 && cycle.publishable === false, "Expected real private observations and no publication");
    requireValue(Array.isArray(cycle.models) && [...cycle.models].sort().join(",") === MODELS.join(","), "Latest collection does not cover all four Blackwell models");
    requireValue(Array.isArray(cycle.sources) && cycle.sources.length > 0, "Missing per-source collection diagnostics");
    const sources = cycle.sources.map(value => {
      const source = record(value, "source");
      requireValue(typeof source.collector === "string" && typeof source.status === "string" && typeof source.observations === "number" && Number.isSafeInteger(source.observations) && source.observations >= 0 && typeof source.errors === "number" && Number.isSafeInteger(source.errors) && source.errors >= 0, "Invalid source diagnostic");
      return { collector: source.collector, status: source.status, observations: source.observations, errors: source.errors };
    });
    requireValue(sources.reduce((total, source) => total + source.observations, 0) === cycle.realObservationCount, "Source counts do not reconcile to real observations");
    requireValue(sources.every(source => source.errors === 0 && source.status === "COLLECTED"), "One or more configured sources failed or degraded");
    requireValue(snapshot.publishable === false && ready.publishable === false, "Development benchmark is unexpectedly publishable");
    requireValue(snapshot.registryHash === status.registryHash && snapshot.methodologyHash === status.methodologyHash, "Status and feed configuration hashes differ");
    requireValue(Array.isArray(snapshot.feeds) && snapshot.feeds.length > 0, "Feed response is empty or invalid");
    const feeds = snapshot.feeds.map(value => record(value, "feed"));
    requireValue(feeds.every(feed => feed.price === null && feed.confidence === null && feed.observedAt === null && feed.status === "UNAVAILABLE"), "A development feed contains a value or is marked ready");
    const ids = feeds.map(feed => feed.id);
    requireValue(new Set(ids).size === ids.length && ["SBX", ...MODELS.map(model => `SBX:${model}`)].every(id => ids.includes(id)), "Expected unique SBX and four model feeds");
    requireValue(Array.isArray(reports.reports) && reports.reports.length === 0, "Public reports are not empty");
    if (retainIdentity) nodes.push({ url: base.origin, nodeId: status.nodeId, publicKey: status.publicKey, release: hosting.release, operatorGroup: hosting.operatorGroup,
      collectionStatus: collection.status, collectedAt: cycle.collectedAt, realObservationCount: cycle.realObservationCount,
      sharedObservationCount: cycle.sharedObservationCount, models: cycle.models, sources, feedCount: feeds.length, publishable: false });
  }

  const tasks: (() => Promise<void>)[] = [
    ...[[index, "/", "index.html"], [altx, "/", "altx/index.html"], [index, "/assets/index.js", "assets/index.js"],
      [index, "/assets/site.css", "assets/site.css"], [altx, "/assets/site.css", "assets/site.css"], [index, "/methodology.html", "methodology.html"],
      [index, "/providers.html", "providers.html"], [index, "/assets/mode.js", "assets/mode.js"],
      [index, "/?mode=demo", "index.html"], [index, "/?mode=real", "index.html"]]
      .map(([base, path, file]) => () => check(`asset ${new URL(path as string, base as URL)}`, () => asset(base as URL, path as string, file as string))),
    ...[index, altx, primary, secondary].map(base => () => check(`demo ${base.origin}`, async () => {
      const demo = validateDemo(await json(new URL("/v1/demo", base)), { registry, methodology, now: Date.now() });
      demos.push({ url: base.origin, ...demo });
    })),
    ...[primary, secondary].map(base => () => check(`node ${base.origin}`, () => node(base))),
    () => check(`public index API ${index.origin}`, () => node(index, false)),
    ...aliases.map(base => () => check(`alias ${base.origin}`, async () => {
      const path = "/methodology.html?verification=path%2Fquery&keep=1", url = new URL(path, base), response = await request(url, false), expected = new URL(path, index).toString();
      requireValue(response.status === 308 && response.headers.get("location") === expected, "Alias must return 308 preserving the exact path and query");
      redirects.push({ url: url.toString(), status: response.status, location: expected });
    })),
  ];
  const privatePaths = ["/internal/wake", "/internal/", "/v1/evidence", "/v1/captures", "/data/credentials.json", "/data/node-identity.json", "/data/node.sqlite", "/.env", "/config/node.local.json", "/node/unapproved/v1/status",
    "/exportRecovery", "/v1/exportRecovery", "/internal/exportRecovery", "/v1/recovery", "/node/primary/exportRecovery", "/internal/export-recovery", "/node/primary/internal/export-recovery",
    "/internal/archive/begin", "/node/primary/internal/archive/begin"];
  for (const base of [index, altx, primary, secondary]) for (const path of privatePaths) tasks.push(() => check(`private route ${base.origin}${path}`, async () => {
    // Do not read, print or persist a body from a route that must remain private.
    const response = await request(new URL(path, base), false);
    requireValue([401, 403, 404, 405, 410].includes(response.status), `Private route returned HTTP ${response.status}; expected an explicit denial or absence`);
    privateRoutesChecked++; deniedStatuses[String(response.status)] = (deniedStatuses[String(response.status)] ?? 0) + 1;
  }));
  // The internal export accepts POST, so GET denial alone does not prove its public isolation.
  for(const base of [index,altx,primary,secondary])for(const path of ["/internal/export-recovery","/node/primary/internal/export-recovery","/internal/archive/begin","/node/primary/internal/archive/begin"])
    tasks.push(()=>check(`private POST ${base.origin}${path}`,async()=>{
      const response=await request(new URL(path,base),false,"POST");
      requireValue([401,403,404,405,410].includes(response.status),`Private POST returned HTTP ${response.status}; expected explicit denial or absence`);
      privateRoutesChecked++;deniedStatuses[String(response.status)]=(deniedStatuses[String(response.status)]??0)+1;
    }));
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (next < tasks.length) await tasks[next++]!(); }));
  await check("node independence and public-site routing", async () => {
    requireValue(nodes.length === 2, "Both nodes must pass before identity comparison");
    requireValue(nodes[0]!.nodeId !== nodes[1]!.nodeId && nodes[0]!.publicKey !== nodes[1]!.publicKey, "Hosted nodes reuse an identity");
    requireValue(nodes[0]!.operatorGroup === nodes[1]!.operatorGroup, "Same-account hosted nodes claim independent operator groups");
    const primaryNode = nodes.find(value => value.url === primary.origin)!;
    const publicStatus = await json(new URL("/v1/status", index));
    requireValue(publicStatus.nodeId === primaryNode.nodeId && record(publicStatus.hosting, "site hosting").release === values.release, "Public index site does not route to the expected primary release");
  });
  return { status: failures.length ? "FAIL" : "PASS", mode: "DEVELOPMENT_NETWORK", expectedRelease: values.release,
    checkedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, checks, failures,
    assets: assets.sort((a, b) => a.url.localeCompare(b.url)), nodes: nodes.sort((a, b) => String(a.url).localeCompare(String(b.url))),
    demos: demos.sort((a, b) => String(a.url).localeCompare(String(b.url))),
    aliases: redirects.sort((a, b) => a.url.localeCompare(b.url)), privateRoutes: { checked: privateRoutesChecked, statuses: deniedStatuses },
    limitations: ["Read-only point-in-time acceptance; not proof of future uptime, source rights, independent operators or Pyth publication.", "Centralized demo prices are separate from unavailable oracle feeds; public aggregate checks do not independently authenticate private capture evidence."] };
}

if (import.meta.main) verifyDeployment().then(result => {
  if (result) { console.log(JSON.stringify(result, null, 2)); if (result.status === "FAIL") process.exitCode = 1; }
}).catch(error => {
  console.log(JSON.stringify({ status: "FAIL", mode: "DEVELOPMENT_NETWORK", error: errorMessage(error) }));
  process.exitCode = 1;
});
