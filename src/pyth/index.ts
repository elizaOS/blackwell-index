import { createHash } from "node:crypto";
import type { Snapshot } from "../types";
import { PYTH_RECOVERY_LIMITS } from "./recovery-state";

/** The current official Pyth Pro publisher agent, not the retired Pythnet agent. */
export const PYTH_PROTOCOL = "pyth-lazer-agent@0.16.0/protocol@0.46.0" as const;
export const PYTH_SYMBOLS_URL = "https://pyth.dourolabs.app/v1/symbols";

export interface PythFeedBinding {
  indexFeedId: string;
  pythFeedId: number;
  symbol: string;
  exponent: number;
  minPublishers: number;
}

/** Kept in operator configuration, separate from keys held by the signing agent. */
export interface PythManifest {
  schemaVersion: 1;
  enabled: boolean;
  network: string;
  methodologyHash: string;
  registryHash: string;
  agentUrl: string;
  maxAgeMs: number;
  futureToleranceMs: number;
  approval: {
    status: "APPROVED" | "PENDING";
    publisherPublicKey: string;
    evidence: string;
    verifiedAt: number;
    expiresAt: number;
    protocol: typeof PYTH_PROTOCOL;
    /** Actual publisher ingress endpoints supplied by Pyth, never consumer /v1/stream URLs. */
    relayerUrls: string[];
  };
  bindings: PythFeedBinding[];
}

export interface PythSymbol {
  pyth_lazer_id: number;
  symbol: string;
  exponent: number;
  min_publishers: number;
  state: string;
}

export interface PythPushRequest {
  jsonrpc: "2.0";
  id: string;
  method: "push_updates";
  params: Array<{
    feed_id: number;
    source_timestamp: number;
    update: { type: "price"; price: number };
  }>;
}

export interface PythPublication {
  status: "PREPARED";
  request: PythPushRequest;
  snapshotHash: string;
  skipped: Array<{ indexFeedId: string; reason: string }>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  assert(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max, `Invalid ${name}`);
}
function text(value: unknown, name: string): asserts value is string {
  assert(typeof value === "string" && value.trim().length > 0, `Missing ${name}`);
}
function hash(value: unknown, name: string): asserts value is string {
  assert(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), `Invalid ${name}`);
}

export function validateAgentUrl(value: string): URL {
  const url = new URL(value);
  assert(["ws:", "wss:"].includes(url.protocol), "Pyth agent requires WebSocket transport");
  assert(["127.0.0.1", "[::1]", "localhost"].includes(url.hostname), "Pyth signing agent must be on loopback; use a local tunnel for remote signers");
  assert(url.pathname === "/v1/jrpc" && !url.username && !url.password && !url.search && !url.hash, "Pyth agent URL must use /v1/jrpc without credentials or query parameters");
  return url;
}

export function validatePythManifest(value: unknown, now = Date.now()): PythManifest {
  assert(value !== null && typeof value === "object", "Invalid Pyth manifest");
  const m = value as PythManifest;
  assert(m.schemaVersion === 1 && typeof m.enabled === "boolean", "Unsupported Pyth manifest");
  text(m.network, "network");
  hash(m.methodologyHash, "methodologyHash");
  hash(m.registryHash, "registryHash");
  validateAgentUrl(m.agentUrl);
  integer(m.maxAgeMs, "maxAgeMs", 1, 86_400_000);
  integer(m.futureToleranceMs, "futureToleranceMs", 0, 60_000);
  assert(m.approval && m.approval.protocol === PYTH_PROTOCOL, "Pyth protocol confirmation does not match this adapter");
  assert(["APPROVED", "PENDING"].includes(m.approval.status), "Invalid Pyth approval status");
  text(m.approval.publisherPublicKey, "publisherPublicKey");
  assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m.approval.publisherPublicKey), "Invalid Pyth publisher public key");
  text(m.approval.evidence, "Pyth approval evidence");
  integer(m.approval.verifiedAt, "approval verifiedAt");
  integer(m.approval.expiresAt, "approval expiresAt", m.approval.verifiedAt + 1);
  assert(m.approval.verifiedAt <= now + m.futureToleranceMs, "Pyth approval is from the future");
  assert(Array.isArray(m.approval.relayerUrls) && m.approval.relayerUrls.length > 0, "Missing confirmed Pyth publisher ingress");
  for (const endpoint of m.approval.relayerUrls) {
    const url = new URL(endpoint);
    assert(url.protocol === "wss:" && url.pathname === "/v1/transaction" && !url.username && !url.password && !url.search && !url.hash, "Invalid Pyth publisher ingress endpoint");
  }
  assert(Array.isArray(m.bindings) && m.bindings.length > 0, "Missing Pyth feed bindings");
  assert(m.bindings.length<=PYTH_RECOVERY_LIMITS.feeds,"Pyth binding capacity requires review");
  const indexIds = new Set<string>();
  const pythIds = new Set<number>();
  for (const b of m.bindings) {
    text(b.indexFeedId, "indexFeedId");
    text(b.symbol, "Pyth symbol");
    integer(b.pythFeedId, "Pyth feed ID", 1, 4_294_967_295);
    integer(b.exponent, "Pyth exponent", -18, 18);
    integer(b.minPublishers, "minimum publishers", 1, 65_535);
    assert(!indexIds.has(b.indexFeedId) && !pythIds.has(b.pythFeedId), "Duplicate Pyth feed binding");
    indexIds.add(b.indexFeedId);
    pythIds.add(b.pythFeedId);
  }
  return m;
}

/** Convert exact decimals without floating point rounding; reject unsupported precision. */
export function priceToPythMantissa(price: string, exponent: number): number {
  integer(exponent, "Pyth exponent", -18, 18);
  assert(typeof price === "string" && /^(0|[1-9]\d*)(\.\d+)?$/.test(price), "Invalid decimal price");
  const [whole = "0", fraction = ""] = price.split(".");
  const digits = BigInt(whole + fraction);
  const shift = -exponent - fraction.length;
  const divisor = shift < 0 ? 10n ** BigInt(-shift) : 1n;
  assert(digits % divisor === 0n, "Price is more precise than the approved Pyth exponent");
  const mantissa = shift < 0 ? digits / divisor : digits * 10n ** BigInt(shift);
  // JSON numeric values sent by this client deliberately fit both JS and Pyth i64.
  assert(mantissa > 0n && mantissa <= BigInt(Number.MAX_SAFE_INTEGER), "Price exceeds safe Pyth JSON integer range");
  return Number(mantissa);
}

export function validatePythSymbols(value: unknown): PythSymbol[] {
  assert(Array.isArray(value), "Invalid Pyth symbol catalog");
  const ids = new Set<number>();
  return value.map((item) => {
    assert(item !== null && typeof item === "object", "Invalid Pyth symbol");
    const s = item as PythSymbol;
    integer(s.pyth_lazer_id, "catalog feed ID", 1, 4_294_967_295);
    text(s.symbol, "catalog symbol");
    integer(s.exponent, "catalog exponent", -32_768, 32_767);
    integer(s.min_publishers, "catalog minimum publishers", 1, 65_535);
    text(s.state, "catalog state");
    assert(!ids.has(s.pyth_lazer_id), "Duplicate Pyth catalog feed ID");
    ids.add(s.pyth_lazer_id);
    return s;
  });
}

export function preparePythPublication(snapshot: Snapshot, manifestValue: unknown, catalog: PythSymbol[], now = Date.now()): PythPublication {
  const m = validatePythManifest(manifestValue, now);
  assert(m.enabled && m.approval.status === "APPROVED" && m.approval.expiresAt > now, "Pyth publication needs current publisher and feed approval");
  assert(snapshot.publishable, "Snapshot is not publishable");
  assert(snapshot.network === m.network && snapshot.methodologyHash === m.methodologyHash && snapshot.registryHash === m.registryHash, "Snapshot does not match the approved Pyth network, methodology and registry");
  integer(snapshot.calculatedAt, "snapshot calculatedAt");
  assert(snapshot.calculatedAt <= now + m.futureToleranceMs && now - snapshot.calculatedAt <= m.maxAgeMs, "Snapshot is stale or from the future");
  assert(Array.isArray(snapshot.inputBatchHashes) && snapshot.inputBatchHashes.length > 0, "Snapshot lacks source evidence");
  for (const h of snapshot.inputBatchHashes) hash(h, "input batch hash");
  const symbols = new Map(validatePythSymbols(catalog).map((s) => [s.pyth_lazer_id, s]));
  const feeds = new Map(snapshot.feeds.map((feed) => [feed.id, feed]));
  assert(feeds.size === snapshot.feeds.length, "Duplicate snapshot feed IDs");
  const params: PythPushRequest["params"] = [];
  const skipped: PythPublication["skipped"] = [];
  for (const binding of m.bindings) {
    const symbol = symbols.get(binding.pythFeedId);
    assert(symbol && symbol.symbol === binding.symbol && symbol.exponent === binding.exponent && symbol.min_publishers === binding.minPublishers && symbol.state === "stable", `Pyth metadata mismatch or inactive feed: ${binding.indexFeedId}`);
    const feed = feeds.get(binding.indexFeedId);
    assert(feed, `Snapshot lacks configured feed: ${binding.indexFeedId}`);
    if (feed.status !== "READY" || feed.price === null || feed.observedAt === null) {
      skipped.push({ indexFeedId: binding.indexFeedId, reason: "Feed unavailable; no new Pyth update is submitted" });
      continue;
    }
    integer(feed.observedAt, "feed observedAt");
    assert(feed.observedAt <= snapshot.calculatedAt + m.futureToleranceMs && feed.observedAt <= now + m.futureToleranceMs && now - feed.observedAt <= m.maxAgeMs, `Stale or future source observation: ${feed.id}`);
    const sourceTimestamp = feed.observedAt * 1000;
    integer(sourceTimestamp, "source timestamp in microseconds");
    params.push({ feed_id: binding.pythFeedId, source_timestamp: sourceTimestamp, update: { type: "price", price: priceToPythMantissa(feed.price, binding.exponent) } });
  }
  assert(params.length > 0, "No fresh, ready feeds to publish to Pyth");
  const snapshotHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return { status: "PREPARED", request: { jsonrpc: "2.0", id: `sbx-${snapshotHash}`, method: "push_updates", params }, snapshotHash, skipped };
}

export interface PythQueueReceipt {
  status: "QUEUED_LOCAL";
  requestId: string;
  queuedAt: number;
  snapshotHash: string;
}

/** Local acknowledgement only proves that the official agent queued the request. */
export async function submitToPythAgent(publication: PythPublication, agentUrl: string, timeoutMs = 5000): Promise<PythQueueReceipt> {
  validateAgentUrl(agentUrl);
  integer(timeoutMs, "agent timeout", 1, 60_000);
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(agentUrl);
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve({ status: "QUEUED_LOCAL", requestId: publication.request.id, queuedAt: Date.now(), snapshotHash: publication.snapshotHash });
    };
    const timer = setTimeout(() => finish(new Error("Pyth agent acknowledgement timed out; delivery is unconfirmed")), timeoutMs);
    socket.addEventListener("open", () => socket.send(JSON.stringify(publication.request)));
    socket.addEventListener("error", () => finish(new Error("Pyth agent connection failed; delivery is unconfirmed")));
    socket.addEventListener("close", () => finish(new Error("Pyth agent closed before acknowledgement; delivery is unconfirmed")));
    socket.addEventListener("message", (event) => {
      try {
        assert(typeof event.data === "string" && event.data.length <= 65_536, "Invalid Pyth agent response");
        const response = JSON.parse(event.data) as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
        if (response.id !== publication.request.id) return;
        assert(response.jsonrpc === "2.0" && response.result === "success" && response.error === undefined, "Pyth agent rejected the update");
        finish();
      } catch { finish(new Error("Invalid or rejected Pyth agent acknowledgement")); }
    });
  });
}

export interface PythReadback {
  priceFeedId: number;
  price: string;
  exponent: number;
  confidence: string;
  publisherCount: number;
  feedUpdateTimestamp: string;
}

/** Validate an independently fetched Pro feed; this alone does not prove our publisher contributed. */
export function verifyPythReadback(readback: PythReadback, binding: PythFeedBinding, options: { now: number; maxAgeMs: number; previousFeedUpdateTimestamp?: string; expectedPrice?: string; maxDeviationBps: number }): { status: "UPSTREAM_OBSERVED"; generatedAt: number } {
  assert(readback.priceFeedId === binding.pythFeedId && readback.exponent === binding.exponent, "Pyth readback feed identity mismatch");
  integer(readback.publisherCount, "Pyth publisher count", binding.minPublishers, 65_535);
  integer(options.now, "readback current time");
  integer(options.maxAgeMs, "readback maxAgeMs", 1);
  integer(options.maxDeviationBps, "readback deviation limit", 0, 10_000);
  assert(/^\d+$/.test(readback.feedUpdateTimestamp), "Missing Pyth feed generation timestamp");
  const timestamp = BigInt(readback.feedUpdateTimestamp);
  const nowUs = BigInt(options.now) * 1000n;
  assert(timestamp > 0n && timestamp <= nowUs && nowUs - timestamp <= BigInt(options.maxAgeMs) * 1000n, "Pyth price is stale or from the future");
  if (options.previousFeedUpdateTimestamp !== undefined) {
    assert(/^\d+$/.test(options.previousFeedUpdateTimestamp) && timestamp > BigInt(options.previousFeedUpdateTimestamp), "Pyth price did not advance; a carried-forward price is not a fresh publication");
  }
  assert(/^[1-9]\d*$/.test(readback.price) && /^\d+$/.test(readback.confidence), "Invalid Pyth readback price or confidence");
  const price = BigInt(readback.price);
  assert(price <= 9_223_372_036_854_775_807n && BigInt(readback.confidence) <= 9_223_372_036_854_775_807n, "Pyth readback integer overflow");
  assert(BigInt(readback.confidence) * 10_000n <= price * BigInt(options.maxDeviationBps), "Pyth confidence exceeds configured bound");
  if (options.expectedPrice !== undefined) {
    const expected = BigInt(priceToPythMantissa(options.expectedPrice, binding.exponent));
    const deviation = price > expected ? price - expected : expected - price;
    assert(deviation * 10_000n <= expected * BigInt(options.maxDeviationBps), "Pyth price disagrees with the expected SBX print");
  }
  return { status: "UPSTREAM_OBSERVED", generatedAt: Number(timestamp / 1000n) };
}
