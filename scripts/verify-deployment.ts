/** Read-only acceptance checks for the deliberately non-publishing development network. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

type RecordValue = Record<string, unknown>;
const MODELS = ["B200", "B300", "GB200", "GB300"];
const MAX_BYTES = 2_000_000;
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

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    release: { type: "string" }, index: { type: "string", default: "https://blackwellindex.com" },
    altx: { type: "string", default: "https://altx.exchange" }, primary: { type: "string", default: "https://primary.blackwellindex.com" },
    secondary: { type: "string", default: "https://secondary.blackwellindex.com" },
    aliases: { type: "string", default: "https://blackwell.fyi,https://blackwell.today" },
    "timeout-ms": { type: "string", default: "15000" }, "max-age-ms": { type: "string", default: "900000" },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("bun scripts/verify-deployment.ts --release <40-character commit SHA> [--index HTTPS_ORIGIN] [--altx HTTPS_ORIGIN] [--primary HTTPS_ORIGIN] [--secondary HTTPS_ORIGIN] [--aliases HTTPS_ORIGIN,HTTPS_ORIGIN] [--timeout-ms 15000] [--max-age-ms 900000]\n\nGET only. Verifies local public assets and the current non-publishing development-network contract. No credentials, TLS bypass, provider calls or writes.");
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
  const failures: { check: string; error: string }[] = [];
  const assets: { url: string; bytes: number; sha256: string }[] = [];
  const redirects: { url: string; status: number; location: string }[] = [];
  const nodes: RecordValue[] = [];
  const deniedStatuses: Record<string, number> = {};
  let checks = 0, privateRoutesChecked = 0;

  async function request(url: URL, readBody = true) {
    const response = await fetch(url, { method: "GET", redirect: "manual", headers: { "user-agent": "blackwell-index-release-verifier/0.1", "cache-control": "no-cache" }, signal: AbortSignal.any([deadline, AbortSignal.timeout(timeoutMs)]) });
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
      [index, "/assets/site.css", "assets/site.css"], [altx, "/assets/site.css", "assets/site.css"], [index, "/methodology.html", "methodology.html"]]
      .map(([base, path, file]) => () => check(`asset ${new URL(path as string, base as URL)}`, () => asset(base as URL, path as string, file as string))),
    ...[primary, secondary].map(base => () => check(`node ${base.origin}`, () => node(base))),
    () => check(`public index API ${index.origin}`, () => node(index, false)),
    ...aliases.map(base => () => check(`alias ${base.origin}`, async () => {
      const path = "/methodology.html?verification=path%2Fquery&keep=1", url = new URL(path, base), response = await request(url, false), expected = new URL(path, index).toString();
      requireValue(response.status === 308 && response.headers.get("location") === expected, "Alias must return 308 preserving the exact path and query");
      redirects.push({ url: url.toString(), status: response.status, location: expected });
    })),
  ];
  const privatePaths = ["/internal/wake", "/internal/", "/v1/evidence", "/v1/captures", "/data/credentials.json", "/data/node-identity.json", "/data/node.sqlite", "/.env", "/config/node.local.json", "/node/unapproved/v1/status",
    "/exportRecovery", "/v1/exportRecovery", "/internal/exportRecovery", "/v1/recovery", "/node/primary/exportRecovery"];
  for (const base of [index, altx, primary, secondary]) for (const path of privatePaths) tasks.push(() => check(`private route ${base.origin}${path}`, async () => {
    // Do not read, print or persist a body from a route that must remain private.
    const response = await request(new URL(path, base), false);
    requireValue([401, 403, 404, 405, 410].includes(response.status), `Private route returned HTTP ${response.status}; expected an explicit denial or absence`);
    privateRoutesChecked++; deniedStatuses[String(response.status)] = (deniedStatuses[String(response.status)] ?? 0) + 1;
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
  console.log(JSON.stringify({ status: failures.length ? "FAIL" : "PASS", mode: "DEVELOPMENT_NETWORK", expectedRelease: values.release,
    checkedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, checks, failures,
    assets: assets.sort((a, b) => a.url.localeCompare(b.url)), nodes: nodes.sort((a, b) => String(a.url).localeCompare(String(b.url))),
    aliases: redirects.sort((a, b) => a.url.localeCompare(b.url)), privateRoutes: { checked: privateRoutesChecked, statuses: deniedStatuses },
    limitations: ["Read-only point-in-time acceptance; not proof of future uptime, source rights, independent operators or Pyth publication."] }, null, 2));
  if (failures.length) process.exitCode = 1;
}

if (import.meta.main) main().catch(error => {
  console.log(JSON.stringify({ status: "FAIL", mode: "DEVELOPMENT_NETWORK", error: errorMessage(error) }));
  process.exitCode = 1;
});
