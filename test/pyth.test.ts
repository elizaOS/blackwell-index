import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Snapshot } from "../src/types";
import { PYTH_PROTOCOL, preparePythPublication, priceToPythMantissa, submitToPythAgent, validateAgentUrl, validatePythManifest, verifyPythReadback, type PythManifest, type PythReadback } from "../src/pyth";
import { publishSnapshot } from "../src/pyth/runtime";
import { Store } from "../src/store";

// Synthetic values in tests are never ingested into the production collector.
const now = 1_788_700_000_000;
const binding = { indexFeedId: "SBX-B200", pythFeedId: 12, symbol: "TEST.SBXB200/USD", exponent: -6, minPublishers: 3 };
const catalog = [{ pyth_lazer_id: 12, symbol: binding.symbol, exponent: -6, min_publishers: 3, state: "stable" }];
function manifest(): PythManifest {
  return { schemaVersion: 1, enabled: true, network: "test", methodologyHash: "a".repeat(64), registryHash: "b".repeat(64), agentUrl: "ws://127.0.0.1:8910/v1/jrpc", maxAgeMs: 30_000, futureToleranceMs: 1000,
    approval: { status: "APPROVED", publisherPublicKey: "11111111111111111111111111111111", evidence: "test-only approval", verifiedAt: now - 1000, expiresAt: now + 100_000, protocol: PYTH_PROTOCOL, relayerUrls: ["wss://publisher.example.test/v1/transaction"] }, bindings: [{ ...binding }] };
}
function snapshot(): Snapshot {
  return { schemaVersion: 1, network: "test", calculatedAt: now, methodologyVersion: "test-1", methodologyHash: "a".repeat(64), registryHash: "b".repeat(64), publishable: true, inputBatchHashes: ["c".repeat(64)], rejected: [], feeds: [{ id: "SBX-B200", kind: "MODEL", model: "B200", provider: null, status: "READY", price: "5.125", confidence: "0.15", observedAt: now - 12_345, calculatedAt: now, reasons: [], contributors: ["provider-a", "provider-b", "provider-c"], weights: { a: 1, b: 1, c: 1 } }] };
}

describe("Pyth Pro publication boundary", () => {
  test("uses the modern agent schema and preserves source time", () => {
    const result = preparePythPublication(snapshot(), manifest(), catalog, now);
    expect(result.status).toBe("PREPARED");
    expect(result.request.method).toBe("push_updates");
    expect(result.request.params).toEqual([{ feed_id: 12, source_timestamp: (now - 12_345) * 1000, update: { type: "price", price: 5_125_000 } }]);
    // The index deviation bound is not an executable bid or ask.
    expect(JSON.stringify(result.request)).not.toContain("conf");
    expect(JSON.stringify(result.request)).not.toContain("best_bid");
  });
  test("requires matching approved publisher, feed metadata, network and evidence", () => {
    for (const mutate of [
      (m: PythManifest) => { m.enabled = false; },
      (m: PythManifest) => { m.approval.status = "PENDING"; },
      (m: PythManifest) => { m.approval.expiresAt = now - 1; },
      (m: PythManifest) => { m.network = "other"; },
      (m: PythManifest) => { m.registryHash = "d".repeat(64); },
      (m: PythManifest) => { m.methodologyHash = "d".repeat(64); },
    ]) {
      const m = manifest(); mutate(m);
      expect(() => preparePythPublication(snapshot(), m, catalog, now)).toThrow();
    }
    expect(() => preparePythPublication(snapshot(), manifest(), [], now)).toThrow("metadata mismatch");
    expect(() => preparePythPublication(snapshot(), manifest(), [{ ...catalog[0]!, exponent: -8 }], now)).toThrow("metadata mismatch");
    expect(() => preparePythPublication(snapshot(), manifest(), [{ ...catalog[0]!, state: "inactive" }], now)).toThrow("metadata mismatch");
    const s = snapshot(); s.inputBatchHashes = [];
    expect(() => preparePythPublication(s, manifest(), catalog, now)).toThrow("source evidence");
  });
  test("rejects stale, unavailable, draft and duplicate observations", () => {
    const stale = snapshot(); stale.feeds[0]!.observedAt = now - 30_001;
    expect(() => preparePythPublication(stale, manifest(), catalog, now)).toThrow("Stale");
    const unavailable = snapshot(); unavailable.feeds[0]!.status = "UNAVAILABLE";
    expect(() => preparePythPublication(unavailable, manifest(), catalog, now)).toThrow("No fresh");
    const draft = snapshot(); draft.publishable = false;
    expect(() => preparePythPublication(draft, manifest(), catalog, now)).toThrow("not publishable");
    const duplicate = snapshot(); duplicate.feeds.push(duplicate.feeds[0]!);
    expect(() => preparePythPublication(duplicate, manifest(), catalog, now)).toThrow("Duplicate");
    const m = manifest(); m.bindings.push({ ...binding });
    expect(() => validatePythManifest(m, now)).toThrow("Duplicate");
  });
  test("converts decimals exactly and refuses precision loss or unsafe integers", () => {
    expect(priceToPythMantissa("0.000001", -6)).toBe(1);
    expect(priceToPythMantissa("5.125000", -3)).toBe(5125);
    expect(priceToPythMantissa("1000", 2)).toBe(10);
    for (const [price, exponent] of [["0", -6], ["-1", -6], ["1e3", -6], ["5.0000001", -6], ["9007199254740992", 0], ["NaN", -6]] as const) {
      expect(() => priceToPythMantissa(price, exponent)).toThrow();
    }
  });
  test("refuses remote or credential-bearing signing-agent endpoints", () => {
    for (const url of ["wss://example.com/v1/jrpc", "ws://127.0.0.1/v1/legacy", "ws://user:pass@localhost/v1/jrpc", "ws://localhost/v1/jrpc?token=secret"]) expect(() => validateAgentUrl(url)).toThrow();
  });
  test("local success is QUEUED_LOCAL, never publication proof", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); }, websocket: { message(ws, message) { const request = JSON.parse(String(message)); ws.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "success" })); } } });
    try {
      const publication = preparePythPublication(snapshot(), manifest(), catalog, now);
      const receipt = await submitToPythAgent(publication, `ws://127.0.0.1:${server.port}/v1/jrpc`);
      expect(receipt.status).toBe("QUEUED_LOCAL");
      expect(receipt.snapshotHash).toBe(publication.snapshotHash);
    } finally { server.stop(true); }
  });
});

describe("independent Pyth output checks", () => {
  const readback = (): PythReadback => ({ priceFeedId: 12, price: "5125000", confidence: "10000", exponent: -6, publisherCount: 3, feedUpdateTimestamp: String((now - 1000) * 1000) });
  const options = { now, maxAgeMs: 10_000, previousFeedUpdateTimestamp: String((now - 2000) * 1000), expectedPrice: "5.125", maxDeviationBps: 100 };
  test("requires genuine feed time advancement and independently observed price", () => expect(verifyPythReadback(readback(), binding, options)).toEqual({ status: "UPSTREAM_OBSERVED", generatedAt: now - 1000 }));
  test("rejects carried-forward, insufficient-publisher, wrong-unit and divergent prices", () => {
    for (const mutate of [
      (r: PythReadback) => { r.feedUpdateTimestamp = options.previousFeedUpdateTimestamp; },
      (r: PythReadback) => { r.publisherCount = 2; },
      (r: PythReadback) => { r.exponent = -8; },
      (r: PythReadback) => { r.price = "6125000"; },
      (r: PythReadback) => { r.confidence = "2000000"; },
      (r: PythReadback) => { r.feedUpdateTimestamp = String((now - 30_000) * 1000); },
    ]) { const r = readback(); mutate(r); expect(() => verifyPythReadback(r, binding, options)).toThrow(); }
  });
});

describe("automated Pyth publication tick", () => {
  const acknowledge:typeof submitToPythAgent=async publication=>({status:"QUEUED_LOCAL",requestId:publication.request.id,snapshotHash:publication.snapshotHash,queuedAt:now});
  test("approval and availability gates do not fetch or submit externally", async () => {
    const store=new Store(":memory:");let externalCalls=0;
    const deps={now:()=>now,fetchCatalog:async()=>{externalCalls++;return catalog;},submit:acknowledge};
    try {
      const pending=manifest();pending.approval.status="PENDING";
      expect((await publishSnapshot(snapshot(),pending,store,deps)).status).toBe("BLOCKED");
      expect((await publishSnapshot({...snapshot(),publishable:false},manifest(),store,deps)).status).toBe("UNAVAILABLE");
      expect((await publishSnapshot(snapshot(),{...manifest(),enabled:false},store,deps)).status).toBe("DISABLED");
      expect(externalCalls).toBe(0);
    }finally{store.close();}
  });
  test("queued per-feed timestamps survive restart and only advancing source data is submitted", async () => {
    const dir=await mkdtemp(join(tmpdir(),"sbx-pyth-runtime-")),path=join(dir,"node.sqlite");
    let store=new Store(path),submissions=0;
    const deps={now:()=>now,fetchCatalog:async()=>catalog,submit:async(...args:Parameters<typeof submitToPythAgent>)=>{submissions++;return acknowledge(...args);}};
    try {
      const first=await publishSnapshot(snapshot(),manifest(),store,deps);
      expect(first.status).toBe("QUEUED_LOCAL");
      expect(first.feeds).toEqual([{feedId:12,sourceTimestamp:(now-12_345)*1000}]);
      store.close();store=new Store(path);
      expect((await publishSnapshot(snapshot(),manifest(),store,deps)).status).toBe("NO_NEW_SOURCE_DATA");
      const changedPrice=snapshot();changedPrice.feeds[0]!.price="6.125";
      expect((await publishSnapshot(changedPrice,manifest(),store,deps)).status).toBe("NO_NEW_SOURCE_DATA");
      const newer=snapshot();newer.feeds[0]!.observedAt!++;
      expect((await publishSnapshot(newer,manifest(),store,deps)).status).toBe("QUEUED_LOCAL");
      expect(submissions).toBe(2);
      const state=store.db.query("SELECT last_attempted_timestamp,last_queued_timestamp,last_status FROM pyth_submission_state").get();
      expect(state).toEqual({last_attempted_timestamp:(now-12_344)*1000,last_queued_timestamp:(now-12_344)*1000,last_status:"QUEUED_LOCAL"});
    }finally{store.close();await rm(dir,{recursive:true,force:true});}
  });
  test("a lost acknowledgement is unconfirmed and is not silently replayed", async () => {
    const store=new Store(":memory:");let submissions=0;
    const deps={now:()=>now,fetchCatalog:async()=>catalog,submit:async()=>{submissions++;throw new Error("Test acknowledgement lost");}};
    try {
      expect((await publishSnapshot(snapshot(),manifest(),store,deps)).status).toBe("DELIVERY_UNCONFIRMED");
      expect((await publishSnapshot(snapshot(),manifest(),store,deps)).status).toBe("NO_NEW_SOURCE_DATA");
      expect(submissions).toBe(1);
      expect(store.db.query("SELECT last_queued_timestamp,last_status FROM pyth_submission_state").get()).toEqual({last_queued_timestamp:0,last_status:"DELIVERY_UNCONFIRMED"});
      const newer=snapshot();newer.feeds[0]!.observedAt!++;
      expect((await publishSnapshot(newer,manifest(),store,{...deps,submit:acknowledge})).status).toBe("QUEUED_LOCAL");
    }finally{store.close();}
  });
  test("concurrent ticks cannot replace another publisher lease", async () => {
    const store=new Store(":memory:");let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const deps={now:()=>now,fetchCatalog:async()=>{entered();await gate;return catalog;},submit:acknowledge};
    try {
      const first=publishSnapshot(snapshot(),manifest(),store,deps);await started;
      expect((await publishSnapshot(snapshot(),manifest(),store,deps)).status).toBe("BUSY");
      expect((await publishSnapshot(snapshot(),manifest(),store,deps)).status).toBe("BUSY");
      release();expect((await first).status).toBe("QUEUED_LOCAL");
      expect((await publishSnapshot(snapshot(),manifest(),store,deps)).status).toBe("NO_NEW_SOURCE_DATA");
    }finally{release();store.close();}
  });
  test("changed official metadata blocks submission without reserving its source timestamp", async () => {
    const store=new Store(":memory:");
    try {
      expect((await publishSnapshot(snapshot(),manifest(),store,{now:()=>now,fetchCatalog:async()=>[{...catalog[0]!,exponent:-8}],submit:acknowledge})).status).toBe("BLOCKED");
      expect(store.db.query("SELECT COUNT(*) AS count FROM pyth_submission_state").get()).toEqual({count:0});
      expect((await publishSnapshot(snapshot(),manifest(),store,{now:()=>now,fetchCatalog:async()=>catalog,submit:acknowledge})).status).toBe("QUEUED_LOCAL");
    }finally{store.close();}
  });
});

/** Minimal test decoder for the official protobuf envelope, independent of client JSON. */
function protoFields(bytes: Uint8Array): Map<number, Array<bigint | Uint8Array>> {
  let offset = 0;
  const varint = () => { let result = 0n; let shift = 0n; for (let i = 0; i < 10; i++) { const byte = bytes[offset++]; if (byte === undefined) throw new Error("Truncated protobuf"); result |= BigInt(byte & 127) << shift; if (!(byte & 128)) return result; shift += 7n; } throw new Error("Oversized protobuf varint"); };
  const fields = new Map<number, Array<bigint | Uint8Array>>();
  while (offset < bytes.length) {
    const key = Number(varint()); const field = key >> 3; const wire = key & 7;
    let value: bigint | Uint8Array;
    if (wire === 0) value = varint();
    else if (wire === 2) { const length = Number(varint()); if (offset + length > bytes.length) throw new Error("Truncated protobuf field"); value = bytes.slice(offset, offset + length); offset += length; }
    else throw new Error(`Unsupported test protobuf wire type ${wire}`);
    fields.set(field, [...(fields.get(field) ?? []), value]);
  }
  return fields;
}
function messageField(fields: ReturnType<typeof protoFields>, id: number): Uint8Array { const item = fields.get(id)?.[0]; if (!(item instanceof Uint8Array)) throw new Error(`Missing protobuf message ${id}`); return item; }

// Opt in with an installed official binary. Tests use isolated temporary keys and
// a local receiving endpoint and never connect to the Pyth production relayers.
test.skipIf(!process.env.PYTH_AGENT_BIN)("official Pyth agent accepts JSON, signs protobuf and preserves our feed/price/time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sbx-pyth-conformance-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const seed = Buffer.from(jwk.d!, "base64url"); const pub = Buffer.from(jwk.x!, "base64url");
  const keyPath = join(dir, "test-key.json");
  const configPath = join(dir, "agent.toml");
  await writeFile(keyPath, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
  let received: Uint8Array | undefined;
  let auth: string | null = null;
  const relayer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) { auth = request.headers.get("Authorization"); return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); }, websocket: { message(_ws, message) { if (typeof message !== "string") received = new Uint8Array(message); } } });
  // Reserve an ephemeral port and release it immediately before the child binds.
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(null); } }); const agentPort = reservation.port; reservation.stop(true);
  await writeFile(configPath, `relayer_urls = ["ws://127.0.0.1:${relayer.port}/v1/transaction"]\npublish_keypair_path = ${JSON.stringify(keyPath)}\nlisten_address = "127.0.0.1:${agentPort}"\npublish_interval_duration = "25ms"\nenable_update_deduplication = false\n`);
  const child = Bun.spawn([process.env.PYTH_AGENT_BIN!, "--config", configPath], { stdout: "ignore", stderr: "pipe" });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(`http://127.0.0.1:${agentPort}/ready`)).ok; } catch {} if (ready) break; await Bun.sleep(25); }
    if (!ready) { child.kill(); await child.exited; throw new Error(`Official agent not ready: ${await new Response(child.stderr).text()}`); }
    const prepared = preparePythPublication(snapshot(), manifest(), catalog, now);
    expect((await submitToPythAgent(prepared, `ws://127.0.0.1:${agentPort}/v1/jrpc`)).status).toBe("QUEUED_LOCAL");
    for (let i = 0; i < 100 && !received; i++) await Bun.sleep(25);
    expect(received).toBeDefined();
    const envelope = protoFields(received!);
    const payload = messageField(envelope, 2);
    const signatureData = protoFields(messageField(protoFields(messageField(envelope, 1)), 1));
    expect(Buffer.from(messageField(signatureData, 2))).toEqual(pub);
    expect(verify(null, payload, publicKey, messageField(signatureData, 1))).toBe(true);
    expect(auth as string | null).toBe(`Bearer ${pub.toString("base64")}`);
    const publisherUpdate = protoFields(messageField(protoFields(payload), 1));
    const update = protoFields(messageField(publisherUpdate, 1));
    expect(update.get(1)?.[0]).toBe(12n);
    const timestamp = protoFields(messageField(update, 2));
    const sourceMicros = (timestamp.get(1)?.[0] as bigint) * 1_000_000n + (timestamp.get(2)?.[0] as bigint) / 1000n;
    expect(sourceMicros).toBe(BigInt((now - 12_345) * 1000));
    expect(protoFields(messageField(update, 3)).get(1)?.[0]).toBe(5_125_000n);
    expect((await readFile(keyPath, "utf8")).length).toBeGreaterThan(0);
  } finally {
    child.kill(); await child.exited;
    relayer.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
