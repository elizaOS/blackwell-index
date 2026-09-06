// All data in this file is isolated test evidence. No provider requests are made.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonical, generateIdentity, hash, signBatch } from "../src/crypto";
import { defaultMethodology, defaultRegistry, type NodeConfig } from "../src/config";
import { calculate } from "../src/engine";
import { backupNode, createRecoveryKey, inspectBackup, RECOVERY_MARKER, restoreNode } from "../src/recovery";
import { Store } from "../src/store";
import type { NodeIdentity } from "../src/types";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { PYTH_PROTOCOL, type PythManifest, type PythPublication } from "../src/pyth";
import { publishSnapshot } from "../src/pyth/runtime";
import { environment } from "./helpers";

const directories:string[]=[];
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
const save=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value),{mode:0o600});
async function fixture() {
  const root=mkdtempSync(join(tmpdir(),"sbx-recovery-test-"));directories.push(root);
  mkdirSync(join(root,"data"),{mode:0o700});mkdirSync(join(root,"config"),{mode:0o700});
  const identity=generateIdentity(),registry=defaultRegistry("sbx-mainnet"),methodology=defaultMethodology();
  const config:NodeConfig={schemaVersion:1,network:registry.network,identityPath:"data/node-identity.json",databasePath:"data/node.sqlite",registryPath:"config/registry.local.json",methodologyPath:"config/methodology.local.json",
    host:"127.0.0.1",port:3410,intervalMs:300000,collectors:[],peers:["https://unused.example"],allowLoopbackPeers:false,pythManifestPath:"data/private-pyth.json"};
  const configPath=join(root,"config/node.local.json"),keyPath=join(root,"data/recovery.key"),outputPath=join(root,"bundle.sbx-backup");
  save(configPath,config);save(join(root,config.identityPath),identity);save(join(root,config.registryPath),registry);save(join(root,config.methodologyPath),methodology);
  save(join(root,"data/credentials.json"),{LAMBDA_API_KEY:"test-credential-must-not-be-copied"});save(join(root,"data/private-pyth.json"),{test:"must-not-be-copied"});
  const store=new Store(join(root,config.databasePath)),now=Date.now();
  store.saveConfiguration(registry);store.saveConfiguration(methodology);
  const body=Buffer.from('{"testOnly":"recovery-evidence"}'),evidenceHash=createHash("sha256").update(body).digest("hex");
  await store.archive({hash:evidenceHash,source:"isolated-test",url:"https://example.invalid/test",receivedAt:now,contentType:"application/json",body});
  store.capture([],[],now);
  const batch=signBatch({schemaVersion:1,network:registry.network,nodeId:identity.nodeId,publicKey:identity.publicKey,sequence:store.nextSequence(identity.nodeId),createdAt:now,observations:[]},identity);
  store.accept(batch,now,false);store.snapshot(calculate([],registry,methodology,now));
  createRecoveryKey(keyPath);
  return {root,identity,config,configPath,keyPath,outputPath,store,evidenceHash,batch,registry,methodology,now};
}
function backup(f:Awaited<ReturnType<typeof fixture>>) {return backupNode(f.root,f.configPath,f.outputPath,f.keyPath);}
async function publishedFixture() {
  const f=await fixture(),e=environment();
  const registry={...e.registry,network:f.config.network},methodology={...e.methodology,effectiveAt:f.now-10_000};
  const batches=e.batches.map((batch,index)=>signBatch({...batch.payload,network:registry.network,createdAt:f.now,
    observations:batch.payload.observations.map(observation=>({...observation,observedAt:f.now-1000,priceEffectiveAt:f.now-86_400_000*30}))},e.identities[index]!));
  f.store.saveConfiguration(registry);f.store.saveConfiguration(methodology);
  save(join(f.root,f.config.registryPath),registry);save(join(f.root,f.config.methodologyPath),methodology);
  for(const batch of batches)f.store.accept(batch,f.now,true);
  const snapshot=calculate(batches,registry,methodology,f.now);
  expect(snapshot.publishable).toBe(true);f.store.snapshot(snapshot);
  return {...f,historicalRegistry:registry,historicalMethodology:methodology,historicalIdentities:e.identities,batches,snapshot};
}
function recordProof(f:Awaited<ReturnType<typeof fixture>>) {
  const second=signBatch({...f.batch.payload,createdAt:f.now+1},f.identity);
  f.store.recordEquivocation({first:f.batch,second},f.now+2);
  return {first:f.batch,second};
}

test("encrypted recovery includes committed WAL state and verifies retained evidence/history",async()=>{
  const f=await fixture();
  try {
    const result=backup(f),inspection=inspectBackup(f.outputPath,f.keyPath);
    expect(result.counts.captures).toBe(1);expect(inspection.counts.candidates).toBe(1);expect(inspection.counts.evidence).toBe(1);
    expect(inspection.pythRecovery).toEqual({present:false,states:0,receipts:0,locks:0,upstreamPublication:"NOT_PROVEN"});
    expect(inspection.history.valid).toBe(true);expect(inspection.sourceNodeId).toBe(f.identity.nodeId);
    expect(result.privateKeysIncluded).toBe(false);expect(result.providerCredentialsIncluded).toBe(false);
    const serialized=readFileSync(f.outputPath,"utf8");
    expect(serialized).not.toContain("recovery-evidence");expect(serialized).not.toContain(f.identity.privateKeyPem);expect(serialized).not.toContain("test-credential-must-not-be-copied");
    expect(statSync(f.keyPath).mode&0o777).toBe(0o600);expect(statSync(f.outputPath).mode&0o777).toBe(0o600);
    expect(f.store.counts().captures).toBe(1);
  }finally{f.store.close();}
});

test("restore creates a new identity, retains history, disables network/collectors and requires review",async()=>{
  const f=await fixture(),destination=join(f.root,"restored");
  try {
    backup(f);const result=restoreNode(f.outputPath,f.keyPath,destination);
    const identity=JSON.parse(readFileSync(join(destination,f.config.identityPath),"utf8")) as NodeIdentity;
    const config=JSON.parse(readFileSync(join(destination,"config/node.local.json"),"utf8")) as NodeConfig;
    expect(identity.nodeId).not.toBe(f.identity.nodeId);expect(identity.privateKeyPem).not.toBe(f.identity.privateKeyPem);expect(result.status).toBe("RECOVERY_REVIEW_REQUIRED");
    expect(config.collectors).toEqual([]);expect(config.peers).toEqual([]);expect(config.host).toBe("127.0.0.1");expect(config.pythManifestPath).toBeUndefined();
    expect(existsSync(join(destination,RECOVERY_MARKER))).toBe(true);
    expect(existsSync(join(destination,"data/credentials.json"))).toBe(false);expect(existsSync(join(destination,"data/private-pyth.json"))).toBe(false);
    const restored=new Store(join(destination,"data/node.sqlite"));
    try {
      expect(restored.verifyHistory()).toEqual(f.store.verifyHistory());
      expect(restored.configuration(hash(defaultMethodology()))).toEqual(defaultMethodology());
      const row=restored.db.query("SELECT body FROM evidence WHERE hash=?").get(f.evidenceHash) as {body:Uint8Array};
      expect(Buffer.from(row.body).toString()).toContain("recovery-evidence");
      expect(restored.nextSequence(f.identity.nodeId)).toBe(2);
    }finally{restored.close();}
  }finally{f.store.close();}
});

test("wrong key or altered authentication tag is rejected before creating a restore target",async()=>{
  const f=await fixture(),destination=join(f.root,"not-created"),otherKey=join(f.root,"other.key");
  try {
    backup(f);createRecoveryKey(otherKey);
    expect(()=>restoreNode(f.outputPath,otherKey,destination)).toThrow("authentication failed");expect(existsSync(destination)).toBe(false);
    const envelope=JSON.parse(readFileSync(f.outputPath,"utf8"));envelope.tag=Buffer.alloc(16).toString("base64");save(f.outputPath,envelope);
    expect(()=>restoreNode(f.outputPath,f.keyPath,destination)).toThrow("authentication failed");expect(existsSync(destination)).toBe(false);
  }finally{f.store.close();}
});

test("existing keys, bundles and destination directories are never overwritten",async()=>{
  const f=await fixture(),destination=join(f.root,"existing");
  try {
    const key=readFileSync(f.keyPath,"utf8");expect(()=>createRecoveryKey(f.keyPath)).toThrow();expect(readFileSync(f.keyPath,"utf8")).toBe(key);
    backup(f);const original=readFileSync(f.outputPath,"utf8");expect(()=>backup(f)).toThrow("already exists");expect(readFileSync(f.outputPath,"utf8")).toBe(original);
    mkdirSync(destination);save(join(destination,"keep.json"),{keep:true});
    expect(()=>restoreNode(f.outputPath,f.keyPath,destination)).toThrow("existing data will not be overwritten");expect(readFileSync(join(destination,"keep.json"),"utf8")).toBe('{"keep":true}');
  }finally{f.store.close();}
});

test("recovery refuses shared key permissions and malformed key encoding",async()=>{
  const f=await fixture();
  try {
    chmodSync(f.keyPath,0o644);expect(()=>backup(f)).toThrow("group or other users");expect(existsSync(f.outputPath)).toBe(false);
    chmodSync(f.keyPath,0o600);writeFileSync(f.keyPath,"not-a-32-byte-key");expect(()=>backup(f)).toThrow("encoding");
  }finally{f.store.close();}
});

test("a tampered source evidence body cannot be sealed as a verified recovery bundle",async()=>{
  const f=await fixture();
  try {
    f.store.db.query("UPDATE evidence SET body=?").run(Buffer.from("corrupted test bytes"));
    expect(()=>backup(f)).toThrow("evidence digest mismatch");expect(existsSync(f.outputPath)).toBe(false);
  }finally{f.store.close();}
});

test("a tampered snapshot chain cannot be sealed as a verified recovery bundle",async()=>{
  const f=await fixture();
  try {
    f.store.db.query("UPDATE snapshots SET hash=?").run("a".repeat(64));
    expect(()=>backup(f)).toThrow("history verification failed");expect(existsSync(f.outputPath)).toBe(false);
  }finally{f.store.close();}
});

test("recovery reproduces nonempty snapshots with their historical configuration after admission changes",async()=>{
  const f=await publishedFixture();
  try {
    // The current registry no longer admits the old operators. Their signed historical
    // reports have no local signing counters, and remote evidence is held by peers.
    save(join(f.root,f.config.registryPath),f.registry);save(join(f.root,f.config.methodologyPath),f.methodology);
    const result=backup(f),inspection=inspectBackup(f.outputPath,f.keyPath);
    expect(result.reproducedSnapshots).toBe(2);expect(inspection.reproducedSnapshots).toBe(2);
    expect(result.counts.reports).toBe(3);expect(result.counts.candidates).toBe(1);
    expect(result.quarantineProofs).toEqual({verified:0,unavailable:0,requiresReview:false});
  }finally{f.store.close();}
});

test("a formerly admitted signer may retain trusted history and a newer private candidate",async()=>{
  const f=await fixture();
  try {
    const admitted={...f.registry,version:"previous-admission",operators:[{nodeId:f.identity.nodeId,publicKey:f.identity.publicKey,operatorGroup:"historical-operator",enabled:true}]};
    f.store.saveConfiguration(admitted);f.store.accept(f.batch,f.now,true);
    f.store.snapshot(calculate([f.batch],admitted,f.methodology,f.now));
    const pending=signBatch({...f.batch.payload,sequence:f.store.nextSequence(f.identity.nodeId),createdAt:f.now+1},f.identity);
    f.store.accept(pending,f.now+1,false);
    const result=backup(f);
    expect(result.reproducedSnapshots).toBe(2);expect(result.counts.reports).toBe(1);expect(result.counts.candidates).toBe(1);
  }finally{f.store.close();}
});

test("missing nonempty snapshot reports cannot be hidden by a still-valid hash chain",async()=>{
  const f=await publishedFixture();
  try {
    f.store.db.query("DELETE FROM reports WHERE hash=?").run(hash(f.batches[0]));
    expect(f.store.verifyHistory().valid).toBe(true);
    expect(()=>backup(f)).toThrow("snapshot report reference missing");expect(existsSync(f.outputPath)).toBe(false);
  }finally{f.store.close();}
});

test("rejected input references also require the original signed report",async()=>{
  const f=await publishedFixture();
  try {
    // Existing trusted history can become rejected after the operator is removed.
    const rejected=calculate(f.batches,f.registry,f.methodology,f.now+1);
    expect(rejected.rejected).toHaveLength(3);f.store.snapshot(rejected);
    // Drop the earlier accepted snapshot, keeping a valid one-record hash chain.
    f.store.db.query("DELETE FROM snapshots WHERE id<3").run();
    f.store.db.query("UPDATE snapshots SET previous_hash=NULL,hash=? WHERE id=3").run(hash({previousHash:null,snapshot:rejected}));
    f.store.db.query("DELETE FROM reports WHERE hash=?").run(hash(f.batches[0]));
    expect(f.store.verifyHistory().valid).toBe(true);expect(()=>backup(f)).toThrow("snapshot report reference missing");
  }finally{f.store.close();}
});

for(const kind of ["registry","methodology"] as const)test(`missing archived ${kind} blocks recovery even when current configuration exists`,async()=>{
  const f=await publishedFixture();
  try {
    f.store.db.query("DELETE FROM configurations WHERE hash=?").run(kind==="registry"?f.snapshot.registryHash:f.snapshot.methodologyHash);
    expect(f.store.verifyHistory().valid).toBe(true);expect(()=>backup(f)).toThrow("snapshot configuration reference missing");
  }finally{f.store.close();}
});

test("a rehashed but incorrectly calculated price is not a verified recovery snapshot",async()=>{
  const f=await publishedFixture();
  try {
    const altered=structuredClone(f.snapshot);altered.feeds.at(-1)!.price="999.000000";
    const row=f.store.db.query("SELECT previous_hash FROM snapshots WHERE id=2").get() as {previous_hash:string};
    f.store.db.query("UPDATE snapshots SET payload=?,hash=? WHERE id=2").run(canonical(altered),hash({previousHash:row.previous_hash,snapshot:altered}));
    expect(f.store.verifyHistory().valid).toBe(true);expect(()=>backup(f)).toThrow("calculation reproduction mismatch");
  }finally{f.store.close();}
});

for(const table of ["reports","candidates"] as const)for(const column of ["node_id","sequence"] as const)test(`signed ${table} cannot be routed under a different ${column}`,async()=>{
  const f=await publishedFixture();
  try {
    const digest=table==="reports"?hash(f.batches[0]):hash(f.batch);
    f.store.db.query(`UPDATE ${table} SET ${column}=? WHERE hash=?`).run(column==="node_id"?"b".repeat(64):42,digest);
    expect(()=>backup(f)).toThrow("report routing mismatch");
  }finally{f.store.close();}
});

test("snapshot SQL timestamps cannot differ from the reproduced signed-input calculation",async()=>{
  const f=await fixture();
  try {
    f.store.db.query("UPDATE snapshots SET calculated_at=calculated_at+1").run();
    expect(f.store.verifyHistory().valid).toBe(true);expect(()=>backup(f)).toThrow("snapshot routing mismatch");
  }finally{f.store.close();}
});

test("signed equivocation proofs remain valid after current membership changes",async()=>{
  const f=await fixture();
  try {
    recordProof(f);
    expect(backup(f).quarantineProofs).toEqual({verified:1,unavailable:0,requiresReview:false});
    const destination=join(f.root,"quarantined-restore");restoreNode(f.outputPath,f.keyPath,destination);
    const restored=new Store(join(destination,"data/node.sqlite"));
    try {expect(restored.latestReport(f.identity.nodeId)).toBeNull();}finally{restored.close();}
  }finally{f.store.close();}
});

test("forged archived equivocation signatures are rejected",async()=>{
  const f=await fixture();
  try {
    const proof=recordProof(f);proof.second.signature=Buffer.alloc(64).toString("base64");
    f.store.db.query("UPDATE equivocation_proofs SET second_payload=?").run(canonical(proof.second));
    expect(()=>backup(f)).toThrow("equivocation proof verification failed");
  }finally{f.store.close();}
});

for(const mutation of ["routing","missing-exclusion","hash-linkage","byte-accounting"] as const)test(`archived proof ${mutation} corruption cannot be sealed`,async()=>{
  const f=await fixture();
  try {
    const proof=recordProof(f);
    if(mutation==="routing")f.store.db.query("UPDATE equivocation_proofs SET node_id=?").run("b".repeat(64));
    else if(mutation==="missing-exclusion")f.store.db.query("DELETE FROM equivocations").run();
    else if(mutation==="hash-linkage")f.store.db.query("UPDATE equivocations SET conflicting_payload=?").run(canonical({sequence:1,first:"b".repeat(64),second:hash(proof.second)}));
    else f.store.db.query("UPDATE equivocation_proofs SET payload_bytes=1").run();
    expect(()=>backup(f)).toThrow(mutation==="routing"||mutation==="byte-accounting"?"proof routing mismatch":"quarantine linkage mismatch");
  }finally{f.store.close();}
});

test("quarantine-only records remain excluded and explicitly require proof review",async()=>{
  const f=await fixture();
  try {
    recordProof(f);f.store.db.query("DELETE FROM equivocation_proofs").run();
    // This is also the state produced when the bounded proof archive is full.
    const result=backup(f);expect(result.quarantineProofs).toEqual({verified:0,unavailable:1,requiresReview:true});
    expect(inspectBackup(f.outputPath,f.keyPath).quarantineProofs.requiresReview).toBe(true);
    const destination=join(f.root,"proof-review-restore");restoreNode(f.outputPath,f.keyPath,destination);
    const restored=new Store(join(destination,"data/node.sqlite"));
    try {expect(restored.latestReport(f.identity.nodeId)).toBeNull();expect(restored.counts().equivocations).toBe(1);}finally{restored.close();}
  }finally{f.store.close();}
});

test("a retained source signature requires its durable signing counter",async()=>{
  const f=await fixture();
  try {f.store.db.query("DELETE FROM counters").run();expect(()=>backup(f)).toThrow("source signing counter missing");}finally{f.store.close();}
});

test("signing counter highwater rejects rollback but permits unused allocated sequences",async()=>{
  const f=await fixture();
  try {
    const next=signBatch({...f.batch.payload,sequence:f.store.nextSequence(f.identity.nodeId)},f.identity);
    f.store.accept(next,f.now+1,false);
    f.store.db.query("UPDATE counters SET value=1").run();expect(()=>backup(f)).toThrow("signing counter highwater mismatch");
    f.store.db.query("UPDATE counters SET value=4").run();expect(backup(f).history.valid).toBe(true);
  }finally{f.store.close();}
});

test("local signing counters also cover signed sequences retained only in equivocation proofs",async()=>{
  const f=await fixture();
  try {
    const first=signBatch({...f.batch.payload,sequence:4},f.identity),second=signBatch({...f.batch.payload,sequence:4,createdAt:f.now+1},f.identity);
    f.store.recordEquivocation({first,second},f.now+2);
    expect(()=>backup(f)).toThrow("signing counter highwater mismatch");
    f.store.db.query("UPDATE counters SET value=4").run();expect(backup(f).quarantineProofs.verified).toBe(1);
  }finally{f.store.close();}
});

test("restored CLI refuses serving or collection while exact historical reproduction stays available",async()=>{
  const f=await fixture(),destination=join(f.root,"restored-cli");
  try {
    backup(f);restoreNode(f.outputPath,f.keyPath,destination);
    for(const command of ["run","collect"]) {
      const process=Bun.spawn([processExec(),resolve(import.meta.dir,"../src/cli.ts"),command,"--dir",destination],{stdout:"pipe",stderr:"pipe"});
      expect(await process.exited).toBe(1);expect(await new Response(process.stderr).text()).toContain("RECOVERY_REVIEW_REQUIRED");
    }
    const child=Bun.spawn([processExec(),resolve(import.meta.dir,"../src/cli.ts"),"reproduce","--dir",destination,"--sequence","1"],{stdout:"pipe",stderr:"pipe"});
    const output=await new Response(child.stdout).text();expect(await child.exited).toBe(0);expect(JSON.parse(output).matches).toBe(true);
  }finally{f.store.close();}
},20_000);
function processExec(){return process.execPath;}

async function pythFixture() {
  const f=await publishedFixture();
  const bindings=f.snapshot.feeds.filter(feed=>feed.kind==="MODEL").map((feed,index)=>({indexFeedId:feed.id,pythFeedId:12+index,symbol:`TEST.${feed.id}/USD`,exponent:-6,minPublishers:3}));
  expect(bindings).toHaveLength(4);
  const manifest:PythManifest={schemaVersion:1,enabled:true,network:f.snapshot.network,methodologyHash:f.snapshot.methodologyHash,registryHash:f.snapshot.registryHash,
    agentUrl:"ws://127.0.0.1:8910/v1/jrpc",maxAgeMs:30_000,futureToleranceMs:1000,
    approval:{status:"APPROVED",publisherPublicKey:"11111111111111111111111111111111",evidence:"Isolated recovery test approval",verifiedAt:f.now-1000,expiresAt:f.now+100_000,protocol:PYTH_PROTOCOL,relayerUrls:["wss://publisher.example.test/v1/transaction"]},bindings};
  const catalog=bindings.map(binding=>({pyth_lazer_id:binding.pythFeedId,symbol:binding.symbol,exponent:binding.exponent,min_publishers:binding.minPublishers,state:"stable"}));
  const dependencies={now:()=>f.now,fetchCatalog:async()=>catalog,submit:async(publication:PythPublication)=>({status:"QUEUED_LOCAL" as const,requestId:publication.request.id,snapshotHash:publication.snapshotHash,queuedAt:f.now})};
  const first=await publishSnapshot(f.snapshot,manifest,f.store,dependencies);
  expect(first.status).toBe("QUEUED_LOCAL");expect(first.feeds).toHaveLength(4);
  const publisher=hash({network:manifest.network,publisherPublicKey:manifest.approval.publisherPublicKey});
  return {...f,manifest,catalog,dependencies,publisher,first};
}
function pythRows(store:Store) {
  return {states:store.db.query("SELECT * FROM pyth_submission_state ORDER BY publisher,feed_id").all(),
    receipts:store.db.query("SELECT * FROM pyth_queue_receipts ORDER BY request_id").all(),
    locks:store.db.query("SELECT * FROM pyth_runtime_locks ORDER BY id").all()};
}
function advancePythFixture(f:Awaited<ReturnType<typeof pythFixture>>) {
  const batches=f.batches.map((batch,index)=>signBatch({...batch.payload,sequence:batch.payload.sequence+1,
    observations:batch.payload.observations.map(observation=>({...observation,observedAt:f.now-500}))},f.historicalIdentities[index]!));
  for(const batch of batches)f.store.accept(batch,f.now,true);
  const snapshot=calculate(batches,f.historicalRegistry,f.historicalMethodology,f.now);
  expect(snapshot.publishable).toBe(true);f.store.snapshot(snapshot);
  return snapshot;
}

test("V1 preserves real four-model Pyth attempts and legacy receipts while clearing only restored process leases",async()=>{
  const f=await pythFixture(),destination=join(f.root,"pyth-restored");
  try {
    const newer=advancePythFixture(f);
    expect((await publishSnapshot(newer,f.manifest,f.store,{...f.dependencies,submit:async()=>{throw new Error("Isolated lost acknowledgement");}})).status).toBe("DELIVERY_UNCONFIRMED");
    f.store.db.query("INSERT INTO pyth_runtime_locks(id,owner,expires_at) VALUES(?,?,?)").run(f.publisher,randomUUID(),f.now+30_000);
    const before=pythRows(f.store),result=backup(f),inspection=inspectBackup(f.outputPath,f.keyPath);
    expect(result.pythRecovery).toEqual({present:true,states:4,receipts:1,locks:1,upstreamPublication:"NOT_PROVEN"});
    expect(inspection.pythRecovery).toEqual(result.pythRecovery);
    const restoredResult=restoreNode(f.outputPath,f.keyPath,destination);
    expect(restoredResult.newNodeId).not.toBe(f.identity.nodeId);expect(restoredResult.pythRuntimeLocksCleared).toBe(1);
    expect(pythRows(f.store)).toEqual(before);
    const marker=JSON.parse(readFileSync(join(destination,RECOVERY_MARKER),"utf8"));
    expect(marker.pythRecovery).toEqual(result.pythRecovery);expect(marker.pythRuntimeLocksCleared).toBe(1);
    expect(marker.requirements.join(" ")).toContain("stop or revoke the old Pyth publisher");
    expect(marker.requirements.join(" ")).toContain("attempts after this backup");
    const config=JSON.parse(readFileSync(join(destination,"config/node.local.json"),"utf8")) as NodeConfig;
    expect(config.pythManifestPath).toBeUndefined();expect(config.collectors).toEqual([]);expect(config.peers).toEqual([]);
    expect(existsSync(join(destination,"data/private-pyth.json"))).toBe(false);
    const restored=new Store(join(destination,"data/node.sqlite"));
    try {
      expect(pythRows(restored)).toEqual({...before,locks:[]});
      expect(restored.verifyHistory()).toEqual(f.store.verifyHistory());
      // Explicit isolated runtime calls prove the saved publisher namespace still
      // fences old attempts; the restored CLI remains review-gated below.
      let submitted=0;
      const dependencies={...f.dependencies,submit:async(...args:Parameters<typeof f.dependencies.submit>)=>{submitted++;return f.dependencies.submit(...args);}};
      expect((await publishSnapshot(f.snapshot,f.manifest,restored,dependencies)).status).toBe("NO_NEW_SOURCE_DATA");
      expect((await publishSnapshot(newer,f.manifest,restored,dependencies)).status).toBe("NO_NEW_SOURCE_DATA");
      expect(submitted).toBe(0);
      const differentPublisher={...f.manifest,approval:{...f.manifest.approval,publisherPublicKey:"22222222222222222222222222222222"}};
      expect((await publishSnapshot(newer,differentPublisher,restored,dependencies)).status).toBe("QUEUED_LOCAL");
      expect(submitted).toBe(1);
      expect(restored.db.query("SELECT * FROM pyth_submission_state WHERE publisher=? ORDER BY feed_id").all(f.publisher)).toEqual(before.states);
    }finally{restored.close();}
    for(const command of ["run","collect"]) {
      const child=Bun.spawn([processExec(),resolve(import.meta.dir,"../src/cli.ts"),command,"--dir",destination],{stdout:"pipe",stderr:"pipe"});
      expect(await child.exited).toBe(1);expect(await new Response(child.stderr).text()).toContain("RECOVERY_REVIEW_REQUIRED");
    }
  }finally{f.store.close();}
},20_000);

test("V1 backup freezes an in-flight reserved Pyth attempt and excludes its later acknowledgement",async()=>{
  const f=await pythFixture(),destination=join(f.root,"in-flight-restored");
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  let pending:ReturnType<typeof publishSnapshot>|undefined;
  try {
    const newer=advancePythFixture(f);
    pending=publishSnapshot(newer,f.manifest,f.store,{...f.dependencies,submit:async publication=>{entered();await gate;return f.dependencies.submit(publication);}});
    await started;
    const frozen=pythRows(f.store);expect(backup(f).pythRecovery).toEqual({present:true,states:4,receipts:1,locks:1,upstreamPublication:"NOT_PROVEN"});
    release();expect((await pending).status).toBe("QUEUED_LOCAL");expect(pythRows(f.store).receipts).toHaveLength(2);
    expect(inspectBackup(f.outputPath,f.keyPath).pythRecovery.receipts).toBe(1);
    restoreNode(f.outputPath,f.keyPath,destination);
    const restored=new Store(join(destination,"data/node.sqlite"));
    try {expect(pythRows(restored)).toEqual({...frozen,locks:[]});}finally{restored.close();}
  }finally{release();await pending;f.store.close();}
});

test("V1 does not require pruned Pyth receipts or replace legacy raw-JSON snapshot hashes",async()=>{
  const f=await pythFixture(),destination=join(f.root,"legacy-pyth-restored");
  try {
    const receipt=f.store.db.query("SELECT snapshot_hash FROM pyth_queue_receipts").get() as {snapshot_hash:string};
    expect(receipt.snapshot_hash).toBe(createHash("sha256").update(JSON.stringify(f.snapshot)).digest("hex"));
    expect(receipt.snapshot_hash).not.toBe(hash(f.snapshot));
    backup(f);restoreNode(f.outputPath,f.keyPath,destination);
    const restored=new Store(join(destination,"data/node.sqlite"));
    try {expect(restored.db.query("SELECT snapshot_hash FROM pyth_queue_receipts").get()).toEqual(receipt);}finally{restored.close();}
    // Runtime receipt retention is bounded independently of durable high-water marks.
    f.store.db.query("DELETE FROM pyth_queue_receipts").run();
    const withoutReceipts=backupNode(f.root,f.configPath,join(f.root,"pruned.sbx-backup"),f.keyPath);
    expect(withoutReceipts.pythRecovery).toEqual({present:true,states:4,receipts:0,locks:0,upstreamPublication:"NOT_PROVEN"});
  }finally{f.store.close();}
});

const pythMutations:Record<string,(db:Store["db"],now:number)=>void>={
  "partial tables":db=>db.exec("DROP TABLE pyth_queue_receipts"),
  "extra column":db=>db.exec("ALTER TABLE pyth_submission_state ADD COLUMN ignored TEXT"),
  "unknown runtime table":db=>db.exec("CREATE TABLE pyth_unreviewed_state(value TEXT)"),
  "runtime view":db=>db.exec("CREATE VIEW pyth_unreviewed_view AS SELECT * FROM pyth_submission_state"),
  "runtime trigger":db=>db.exec("CREATE TRIGGER pyth_unreviewed_trigger AFTER DELETE ON pyth_runtime_locks BEGIN DELETE FROM pyth_submission_state; END"),
  "runtime foreign key":db=>rebuildPythState(db,",FOREIGN KEY(publisher) REFERENCES pyth_runtime_locks(id) ON DELETE CASCADE"),
  "runtime unique constraint":db=>rebuildPythState(db,",UNIQUE(last_attempt_id,feed_id)"),
  "runtime check constraint":db=>rebuildPythState(db,",CHECK(feed_id<100000)"),
  "runtime collation":db=>rebuildPythState(db,""," COLLATE NOCASE"),
  "queued timestamp rollback":db=>db.exec("UPDATE pyth_submission_state SET last_queued_timestamp=last_attempted_timestamp+1"),
  "unsafe attempted timestamp":db=>db.exec("UPDATE pyth_submission_state SET last_attempted_timestamp=9007199254740992"),
  "noninteger feed id":db=>db.exec("UPDATE pyth_submission_state SET feed_id=feed_id+0.5"),
  "unknown status":db=>db.exec("UPDATE pyth_submission_state SET last_status='PUBLISHED'"),
  "future state":(db,now)=>db.query("UPDATE pyth_submission_state SET updated_at=?").run(now+86_400_000),
  "future receipt":(db,now)=>db.query("UPDATE pyth_queue_receipts SET queued_at=?").run(now+86_400_000),
  "duplicate receipt feeds":db=>db.query("UPDATE pyth_queue_receipts SET feeds=?").run(JSON.stringify([{feedId:12,sourceTimestamp:1},{feedId:12,sourceTimestamp:1}])),
  "receipt state mismatch":db=>db.query("UPDATE pyth_queue_receipts SET feeds=?").run(JSON.stringify([{feedId:12,sourceTimestamp:1}])),
};
function rebuildPythState(db:Store["db"],constraint:string,publisherCollation="") {
  // These definitions retain identical table_xinfo columns but alter SQL behavior.
  db.exec(`ALTER TABLE pyth_submission_state RENAME TO pyth_test_prior_state;
    CREATE TABLE pyth_submission_state (publisher TEXT NOT NULL${publisherCollation},feed_id INTEGER NOT NULL,last_attempted_timestamp INTEGER NOT NULL,last_queued_timestamp INTEGER NOT NULL,last_attempt_id TEXT NOT NULL,last_status TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(publisher,feed_id)${constraint});
    INSERT INTO pyth_submission_state SELECT * FROM pyth_test_prior_state;
    DROP TABLE pyth_test_prior_state;`);
}
for(const [name,mutate] of Object.entries(pythMutations))test(`V1 refuses malformed Pyth ${name} before sealing`,async()=>{
  const f=await pythFixture();
  try {mutate(f.store.db,f.now);expect(()=>backup(f)).toThrow("PYTH_RECOVERY_");expect(existsSync(f.outputPath)).toBe(false);}finally{f.store.close();}
});

/** Re-seal isolated test data to test the reader independently of producer checks. */
function alterEncryptedDatabase(f:Awaited<ReturnType<typeof fixture>>,mutate:(db:Database)=>void) {
  const envelope=JSON.parse(readFileSync(f.outputPath,"utf8")),key=Buffer.from(readFileSync(f.keyPath,"utf8").trim(),"base64"),aad=Buffer.from("SBX_NODE_RECOVERY_V1");
  const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(envelope.nonce,"base64"));decipher.setAAD(aad);decipher.setAuthTag(Buffer.from(envelope.tag,"base64"));
  const payload=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,"base64")),decipher.final()]).toString("utf8"));
  const path=join(f.root,"isolated-tamper.sqlite");writeFileSync(path,Buffer.from(payload.database.body,"base64"),{mode:0o600});
  const db=new Database(path);try {mutate(db);}finally{db.close();}
  const body=readFileSync(path);payload.database={sha256:createHash("sha256").update(body).digest("hex"),body:body.toString("base64")};
  const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,nonce);cipher.setAAD(aad);
  const ciphertext=Buffer.concat([cipher.update(canonical(payload)),cipher.final()]);
  save(f.outputPath,{format:envelope.format,nonce:nonce.toString("base64"),tag:cipher.getAuthTag().toString("base64"),ciphertext:ciphertext.toString("base64")});key.fill(0);
}
for(const kind of ["state","schema"] as const)test(`V1 independently rejects authenticated malformed Pyth ${kind} before restore output`,async()=>{
  const f=await pythFixture(),destination=join(f.root,"must-not-exist");
  try {
    backup(f);alterEncryptedDatabase(f,db=>db.exec(kind==="state"?"UPDATE pyth_submission_state SET last_queued_timestamp=last_attempted_timestamp+1":"CREATE TRIGGER imported_runtime_trigger AFTER DELETE ON pyth_runtime_locks BEGIN DELETE FROM pyth_submission_state; END"));
    expect(()=>inspectBackup(f.outputPath,f.keyPath)).toThrow("PYTH_RECOVERY_");
    expect(()=>restoreNode(f.outputPath,f.keyPath,destination)).toThrow("PYTH_RECOVERY_");expect(existsSync(destination)).toBe(false);
  }finally{f.store.close();}
});
