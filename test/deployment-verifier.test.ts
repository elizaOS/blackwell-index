// Isolated synthetic prices and HTTP responses only; no provider or deployed endpoint calls.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateDemo, verifyDeployment } from "../scripts/verify-deployment";
import { defaultMethodology, defaultRegistry } from "../src/config";
import { hash, nodeIdFor } from "../src/crypto";
import { centralizedDemo, demoRegistry } from "../src/demo";
import { MODELS, type Observation } from "../src/types";

const NOW = 1788723000000, RELEASE = "a".repeat(40), PRIVATE = "private-body-must-not-be-reported";
const registry = defaultRegistry("sbx-mainnet"), methodology = defaultMethodology();
const unusedIdentity = { nodeId: "synthetic-unused", publicKey: "synthetic-unused", privateKeyPem: "synthetic-unused" };
function observations(now: number): Observation[] {
  return MODELS.map((model, index) => ({ schemaVersion: 1, provider: "oracle", source: "oracle-public", sku: model, model, region: "us", procurement: "ON_DEMAND", priceBasis: "LIST", tenancy: "EXCLUSIVE", currency: "USD", unit: "USD_PER_GPU_HOUR", price: `${index + 1}.000000`, instancePrice: `${(index + 1) * 8}.000000`, gpuCount: 8, includes: [], availableGpuCount: null, observedAt: now - 1000, priceEffectiveAt: null, expiresAt: null, sourceUrl: "https://apexapps.oracle.com/prices", evidenceHash: "b".repeat(64) }));
}
const demo = (now = NOW, inputs = observations(now), policy = methodology) => centralizedDemo(inputs, demoRegistry(registry), policy, unusedIdentity, now);
const validate = (value: unknown, now = NOW, policy = methodology) => validateDemo(value, { registry, methodology: policy, now });

test("demo acceptance binds local demo policy separately from unpublished oracle policy", () => {
  const value = demo(), result = validate(value);
  expect(result.readyProviders).toBe(4); expect(result.readyModels).toBe(4); expect(result.compositeStatus).toBe("READY");
  expect(result.publishable).toBe(false); expect(result.pythPublished).toBe(false);
  expect(value.registryHash).not.toBe(hash(registry)); expect(value.methodologyHash).not.toBe(hash(methodology));
  expect(value.feeds.at(-1)!.price).toBe("2.500000");
  expect(value.feeds.filter(feed => feed.status === "READY").every(feed => feed.confidence === null)).toBe(true);
});

test("valid unavailable model remains null and prevents a composite without inventing a fallback", () => {
  const value = demo(NOW, observations(NOW).slice(1));
  expect(validate(value).readyModels).toBe(3); expect(validate(value).compositeStatus).toBe("UNAVAILABLE");
  expect(value.feeds.find(feed => feed.id === "SBX:B200")!.price).toBeNull();
  expect(() => validate(demo(NOW, []))).toThrow("no current provider prices");
});

test("demo reconciliation uses current economic groups and exact arithmetic, not fixed market prices", () => {
  const localRegistry = structuredClone(registry);
  const inputs = observations(NOW);
  inputs.push(...observations(NOW).map(quote => ({ ...quote, provider: "azure", source: "azure-retail", sourceUrl: "https://prices.azure.com/api/retail/prices", price: "7.000001", instancePrice: "56.000008", observedAt: NOW - 2000 })));
  for (const sharedGroup of [false, true]) {
    localRegistry.providers.find(provider => provider.id === "azure")!.economicGroup = sharedGroup ? "oracle" : "microsoft";
    const value = centralizedDemo(inputs, demoRegistry(localRegistry), methodology, unusedIdentity, NOW);
    expect(validateDemo(value, { registry: localRegistry, methodology, now: NOW }).readyProviders).toBe(8);
    expect(value.feeds.find(feed => feed.id === "SBX:B200")!.price).toBe("4.000001");
    expect(value.feeds.find(feed => feed.id === "SBX:B200")!.contributors.length).toBe(sharedGroup ? 1 : 2);
    expect(value.feeds.at(-1)!.observedAt).toBe(NOW - 2000);
  }
});

test("demo structural arrays are bounded before inspecting excess contents", () => {
  const value = demo(); value.feeds = Array.from({ length: 806 }, () => value.feeds[0]!);
  expect(() => validate(value)).toThrow("coverage");
  const contributors = demo(); contributors.feeds[0]!.contributors = Array.from({ length: 201 }, (_, index) => `group-${index}`);
  expect(() => validate(contributors)).toThrow("contributors");
});

for (const field of ["mode", "publishable", "pythPublished", "schemaVersion", "network", "registryHash", "methodologyHash", "methodologyVersion"] as const) test(`demo rejects mismatched ${field}`, () => {
  const value = demo() as unknown as Record<string, unknown>;
  value[field] = typeof value[field] === "boolean" ? true : typeof value[field] === "number" ? 2 : "incorrect";
  expect(() => validate(value)).toThrow();
});

test("demo rejects missing, duplicate, unknown and secret-bearing feed/schema fields", () => {
  for (const change of ["missing", "duplicate", "unknown-id", "extra-top", "extra-feed", "batch", "rejected"] as const) {
    const value = demo();
    if (change === "missing") value.feeds.pop();
    if (change === "duplicate") value.feeds[1] = structuredClone(value.feeds[0]!);
    if (change === "unknown-id") value.feeds[0]!.id = "SBX:unknown:B200";
    if (change === "extra-top") Object.assign(value, { credential: PRIVATE });
    if (change === "extra-feed") Object.assign(value.feeds[0]!, { capture: PRIVATE });
    if (change === "batch") value.inputBatchHashes = ["c".repeat(64)];
    if (change === "rejected") value.rejected = [{ batchHash: "c".repeat(64), reason: PRIVATE }];
    expect(() => validate(value)).toThrow();
  }
});

test("freshness follows reviewed local methodology rather than a fixed deployment age", () => {
  const short = { ...methodology, maxAgeMs: 2000 }, value = demo(NOW, observations(NOW), short);
  expect(validate(value, NOW + 1000, short).readyModels).toBe(4);
  expect(() => validate(value, NOW + 1001, short)).toThrow();
  const long = { ...methodology, maxAgeMs: 3600000 }, old = demo(NOW, observations(NOW).map(quote => ({ ...quote, observedAt: NOW - 1000000 })), long);
  expect(validate(old, NOW, long).readyModels).toBe(4);
});

test("self-consistent demo calculation must also meet the browser response-age limit", () => {
  expect(validate(demo(NOW - 120000), NOW).readyModels).toBe(4);
  expect(() => validate(demo(NOW - 120001), NOW)).toThrow("calculation is stale");
  const browser = readFileSync(resolve(import.meta.dir, "../public/assets/index.js"), "utf8");
  expect(browser).toMatch(/const SNAPSHOT_MAX_AGE_MS = 120_000;/);
});

for (const change of ["stale-snapshot", "future-snapshot", "stale-source", "future-source", "source-after-calculation", "feed-clock", "unsafe-time"] as const) test(`demo rejects incoherent ${change}`, () => {
  const value = demo(), first = value.feeds.find(feed => feed.status === "READY")!;
  if (change === "stale-snapshot") value.calculatedAt = NOW - methodology.maxAgeMs - 1;
  if (change === "future-snapshot") value.calculatedAt = NOW + methodology.futureToleranceMs + 1;
  if (change === "stale-source") first.observedAt = NOW - methodology.maxAgeMs - 1;
  if (change === "future-source") first.observedAt = NOW + methodology.futureToleranceMs + 1;
  if (change === "source-after-calculation") { value.calculatedAt = NOW - 30000; for (const feed of value.feeds) feed.calculatedAt = value.calculatedAt; }
  if (change === "feed-clock") first.calculatedAt--;
  if (change === "unsafe-time") first.observedAt = Number.MAX_SAFE_INTEGER + 1;
  expect(() => validate(value)).toThrow();
});

for (const price of [0, 1.25, "0.000000", "-1.000000", "1e2", "NaN", "01.000000", "1.0000001", "100000000000.000000", "1.0"]) test(`demo refuses noncanonical or invalid exact price ${JSON.stringify(price)}`, () => {
  const value = demo(); (value.feeds.find(feed => feed.status === "READY")! as unknown as Record<string, unknown>).price = price;
  expect(() => validate(value)).toThrow();
});

for (const change of ["unavailable-value", "ready-null", "confidence", "kind", "model", "provider", "group", "weight", "model-price", "composite-price", "model-time", "composite-time", "ready-reason"] as const) test(`demo rejects inconsistent ${change}`, () => {
  const value = demo(), provider = value.feeds.find(feed => feed.status === "READY")!, model = value.feeds.find(feed => feed.id === "SBX:B200")!, composite = value.feeds.at(-1)!;
  if (change === "unavailable-value") value.feeds.find(feed => feed.status === "UNAVAILABLE")!.price = "1.000000";
  if (change === "ready-null") provider.price = null;
  if (change === "confidence") provider.confidence = "0.000000";
  if (change === "kind") provider.kind = "MODEL";
  if (change === "model") provider.model = "B300";
  if (change === "provider") provider.provider = "azure";
  if (change === "group") model.contributors = ["fake-group"];
  if (change === "weight") model.weights.oracle = 2;
  if (change === "model-price") model.price = "9.000000";
  if (change === "composite-price") composite.price = "9.000000";
  if (change === "model-time") model.observedAt!--;
  if (change === "composite-time") composite.observedAt!--;
  if (change === "ready-reason") provider.reasons = ["NO_CURRENT_APPROVED_PRICE"];
  expect(() => validate(value)).toThrow();
});

type Override = (url: URL, method: string, normal: Response) => Response | Promise<Response>;
function deploymentFixture(override: Override = (_url, _method, normal) => normal) {
  const requests: Array<{ url: string; method: string }> = [], now = Date.now();
  const value = demo(now), empty = { ...value, registryHash: hash(registry), methodologyHash: hash(methodology), feeds: value.feeds.map(feed => ({ ...feed, status: "UNAVAILABLE", price: null, confidence: null, observedAt: null })) };
  const body = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const assets: Record<string, string> = { "/": "index.html", "/providers.html": "providers.html", "/methodology.html": "methodology.html", "/assets/index.js": "assets/index.js", "/assets/mode.js": "assets/mode.js", "/assets/site.css": "assets/site.css" };
  const request = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? "GET"; requests.push({ url: url.toString(), method });
    let response: Response;
    if (["blackwell.fyi", "blackwell.today"].includes(url.hostname)) response = new Response(null, { status: 308, headers: { location: `https://blackwellindex.com${url.pathname}${url.search}` } });
    else if (url.pathname === "/v1/demo") response = body(value);
    else if (url.pathname === "/v1/feeds") response = body(empty);
    else if (url.pathname === "/v1/ready") response = body({ publishable: false }, 503);
    else if (url.pathname === "/v1/reports") response = body({ reports: [] });
    else if (url.pathname === "/healthz") response = body({ status: "RUNNING" });
    else if (url.pathname === "/v1/status") {
      const publicKey = url.hostname.startsWith("secondary.") ? "isolated-secondary-public-identity" : "isolated-primary-public-identity";
      response = body({ nodeId: nodeIdFor(publicKey), publicKey, registryHash: hash(registry), methodologyHash: hash(methodology), methodologyStatus: "DRAFT", pyth: "NOT_PUBLISHED", hosting: { runtime: "cloudflare-durable-object", operatorGroupCount: 1, operatorGroup: "isolated-shared-operator", release: RELEASE }, collection: { status: "COMPLETE", completedAt: now, lastCycle: { startedAt: now - 2000, collectedAt: now - 1000, realObservationCount: 4, sharedObservationCount: 0, publishable: false, models: [...MODELS], sources: [{ collector: "oracle-public", status: "COLLECTED", observations: 4, errors: 0 }] } } });
    } else if (assets[url.pathname]) response = new Response(readFileSync(resolve(import.meta.dir, "../public", url.hostname === "altx.exchange" && url.pathname === "/" ? "altx/index.html" : assets[url.pathname]!)));
    else response = new Response(PRIVATE, { status: 404 });
    return override(url, method, response);
  }) as typeof fetch;
  return { requests, request, body };
}

test("complete isolated acceptance checks demo/assets while retaining all oracle and private-route gates", async () => {
  const fixture = deploymentFixture(), result = (await verifyDeployment(["--release", RELEASE], fixture.request))!;
  expect(result.status).toBe("PASS"); expect(result.failures).toEqual([]);
  expect((result.demos as unknown[]).length).toBe(4);
  const urls = fixture.requests.map(item => item.url);
  for (const path of ["/providers.html", "/assets/mode.js", "/?mode=demo", "/?mode=real"]) expect(urls).toContain(`https://blackwellindex.com${path}`);
  for (const host of ["blackwellindex.com", "altx.exchange", "primary.blackwellindex.com", "secondary.blackwellindex.com"]) expect(urls).toContain(`https://${host}/v1/demo`);
  expect(fixture.requests.filter(item => item.method === "POST").length).toBe(16);
  expect((result.privateRoutes as { checked: number }).checked).toBe(92);
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
});

for (const change of ["demo-missing", "demo-unavailable", "demo-publishable", "provider-asset", "mode-asset", "real-mode-html", "oracle-price", "ready-200", "pyth-published", "reports-public", "private-get", "private-post"] as const) test(`release acceptance fails ${change} without weakening original gates`, async () => {
  const fixture = deploymentFixture((url, method, normal) => {
    if (change === "demo-missing" && url.pathname === "/v1/demo") return new Response("missing", { status: 404 });
    if (change === "demo-unavailable" && url.pathname === "/v1/demo") return fixture.body(demo(Date.now(), []));
    if (change === "demo-publishable" && url.pathname === "/v1/demo") return fixture.body({ ...demo(Date.now()), publishable: true });
    if (change === "provider-asset" && url.pathname === "/providers.html" || change === "mode-asset" && url.pathname === "/assets/mode.js" || change === "real-mode-html" && url.search === "?mode=real") return new Response("incorrect deployed bytes");
    if (change === "oracle-price" && url.pathname === "/v1/feeds") return normal.json().then(value => {
      const snapshot = value as { feeds: Array<Record<string, unknown>> };
      Object.assign(snapshot.feeds[0]!, { status: "READY", price: "1.000000", observedAt: Date.now() });
      return fixture.body(snapshot);
    });
    if (change === "ready-200" && url.pathname === "/v1/ready") return fixture.body({ publishable: false });
    if (change === "pyth-published" && url.pathname === "/v1/status") return normal.json().then(value => fixture.body({ ...value as Record<string, unknown>, pyth: "PUBLISHED" }));
    if (change === "reports-public" && url.pathname === "/v1/reports") return fixture.body({ reports: [{ private: PRIVATE }] });
    if (change === "private-get" && url.pathname === "/data/credentials.json" || change === "private-post" && method === "POST" && url.pathname === "/internal/archive/begin") return new Response(PRIVATE);
    return normal;
  });
  const result = (await verifyDeployment(["--release", RELEASE], fixture.request))!;
  expect(result.status).toBe("FAIL"); expect((result.failures as unknown[]).length).toBeGreaterThan(0); expect(JSON.stringify(result)).not.toContain(PRIVATE);
  if (change === "oracle-price") expect(JSON.stringify(result.failures)).toContain("development feed contains a value");
  if (change === "pyth-published") expect(JSON.stringify(result.failures)).toContain("Unexpected methodology or Pyth publication state");
});
