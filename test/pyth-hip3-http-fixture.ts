/** Synthetic signed OracleNode over real HTTP; control arrives only through inherited stdin. */
import { createInterface } from "node:readline";
import { signBatch, hash } from "../src/crypto";
import { fromMicros, toMicros } from "../src/decimal";
import { OracleNode } from "../src/network";
import { Store } from "../src/store";
import type { Observation, ScheduledB200Offer } from "../src/types";
import { environment } from "./helpers";
import { serveHttpFixture } from "./pyth-hip3-http-preload";

async function main() {
  const e = environment(), base = Date.now(), expectedPrice = "3.123457";
  e.methodology.effectiveAt = base - 10000;
  e.methodology.publicationScope = { kind: "MODEL", model: "B200", approvalEvidence: "Synthetic local HTTP scope; no real approval" };
  for (const model of ["B300", "GB200", "GB300"] as const) e.methodology.providerWeights[model] = {};
  const observations: Observation[] = e.observations.filter(value => value.model === "B200").map(value => ({ ...value,
    price: expectedPrice, instancePrice: fromMicros(toMicros(expectedPrice) * BigInt(value.gpuCount)),
    topology: "HGX", priceScope: "PUBLIC", minimumOrderGpuCount: 8, sourceRecordId: `http-fixture:${value.provider}` }));
  const offers: ScheduledB200Offer[] = observations.map(value => ({ provider: value.provider, source: value.source,
    sku: value.sku, region: value.region, gpuCount: 8, topology: "HGX", includes: [...value.includes],
    minimumOrderGpuCount: 8, sourceRecordId: value.sourceRecordId!, sourceUrl: value.sourceUrl }));
  e.methodology.offerSchedule = { schemaVersion: 1, model: "B200", approvalEvidence: "Synthetic exact offer schedule", offers };
  let now = base, observedAt = base - 1000, scenario = "ready", requests = 0, actualRouteRequests = 0;
  let store: Store, node: OracleNode;
  function configure() {
    store?.close(); store = new Store(":memory:");
    node = new OracleNode({ identity: e.identities[0]!, registry: e.registry, methodology: e.methodology, store, clock: () => now });
    for (const [i, identity] of e.identities.entries()) node.receive(signBatch({ ...e.batches[i]!.payload, createdAt: now,
      observations: observations.filter(value => scenario !== "missing_constituent" || value.provider !== "gamma")
        .map(value => {
          const refreshed = scenario === "partial_refresh" && value.provider === "gamma";
          const price = refreshed ? "4.123457" : value.price;
          return { ...value, price, instancePrice: fromMicros(toMicros(price) * BigInt(value.gpuCount)),
            observedAt: refreshed ? observedAt + 500 : observedAt, priceEffectiveAt: base - 86_400_000 };
        }) }, identity));
  }
  configure();
  const server = serveHttpFixture(async request => {
    requests++;
    if (new URL(request.url).pathname !== "/v1/feeds" || request.method !== "GET") return new Response(null, { status: 404 });
    actualRouteRequests++;
    const response = await node.handle(request);
    if (scenario === "ready" || scenario === "missing_constituent" || scenario === "partial_refresh") return response;
    // Deliberately corrupted transport envelopes; never written into the journal.
    if (scenario === "http_error") return new Response(null, { status: 503 });
    if (scenario === "timeout") { await Bun.sleep(700); return response; }
    if (scenario === "redirect") return new Response(null, { status: 302, headers: { location: "https://example.invalid/never-follow" } });
    if (scenario === "malformed") return new Response("{", { headers: { "content-type": "application/json" } });
    if (scenario === "duplicate_json") return new Response('{"schemaVersion":1,"schemaVersion":1}', { headers: { "content-type": "application/json" } });
    if (scenario === "nonfinite_json") return new Response('{"value":NaN}', { headers: { "content-type": "application/json" } });
    if (scenario === "oversized") return new Response(" ".repeat(2_000_001), { headers: { "content-type": "application/json" } });
    if (scenario === "oversized_integer") return new Response('{"value":' + "9".repeat(5000) + "}", { headers: { "content-type": "application/json" } });
    if (scenario === "overflow_float") return new Response('{"value":1e309}', { headers: { "content-type": "application/json" } });
    if (scenario === "wrong_content_type") return new Response(await response.text(), { headers: { "content-type": "text/plain" } });
    if (scenario === "encoded_body") return new Response(await response.text(), { headers: { "content-type": "application/json", "content-encoding": "gzip" } });
    const value = await response.json() as Record<string, any>, feed = value.feeds.find((item: any) => item.id === "SBX:B200");
    if (scenario === "network") value.network = "wrong-network";
    if (scenario === "methodology") value.methodologyHash = "0".repeat(64);
    if (scenario === "registry") value.registryHash = "0".repeat(64);
    if (scenario === "scope") value.publicationScope = { kind: "MODEL", model: "B300" };
    if (scenario === "scope_missing") delete value.publicationScope;
    if (scenario === "scope_extra") value.publicationScope.extra = true;
    if (scenario === "unavailable") value.publishable = false;
    if (scenario === "not_boolean") value.publishable = "true";
    if (scenario === "demo") value.mode = "CENTRALIZED_DEMO";
    if (scenario === "feed_identity") feed.provider = "alpha";
    if (scenario === "feed_kind") feed.kind = "PROVIDER";
    if (scenario === "feed_missing") value.feeds = value.feeds.filter((item: any) => item.id !== "SBX:B200");
    if (scenario === "feed_duplicate") value.feeds.push({ ...feed });
    if (scenario === "feed_unavailable") feed.status = "UNAVAILABLE";
    if (scenario === "price_number") feed.price = 3.123457;
    if (scenario === "price_noncanonical") feed.price = "03.123457";
    if (scenario === "price_nonfinite") feed.price = "NaN";
    if (scenario === "price_zero") feed.price = "0.000000";
    if (scenario === "price_oversized") feed.price = "9".repeat(25) + ".000000";
    if (scenario === "price_conflict") feed.price = "4.123457";
    if (scenario === "source_boolean") feed.observedAt = true;
    if (scenario === "source_future") feed.observedAt = now + 1;
    if (scenario === "source_rollback") feed.observedAt = base - 2000;
    if (scenario === "mixed_clock") feed.calculatedAt--;
    if (scenario === "snapshot_stale") value.calculatedAt = now - 2000;
    if (scenario === "snapshot_future") value.calculatedAt = now + 1;
    if (scenario === "snapshot_rollback") { value.calculatedAt = now - 1; feed.calculatedAt = now - 1; }
    if (scenario === "input_missing") value.inputBatchHashes = [];
    return Response.json(value);
  });
  process.stdout.write(JSON.stringify({ fixtureOnly: true, url: `${server.url.origin}/v1/feeds`, network: e.registry.network,
    methodologyHash: hash(e.methodology), registryHash: hash(e.registry), now: base, observedAt,
    expectedPrice, bunVersion: Bun.version, sourcePolicyMaxAgeMs: e.methodology.maxAgeMs,
    offerScheduleHash: hash(e.methodology.offerSchedule) }) + "\n");
  const reader = createInterface({ input: process.stdin });
  try {
    for await (const line of reader) {
      const command = JSON.parse(line);
      if (command.action === "stop") break;
      if (command.action === "stats") { process.stdout.write(JSON.stringify({ requests, actualRouteRequests }) + "\n"); continue; }
      if (command.action !== "set" || typeof command.scenario !== "string" || !Number.isSafeInteger(command.now) || !Number.isSafeInteger(command.observedAt)) throw new Error("INVALID_FIXTURE_CONTROL");
      scenario = command.scenario; now = command.now; observedAt = command.observedAt; configure();
      process.stdout.write(JSON.stringify({ ready: true, scenario }) + "\n");
    }
  } finally { server.stop(true); store!.close(); reader.close(); }
}

if (import.meta.main) await main();
