import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateIdentity, signBatch, verifyBatch, canonical } from "../src/crypto";
import { calculate } from "../src/engine";
import { OracleNode } from "../src/network";
import { Store } from "../src/store";
import { JOURNAL_LIMITS } from "../src/journal";
import { MODELS, type Methodology, type Observation, type Registry } from "../src/types";

const at = 1_788_700_000_000;
function context() {
  const identities = [generateIdentity(), generateIdentity(), generateIdentity()];
  const providers = ["provider-a", "provider-b", "provider-c"];
  const registry: Registry = { schemaVersion: 1, network: "security-test", version: "1", providers: providers.map(id => ({ id, economicGroup: id, allowedHosts: ["prices.example.test"], sources: ["catalog"], rights: { collect: true, redistribute: true, derive: true, evidence: "test-only permission", expiresAt: null } })), operators: identities.map((identity, i) => ({ nodeId: identity.nodeId, publicKey: identity.publicKey, operatorGroup: `operator-${i}`, enabled: true })) };
  const weights = Object.fromEntries(providers.map(id => [id, 1]));
  const methodology: Methodology = { schemaVersion: 1, version: "test-v1", status: "APPROVED", effectiveAt: at - 1000, cohort: { procurement: "ON_DEMAND", priceBasis: "LIST", tenancy: "EXCLUSIVE", regions: ["us-test"] }, maxAgeMs: 60_000, futureToleranceMs: 1000, minOperatorGroups: 2, minProviderGroups: 3, maxCollectorDeviationBps: 100, maxProviderDispersionBps: 1000, providerWeights: { B200: weights, B300: weights, GB200: weights, GB300: weights }, modelWeights: { B200: 1, B300: 1, GB200: 1, GB300: 1 }, weightEvidence: "test-only equal weights" };
  const observations: Observation[] = providers.flatMap(provider => MODELS.map(model => ({ schemaVersion: 1, provider, source: "catalog", sku: `sku-${model}`, model, region: "us-test", procurement: "ON_DEMAND", priceBasis: "LIST", tenancy: "EXCLUSIVE", currency: "USD", unit: "USD_PER_GPU_HOUR", price: "5.000000", instancePrice: "40.000000", gpuCount: 8, includes: [], availableGpuCount: null, observedAt: at - 100, priceEffectiveAt: null, expiresAt: null, sourceUrl: "https://prices.example.test/catalog", evidenceHash: "c".repeat(64) })));
  const batches = identities.map(identity => signBatch({ schemaVersion: 1, network: registry.network, nodeId: identity.nodeId, publicKey: identity.publicKey, sequence: 1, createdAt: at, observations }, identity));
  return { identities, registry, methodology, observations, batches };
}

test("an unsigned Base64 pad-bit change cannot manufacture signed equivocation", () => {
  const { batches } = context();
  const original = batches[0]!;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const position = original.signature.length - 3;
  const code = alphabet.indexOf(original.signature[position]!);
  const variant = { ...original, signature: original.signature.slice(0, position) + alphabet[code | 1] + "==" };
  expect(Buffer.from(variant.signature, "base64")).toEqual(Buffer.from(original.signature, "base64"));
  expect(variant.signature).not.toBe(original.signature);
  expect(verifyBatch(variant)).toBe(false);
});

test("equivocation detection is independent of lower/higher sequence arrival order", () => {
  const { batches, identities, registry, methodology } = context();
  const initial = batches[0]!;
  const conflict = signBatch({ ...initial.payload, observations: initial.payload.observations.map(o => ({ ...o, price: "6.000000", instancePrice: "48.000000" })) }, identities[0]!);
  const newer = signBatch({ ...initial.payload, sequence: 2 }, identities[0]!);
  const a = calculate([initial, conflict, newer, ...batches.slice(1)], registry, methodology, at);
  const b = calculate([initial, newer, conflict, ...batches.slice(1)], registry, methodology, at);
  expect(canonical(a)).toBe(canonical(b));
  expect(a.publishable).toBe(false);
});

test("public static routes cannot read absolute files outside the public directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sbx-path-security-"));
  const publicDir = join(dir, "public");
  await mkdir(publicDir);
  const secret = join(dir, "private.js");
  await writeFile(secret, "private test fixture: must not be served");
  const { identities, registry, methodology } = context();
  const store = new Store(":memory:");
  try {
    const node = new OracleNode({ identity: identities[0]!, registry, methodology, store, publicDir, clock: () => at });
    const response = await node.handle(new Request(`http://localhost/${secret}`));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("private test fixture");
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("peer synchronization does not redistribute a captured report after source rights expire", async () => {
  const { identities, registry, methodology, batches } = context();
  for (const provider of registry.providers) provider.rights.expiresAt = at + 50;
  const store = new Store(":memory:");
  let posts = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      if (request.method === "POST") posts++;
      if (new URL(request.url).pathname === "/v1/equivocations") return Response.json({ proofs: [], hasMore: false, nextAfter: null });
      return Response.json({ reports: [] });
    },
  });
  try {
    store.accept(batches[0]!, at, true);
    const node = new OracleNode({ identity: identities[0]!, registry, methodology, store, clock: () => at + 100 });
    expect(node.publicReports()).toHaveLength(0);
    expect(await node.sync([`http://127.0.0.1:${server.port}`], true)).toEqual([{ peer: `http://127.0.0.1:${server.port}`, ok: true }]);
    expect(posts).toBe(0);
  } finally { store.close(); server.stop(true); }
});

test("candidate update floods replace one bounded row and cannot enter trusted history", () => {
  const { identities, batches } = context(), store = new Store(":memory:");
  try {
    for(let sequence=1;sequence<=128;sequence++) store.accept(signBatch({...batches[0]!.payload,sequence},identities[0]!),at,false);
    expect(store.counts().reports).toBe(0);
    expect(store.latestReports()).toHaveLength(0);
    expect(store.reportsAt(at)).toHaveLength(0);
    expect(store.candidateUsage().identities).toBe(1);
    expect(store.candidateUsage().bytes).toBeLessThan(JOURNAL_LIMITS.candidateBytes);
    expect(store.latestReport(identities[0]!.nodeId)!.payload.sequence).toBe(128);
    const oversized=signBatch({...batches[0]!.payload,sequence:129,observations:Array.from({length:700},()=>batches[0]!.payload.observations[0]!)},identities[0]!);
    expect(()=>store.accept(oversized,at,false)).toThrow("CANDIDATE_TOO_LARGE");
    expect(store.candidateUsage().identities).toBe(1);
  } finally { store.close(); }
});

test("many signed candidates cannot exceed the independent total byte budget", () => {
  const { batches } = context(), store = new Store(":memory:");
  const observations=Array.from({length:310},()=>batches[0]!.payload.observations[0]!);
  let rejected=false;
  try {
    for(let i=0;i<128;i++) {
      const identity=generateIdentity(),batch=signBatch({...batches[0]!.payload,nodeId:identity.nodeId,publicKey:identity.publicKey,observations},identity);
      try { store.accept(batch,at,false); }
      catch(error) { expect((error as Error).message).toBe("CANDIDATE_BYTE_CAPACITY"); rejected=true;break; }
    }
    expect(rejected).toBe(true);
    expect(store.candidateUsage().bytes).toBeLessThanOrEqual(JOURNAL_LIMITS.candidatesTotalBytes);
    expect(store.counts().reports).toBe(0);
    // An authorized report has a separate journal and remains admissible at candidate capacity.
    expect(store.accept(batches[0]!,at,true)).toBe("ACCEPTED");
    expect(store.latestReports()).toHaveLength(1);
  } finally { store.close(); }
},30_000);

test("candidate admission preserves nonce and never backdates untrusted history", () => {
  const { identities,batches }=context(),store=new Store(":memory:");
  const newer=signBatch({...batches[0]!.payload,sequence:2},identities[0]!);
  try {
    store.accept(newer,at,false);
    expect(()=>store.accept(batches[0]!,at+1,true)).toThrow("REPLAY");
    expect(store.accept(newer,at+1,true)).toBe("ACCEPTED");
    expect(store.candidateUsage()).toEqual({identities:0,bytes:0});
    expect(store.reportsAt(at)).toHaveLength(0);
    expect(store.reportsAt(at+1)).toHaveLength(1);
  } finally { store.close(); }
});

test("empty signed candidate identities cannot bypass the candidate count limit", () => {
  const {batches}=context(),store=new Store(":memory:");
  try {
    for(let i=0;i<=JOURNAL_LIMITS.candidateIdentities;i++) {
      const identity=generateIdentity(),batch=signBatch({...batches[0]!.payload,nodeId:identity.nodeId,publicKey:identity.publicKey,observations:[]},identity);
      if(i<JOURNAL_LIMITS.candidateIdentities)store.accept(batch,at,false);
      else expect(()=>store.accept(batch,at,false)).toThrow("CANDIDATE_CAPACITY");
    }
    expect(store.candidateUsage().identities).toBe(JOURNAL_LIMITS.candidateIdentities);
    expect(store.candidateUsage().bytes).toBeLessThan(JOURNAL_LIMITS.candidatesTotalBytes);
    expect(store.latestReports()).toHaveLength(0);
  } finally {store.close();}
},10_000);

test("only a valid signed conflict by a registered identity can trigger durable quarantine", () => {
  const { identities,registry,methodology,batches }=context(),store=new Store(":memory:");
  const node=new OracleNode({identity:identities[1]!,registry,methodology,store,clock:()=>at});
  const first=batches[0]!,second=signBatch({...first.payload,observations:[]},identities[0]!);
  try {
    expect(()=>node.receiveEquivocation({first,second:{...second,signature:"A".repeat(86)+"=="}})).toThrow("INVALID_EQUIVOCATION_SIGNATURE");
    const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",pos=second.signature.length-3;
    const alternate={...second,signature:second.signature.slice(0,pos)+alphabet[alphabet.indexOf(second.signature[pos]!)|1]+"=="};
    expect(()=>node.receiveEquivocation({first,second:alternate})).toThrow("INVALID_EQUIVOCATION_SIGNATURE");
    expect(()=>node.receiveEquivocation({first,second:first})).toThrow("INVALID_EQUIVOCATION_PAIR");
    expect(()=>node.receiveEquivocation({first,second:signBatch({...second.payload,sequence:2},identities[0]!)})).toThrow("INVALID_EQUIVOCATION_PAIR");
    const outsider=generateIdentity(),outside=signBatch({...first.payload,nodeId:outsider.nodeId,publicKey:outsider.publicKey},outsider);
    expect(()=>node.receiveEquivocation({first:outside,second:signBatch({...outside.payload,observations:[]},outsider)})).toThrow("UNTRUSTED_EQUIVOCATION_IDENTITY");
    expect(store.counts().equivocations).toBe(0);
    expect(node.receiveEquivocation({first,second}).status).toBe("RECORDED");
    expect(node.receiveEquivocation({first,second}).status).toBe("DUPLICATE");
    expect(()=>node.receive(signBatch({...first.payload,sequence:2},identities[0]!))).toThrow("QUARANTINED");
    expect(store.equivocationPage().proofs).toHaveLength(1);
  } finally { store.close(); }
});

test("one peer synchronization propagates independently verifiable equivocation evidence in both directions", async () => {
  const { identities,registry,methodology,batches }=context(),stores=[new Store(":memory:"),new Store(":memory:")];
  const nodes=[1,2].map((i,index)=>new OracleNode({identity:identities[i]!,registry,methodology,store:stores[index]!,clock:()=>at}));
  const servers=nodes.map(node=>Bun.serve({hostname:"127.0.0.1",port:0,fetch:request=>node.handle(request)}));
  try {
    nodes[0]!.receive(batches[0]);
    nodes[1]!.receive(signBatch({...batches[0]!.payload,sequence:2},identities[0]!));
    expect(()=>nodes[0]!.receive(signBatch({...batches[0]!.payload,observations:[]},identities[0]!))).toThrow("EQUIVOCATION");
    expect((await nodes[0]!.sync([servers[1]!.url.toString()],true))[0]!.ok).toBe(true);
    for(const store of stores) {expect(store.latestReports()).toHaveLength(0);expect(store.equivocationPage().proofs).toHaveLength(1);}
    expect((await nodes[1]!.sync([servers[0]!.url.toString()],true))[0]!.ok).toBe(true);
  } finally { for(const server of servers)server.stop(true);for(const store of stores)store.close(); }
});

test("proof pages are bounded and revoked source rights also prevent proof redistribution", async () => {
  const { identities,registry,methodology,batches }=context(),store=new Store(":memory:");
  const node=new OracleNode({identity:identities[2]!,registry,methodology,store,clock:()=>at});
  try {
    for(let i=0;i<2;i++)node.receiveEquivocation({first:batches[i]!,second:signBatch({...batches[i]!.payload,observations:[]},identities[i]!)});
    const first=node.publicEquivocations(0,1),second=node.publicEquivocations(first.nextAfter!,1);
    expect(first.proofs).toHaveLength(1);expect(first.hasMore).toBe(true);
    expect(second.proofs).toHaveLength(1);expect(second.hasMore).toBe(false);
    expect(second.nextAfter).toBeGreaterThan(first.nextAfter!);
    expect((await node.handle(new Request("http://node/v1/equivocations?limit=33"))).status).toBe(400);
    registry.providers[0]!.rights.redistribute=false;
    expect(node.publicEquivocations().proofs).toHaveLength(0);
    expect(store.equivocationPage().proofs).toHaveLength(2);
  } finally { store.close(); }
});

test("historical configuration hashes, exact snapshot lookup and capture bounds survive later changes", () => {
  const {identities,registry,methodology}=context(),store=new Store(":memory:");
  try {
    const digest=store.saveConfiguration(registry);
    registry.version="later-version";
    expect((store.configuration(digest) as Registry).version).toBe("1");
    const node=new OracleNode({identity:identities[0]!,registry,methodology,store,clock:()=>at}),snapshot=node.snapshot();
    store.snapshot(snapshot);expect(store.getSnapshot(1)).toEqual(snapshot);expect(store.getSnapshot(2)).toBeNull();
    expect(store.captureCounts()).toEqual({count:0,earliest:null,latest:null});
    store.capture([],[],at);store.capture([],[],at+1);
    expect(store.captureCounts()).toEqual({count:2,earliest:at,latest:at+1});
    store.db.query("UPDATE configurations SET payload=? WHERE hash=?").run("{}",digest);
    expect(()=>store.configuration(digest)).toThrow("CONFIGURATION_HASH_MISMATCH");
  } finally {store.close();}
});
