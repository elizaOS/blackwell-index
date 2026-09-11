// Synthetic capacity/security fixtures only. No provider or deployed-node traffic.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ARCHIVE_TABLES, archiveBlockHash, archiveDescriptorHash, archiveRecordKey, encodeArchiveRecord, signArchiveDescriptor, signArchiveSeal, type ArchiveBlock, type ArchiveCell, type ArchiveCursor, type ArchiveDescriptor, type ArchiveFragment } from "../src/archive-protocol";
import { ChunkedJournal, CHUNKED_JOURNAL_VERSION, EVIDENCE_CHUNK_BYTES } from "../src/chunked-journal";
import { collectorSchedule } from "../src/collection-control";
import { canonical, hash, signBatch } from "../src/crypto";
import { calculate } from "../src/engine";
import { encodeHostedCell } from "../src/hosted-export";
import { backupNode, createRecoveryKey, RECOVERY_MARKER } from "../src/recovery";
import { backupStreamFrames, inspectStreamBackup, restoreStreamNode, type StreamRecoveryOptions } from "../src/stream-recovery";
import { writeStreamContainer } from "../src/stream-container";
import { Store } from "../src/store";
import type { Methodology } from "../src/types";
import { environment, NOW } from "./helpers";

const RELEASE="ef".repeat(20),directories:string[]=[],stores=new Set<Store>();
afterEach(()=>{for(const store of stores)store.close();stores.clear();for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
const digest=(body:Uint8Array)=>createHash("sha256").update(body).digest("hex");
async function fixture(split=false,scoped=false,scheduled=false,withResources=false) {
  const directory=mkdtempSync(join(tmpdir(),"sbx-stream-recovery-test-"));directories.push(directory);
  const store=new Store(join(directory,"source.sqlite"));stores.add(store);
  const journal=new ChunkedJournal(store.db),e=environment(),identity=e.identities[0]!;
  if(scoped || scheduled) {
    e.methodology.publicationScope={kind:"MODEL",model:"B200",approvalEvidence:"Synthetic streaming recovery scope"};
    for(const model of ["B300","GB200","GB300"] as const)e.methodology.providerWeights[model]={};
  }
  if(scheduled) {
    for(const observation of e.observations) {
      observation.priceScope="PUBLIC";observation.topology="HGX";observation.minimumOrderGpuCount=8;
      observation.sourceRecordId=`record:${observation.provider}:${observation.sku}`;
      if(withResources)observation.instanceResources={schemaVersion:1,scope:"FULL_INSTANCE",vcpus:180,memoryGiB:1536,storageGiB:22000};
    }
    e.methodology.offerSchedule={schemaVersion:1,model:"B200",approvalEvidence:"Synthetic streaming offer approval",
      offers:e.observations.filter(o=>o.model==="B200").map(o=>({provider:o.provider,source:o.source,sku:o.sku,region:o.region,
        gpuCount:8,topology:"HGX",includes:[...o.includes],minimumOrderGpuCount:8,sourceRecordId:o.sourceRecordId!,sourceUrl:o.sourceUrl,
        ...(o.instanceResources?{instanceResources:structuredClone(o.instanceResources)}:{})}))};
  }
  journal.saveConfiguration(e.registry);journal.saveConfiguration(e.methodology);collectorSchedule(journal,"test-source",NOW);
  const body=Buffer.alloc(split?EVIDENCE_CHUNK_BYTES+31:31);for(let i=0;i<body.length;i++)body[i]=i%251;
  const evidenceHash=digest(body);
  await journal.archive({hash:evidenceHash,source:"test-source",url:"https://alpha.example/test",receivedAt:NOW-1000,contentType:"application/octet-stream",body});
  const observations=Array.from({length:split?1100:12},(_,i)=>({...e.observations[i%e.observations.length]!,sku:`test-only-${i}`,evidenceHash}));
  journal.capture(observations,["test-only error"],NOW);
  const batches=e.identities.map((signer,i)=>signBatch({...e.batches[i]!.payload,sequence:i===0?journal.nextSequence(identity.nodeId):1,
    observations:e.observations.map(observation=>({...observation,evidenceHash}))},signer));
  for(const batch of batches)journal.accept(batch,NOW,true);
  const snapshot=calculate(batches,e.registry,e.methodology,NOW);journal.snapshot(snapshot);
  const keyPath=join(directory,"key"),outputPath=join(directory,"archive.sbx-backup");createRecoveryKey(keyPath);
  const options:StreamRecoveryOptions={expectedNodeId:identity.nodeId,expectedRelease:RELEASE};
  return {directory,store,journal,e,identity,observations,batches,snapshot,body,evidenceHash,keyPath,outputPath,options};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
type Tables=ArchiveCell[][][];
function sourceFrames(f:Fixture,mutate?:(tables:Tables)=>void,descriptorMutation?:(descriptor:ArchiveDescriptor["payload"])=>void):Uint8Array[] {
  const tables=ARCHIVE_TABLES.map(table=>(f.journal.db.query(`SELECT ${table.columns.join(",")} FROM ${table.name} ORDER BY ${table.order}`).all() as Record<string,unknown>[])
    .map(row=>table.columns.map(column=>encodeHostedCell(row[column])))) as Tables;
  mutate?.(tables);
  const payload:ArchiveDescriptor["payload"]={format:"SBX_CHECKPOINT_V2",checkpointId:randomUUID(),createdAt:NOW+3000,expiresAt:NOW+60000,
    source:{nodeId:f.identity.nodeId,publicKey:f.identity.publicKey,nodeName:"primary",operatorGroup:"test-only-operator",release:RELEASE},
    configuration:{network:f.e.registry.network,intervalMs:300000,registryHash:hash(f.e.registry),methodologyHash:hash(f.e.methodology)},
    cutoff:tables.reduce((sum,rows)=>sum+rows.length,0)+1,counts:tables.map(rows=>rows.length),
    snapshotHead:f.journal.db.query("SELECT id,hash FROM snapshots ORDER BY id DESC LIMIT 1").get() as {id:number;hash:string}|null};
  descriptorMutation?.(payload);
  const descriptor=signArchiveDescriptor(payload,f.identity),frames:Uint8Array[]=[Buffer.from(canonical(descriptor))];
  const fragments:ArchiveFragment[]=[];
  for(const [table,rows] of tables.entries())for(const [record,row] of rows.entries()) {
    const bytes=encodeArchiveRecord(table,row);
    for(let offset=0;offset<bytes.length;offset+=128*1024)fragments.push({table,key:archiveRecordKey(table,row),position:record+1,
      offset,totalLength:bytes.length,data:Buffer.from(bytes.subarray(offset,offset+128*1024)).toString("base64")});
  }
  let previousHash:string|null=null,cursor:ArchiveCursor={table:0,position:0,offset:0},totalBytes=0;
  for(const [index,fragment] of fragments.entries()) {
    const bytes=Buffer.from(fragment.data,"base64");totalBytes+=bytes.length;
    const end:ArchiveCursor=index===fragments.length-1?{table:ARCHIVE_TABLES.length,position:0,offset:0}:
      {table:fragment.table,position:fragment.position,offset:fragment.offset+bytes.length===fragment.totalLength?0:fragment.offset+bytes.length};
    const unsigned:Omit<ArchiveBlock,"hash">={checkpointId:payload.checkpointId,descriptorHash:archiveDescriptorHash(descriptor),index,previousHash,start:cursor,end,fragments:[fragment]};
    const block:ArchiveBlock={...unsigned,hash:archiveBlockHash(unsigned)};frames.push(Buffer.from(canonical(block)));previousHash=block.hash;cursor=end;
  }
  frames.push(Buffer.from(canonical(signArchiveSeal({format:"SBX_CHECKPOINT_SEAL_V2",checkpointId:payload.checkpointId,
    descriptorHash:archiveDescriptorHash(descriptor),blockCount:fragments.length,totalBytes,counts:payload.counts,finalHash:previousHash},descriptor,f.identity))));
  return frames;
}
async function* stream(frames:Uint8Array[]){for(const frame of frames)yield frame;}
async function write(f:Fixture,frames=sourceFrames(f)){return writeStreamContainer(stream(frames),f.outputPath,f.keyPath);}

test("V2 recovery preserves B200-only scope, approved weights and publication interlock", async () => {
  const f = await fixture(false,true), destination = join(f.directory,"scoped-restored");
  await backupStreamFrames(stream(sourceFrames(f)),f.outputPath,f.keyPath,f.options);
  expect((await inspectStreamBackup(f.outputPath,f.keyPath,f.options)).reproducedSnapshots).toBe(1);
  expect((await restoreStreamNode(f.outputPath,f.keyPath,destination,f.options)).status).toBe("RECOVERY_REVIEW_REQUIRED");
  const restored = new Store(join(destination,"data/node.sqlite")); stores.add(restored);
  const row = restored.db.query("SELECT payload FROM snapshots ORDER BY id DESC LIMIT 1").get() as {payload:string};
  expect(JSON.parse(row.payload)).toEqual(f.snapshot); expect(f.snapshot.publicationScope).toEqual({kind:"MODEL",model:"B200"});
  expect(restored.configuration(f.snapshot.methodologyHash)).toEqual(f.e.methodology);
  const config = JSON.parse(readFileSync(join(destination,"config/node.local.json"),"utf8"));
  expect(config.pythManifestPath).toBeUndefined(); expect(config.collectors).toEqual([]);
});

for(const withResources of [false,true])test(`V2 recovery reproduces the exact offer schedule${withResources?" with full-instance resource quantities":""} without activating publication`,async()=>{
  const f=await fixture(false,true,true,withResources),destination=join(f.directory,"offer-schedule-restored");
  expect(f.snapshot.publishable).toBe(true);
  await backupStreamFrames(stream(sourceFrames(f)),f.outputPath,f.keyPath,f.options);
  expect((await inspectStreamBackup(f.outputPath,f.keyPath,f.options)).reproducedSnapshots).toBe(1);
  expect((await restoreStreamNode(f.outputPath,f.keyPath,destination,f.options)).status).toBe("RECOVERY_REVIEW_REQUIRED");
  const restored=new Store(join(destination,"data/node.sqlite"));stores.add(restored);
  const row=restored.db.query("SELECT payload FROM snapshots ORDER BY id DESC LIMIT 1").get() as {payload:string};
  expect(JSON.parse(row.payload)).toEqual(f.snapshot);
  const recovered=restored.configuration(f.snapshot.methodologyHash) as Methodology;
  expect(recovered.offerSchedule).toEqual(f.e.methodology.offerSchedule);
  expect(calculate(f.batches,f.e.registry,recovered,NOW)).toEqual(f.snapshot);
  const changed=structuredClone(recovered);changed.offerSchedule!.offers[0]!.sourceRecordId+="-changed";
  expect(calculate(f.batches,f.e.registry,changed,NOW).publishable).toBe(false);
  if(withResources) {
    expect(recovered.offerSchedule!.offers[0]!.instanceResources).toEqual({schemaVersion:1,scope:"FULL_INSTANCE",vcpus:180,memoryGiB:1536,storageGiB:22000});
    const changedResources=structuredClone(recovered);changedResources.offerSchedule!.offers[0]!.instanceResources!.memoryGiB++;
    expect(calculate(f.batches,f.e.registry,changedResources,NOW).publishable).toBe(false);
  }
  const config=JSON.parse(readFileSync(join(destination,"config/node.local.json"),"utf8"));
  expect(config.pythManifestPath).toBeUndefined();expect(config.collectors).toEqual([]);expect(config.peers).toEqual([]);
});

test("V2 source frames encrypt, inspect and restore chunked history with a new disabled identity",async()=>{
  const f=await fixture(true),counter=f.journal.db.query("SELECT value FROM counters WHERE id=?").get(f.identity.nodeId);
  const backup=await backupStreamFrames(stream(sourceFrames(f)),f.outputPath,f.keyPath,f.options);
  expect(backup.sourceVerified).toBe(true);expect(backup.contentInspection).toBe("REQUIRED");
  const inspected=await inspectStreamBackup(f.outputPath,f.keyPath,f.options);
  expect(inspected.history).toEqual({valid:true,count:1});expect(inspected.observations).toBe(1100);
  expect(inspected.evidenceBytes).toBe(f.body.length);expect(inspected.counts.captures).toBe(1);expect(inspected.counts.captureBatches).toBeGreaterThan(1);
  expect(inspected.counts.evidence).toBe(1);expect(inspected.storageVersion).toBe(CHUNKED_JOURNAL_VERSION);
  expect(inspected.archiveSha256).toBe(backup.sha256);expect(inspected.reproducedSnapshots).toBe(1);
  const destination=join(f.directory,"restored"),result=await restoreStreamNode(f.outputPath,f.keyPath,destination,f.options);
  expect(result.newNodeId).not.toBe(f.identity.nodeId);expect(result.status).toBe("RECOVERY_REVIEW_REQUIRED");
  expect(existsSync(join(destination,RECOVERY_MARKER))).toBe(true);
  expect(()=>backupNode(destination,join(destination,"config/node.local.json"),join(f.directory,"legacy-rebackup"),f.keyPath)).toThrow("Chunked journals require the V2 streaming backup path");
  const config=JSON.parse(readFileSync(join(destination,"config/node.local.json"),"utf8"));
  expect(config.collectors).toEqual([]);expect(config.peers).toEqual([]);expect(config.host).toBe("127.0.0.1");expect(config.pythManifestPath).toBeUndefined();
  const readonly=new Database(join(destination,"data/node.sqlite"),{readonly:true,strict:true});
  try{expect(readonly.query("PRAGMA journal_mode").get()).toEqual({journal_mode:"delete"});expect(readonly.query("SELECT COUNT(*) AS count FROM snapshots").get()).toEqual({count:1});}finally{readonly.close();}
  const restored=new Store(join(destination,"data/node.sqlite"));stores.add(restored);
  expect(restored.counts().captures).toBe(1);expect(restored.counts().evidence).toBe(1);
  expect((restored.db.query("SELECT length(body) AS bytes FROM evidence").get() as {bytes:number}).bytes).toBe(0);
  const chunks=new ChunkedJournal(restored.db);expect(digest(chunks.evidenceBody(f.evidenceHash)!)).toBe(f.evidenceHash);
  expect(restored.db.query("SELECT value FROM counters WHERE id=?").get(f.identity.nodeId)).toEqual(counter);
  expect(f.journal.db.query("SELECT value FROM counters WHERE id=?").get(f.identity.nodeId)).toEqual(counter);
  expect((restored.db.query("SELECT archive_sha256 FROM archive_recovery_provenance").get() as {archive_sha256:string}).archive_sha256).toBe(backup.sha256);
  expect(statSync(join(destination,"data/node.sqlite")).mode&0o777).toBe(0o600);
  expect(readFileSync(f.outputPath).includes(Buffer.from("test-only-"))).toBe(false);
  expect(readFileSync(join(destination,"data/node-identity.json"),"utf8")).not.toContain(f.identity.privateKeyPem);
  const run=Bun.spawnSync([process.execPath,resolve("src/cli.ts"),"run"],{cwd:destination,stdout:"pipe",stderr:"pipe"});
  expect(run.exitCode).not.toBe(0);expect(Buffer.concat([run.stdout,run.stderr]).toString()).toContain("RECOVERY_REVIEW_REQUIRED");
},30000);

test("reviewed chunked Store writes keep storage batches separate from collection cycles",async()=>{
  const f=await fixture(true);await write(f);const destination=join(f.directory,"restored");await restoreStreamNode(f.outputPath,f.keyPath,destination,f.options);
  const restored=new Store(join(destination,"data/node.sqlite"));stores.add(restored);
  // Direct journal fixture represents post-review operation; CLI remains gated above.
  restored.capture(f.observations,[],NOW+4000);
  await restored.archive({hash:f.evidenceHash,source:"test-source",url:"https://alpha.example/test",receivedAt:NOW+4000,contentType:"application/octet-stream",body:f.body});
  expect(restored.captureCounts().count).toBe(2);expect(restored.counts().captureBatches).toBeGreaterThan(2);expect(restored.counts().evidence).toBe(1);
});

for(const [name,mutate,error] of [
  ["missing evidence chunks",(t:Tables)=>{t[9]!.pop();},"EVIDENCE_CHUNK_MISSING"],
  ["wrong evidence digest",(t:Tables)=>{t[9]![0]![2]={base64:Buffer.alloc(31,2).toString("base64")};},"EVIDENCE_HASH_MISMATCH"],
  ["orphan evidence sizes",(t:Tables)=>{t[10]![0]![0]="f".repeat(64);},"EVIDENCE_METADATA_MISMATCH"],
  ["nonempty evidence placeholder",(t:Tables)=>{t[5]![0]![5]={base64:"YQ=="};},"EVIDENCE_METADATA_MISMATCH"],
  ["evidence received after checkpoint",(t:Tables)=>{t[5]![0]![3]=NOW+4000;},"EVIDENCE_RECEIPT_CLOCK"],
  ["capture evidence not yet received",(t:Tables)=>{t[5]![0]![3]=NOW+1;},"CAPTURE_EVIDENCE_RECEIPT_CLOCK"],
  ["capture without cycle marker",(t:Tables)=>{t[11]=[];},"CAPTURE_CYCLE_MEMBERSHIP"],
  ["cycle without capture batch",(t:Tables)=>{t[11]!.push([2,NOW+1]);},"CAPTURE_CYCLE_MEMBERSHIP"],
  ["duplicate cycle timestamps",(t:Tables)=>{t[11]!.push([2,NOW]);},"CAPTURE_CYCLE_MEMBERSHIP"],
  ["missing capture evidence",(t:Tables)=>{const values=JSON.parse(t[6]![0]![2] as string);values[0].evidenceHash="f".repeat(64);t[6]![0]![2]=canonical(values);},"CAPTURE_EVIDENCE_MISSING"],
  ["future capture observation",(t:Tables)=>{const values=JSON.parse(t[6]![0]![2] as string);values[0].observedAt=NOW+1;t[6]![0]![2]=canonical(values);},"CAPTURE_OBSERVATION_CLOCK"],
  ["source counter rollback",(t:Tables)=>{t[0]=[];},"COUNTER_HIGHWATER_MISMATCH"],
  ["configuration digest mismatch",(t:Tables)=>{t[8]![0]![1]="{}";},"CONFIGURATION_DIGEST_MISMATCH"],
  ["report routing mismatch",(t:Tables)=>{t[1]![0]![2]=2;},"REPORT_ROUTING_MISMATCH"],
] as const) test(`inspection rejects ${name} in an authenticated source archive`,async()=>{
  const f=await fixture();await write(f,sourceFrames(f,mutate));await expect(inspectStreamBackup(f.outputPath,f.keyPath,f.options)).rejects.toThrow(error);
});

test("descriptor pins, counts, terminal seal and strict source EOF are mandatory",async()=>{
  const f=await fixture(),frames=sourceFrames(f);
  await expect(backupStreamFrames(stream(frames.slice(0,-1)),`${f.outputPath}.truncated`,f.keyPath,f.options)).rejects.toThrow("SOURCE_SEAL_MISSING");
  expect(existsSync(f.outputPath)).toBe(false);
  await expect(backupStreamFrames(stream([...frames,frames[0]!]),`${f.outputPath}.trailing`,f.keyPath,f.options)).rejects.toThrow("TRAILING_SOURCE_FRAME");
  expect(existsSync(f.outputPath)).toBe(false);
  await write(f,frames);
  await expect(inspectStreamBackup(f.outputPath,f.keyPath,{...f.options,expectedNodeId:"f".repeat(64)})).rejects.toThrow("ARCHIVE_SOURCE_MISMATCH");
  await expect(inspectStreamBackup(f.outputPath,f.keyPath,{...f.options,expectedRelease:"a".repeat(40)})).rejects.toThrow("ARCHIVE_SOURCE_MISMATCH");
  await expect(inspectStreamBackup(f.outputPath,f.keyPath,{...f.options,maxRecords:1})).rejects.toThrow("RECORD_BUDGET");
  await expect(inspectStreamBackup(f.outputPath,f.keyPath,{...f.options,maxSnapshotInputs:1})).rejects.toThrow("SNAPSHOT_INPUT_BUDGET");
  await expect(inspectStreamBackup(f.outputPath,f.keyPath,{...f.options,maxSnapshotInputBytes:1})).rejects.toThrow("SNAPSHOT_INPUT_BUDGET");
  await expect(inspectStreamBackup(f.outputPath,f.keyPath,{...f.options,maxSnapshotObservations:1})).rejects.toThrow("SNAPSHOT_OBSERVATION_BUDGET");
  await expect(inspectStreamBackup(f.outputPath,f.keyPath,{...f.options,maxDatabaseBytes:1})).rejects.toThrow("DATABASE_BUDGET_EXCEEDED");
});

test("cancellation and existing destination fail without enabling a node",async()=>{
  const f=await fixture();await write(f);const controller=new AbortController();controller.abort();
  await expect(inspectStreamBackup(f.outputPath,f.keyPath,{...f.options,signal:controller.signal})).rejects.toThrow();
  await expect(restoreStreamNode(f.outputPath,f.keyPath,f.directory,f.options)).rejects.toThrow("NEW_DESTINATION_REQUIRED");
  expect(existsSync(join(f.directory,RECOVERY_MARKER))).toBe(false);
});

test("valid snapshot hash chains still require original reports and exact historical calculation",async()=>{
  const f=await fixture();
  const altered=structuredClone(f.snapshot);altered.feeds.at(-1)!.price="999.000000";
  f.journal.db.query("UPDATE snapshots SET payload=?,hash=?").run(canonical(altered),hash({previousHash:null,snapshot:altered}));
  await write(f,sourceFrames(f));
  await expect(inspectStreamBackup(f.outputPath,f.keyPath,f.options)).rejects.toThrow("SNAPSHOT_REPRODUCTION_MISMATCH");
  const missing=join(f.directory,"missing-report.sbx-backup");
  f.journal.db.query("UPDATE snapshots SET payload=?,hash=?").run(canonical(f.snapshot),hash({previousHash:null,snapshot:f.snapshot}));
  f.journal.db.query("DELETE FROM reports WHERE hash=?").run(hash(f.batches[1]!));
  await writeStreamContainer(stream(sourceFrames(f)),missing,f.keyPath);
  await expect(inspectStreamBackup(missing,f.keyPath,f.options)).rejects.toThrow("SNAPSHOT_REPORT_MISSING");
});

test("quarantine proofs are checked and proof-unavailable exclusions remain fail-closed",async()=>{
  const f=await fixture(),first=f.batches[0]!,second=signBatch({...first.payload,observations:[]},f.identity);
  f.journal.recordEquivocation({first,second},NOW+1);
  await write(f);
  expect((await inspectStreamBackup(f.outputPath,f.keyPath,f.options)).quarantineProofs).toEqual({verified:1,unavailable:0,requiresReview:false});
  f.journal.db.query("DELETE FROM equivocation_proofs").run();
  const unavailable=join(f.directory,"unavailable.sbx-backup");await writeStreamContainer(stream(sourceFrames(f)),unavailable,f.keyPath);
  const destination=join(f.directory,"unavailable-restore"),result=await restoreStreamNode(unavailable,f.keyPath,destination,f.options);
  expect(result.quarantineProofs).toEqual({verified:0,unavailable:1,requiresReview:true});
  const restored=new Store(join(destination,"data/node.sqlite"));stores.add(restored);expect(restored.latestReport(f.identity.nodeId)).toBeNull();
});

test("signed equivocation proofs cannot be detached from their durable exclusion",async()=>{
  const f=await fixture(),first=f.batches[0]!,second=signBatch({...first.payload,observations:[]},f.identity);
  f.journal.recordEquivocation({first,second},NOW+1);f.journal.db.query("DELETE FROM equivocations").run();
  await write(f);await expect(inspectStreamBackup(f.outputPath,f.keyPath,f.options)).rejects.toThrow("QUARANTINE_LINKAGE_MISMATCH");
});

test("candidate state cannot roll back a retained trusted sequence",async()=>{
  const f=await fixture(),report=f.batches[1]!,payload=canonical(report);
  f.journal.db.query("INSERT INTO candidates(node_id,sequence,received_at,hash,payload,payload_bytes) VALUES(?,?,?,?,?,?)")
    .run(report.payload.nodeId,report.payload.sequence,NOW,hash(report),payload,Buffer.byteLength(payload));
  await write(f);await expect(inspectStreamBackup(f.outputPath,f.keyPath,f.options)).rejects.toThrow("CANDIDATE_HIGHWATER_MISMATCH");
});

test("container authentication cannot replace the source terminal signature",async()=>{
  const f=await fixture(),frames=sourceFrames(f),seal=JSON.parse(Buffer.from(frames.at(-1)!).toString());
  seal.signature=(seal.signature[0]==="A"?"B":"A")+seal.signature.slice(1);frames[frames.length-1]=Buffer.from(canonical(seal));
  await write(f,frames);await expect(inspectStreamBackup(f.outputPath,f.keyPath,f.options)).rejects.toThrow("ARCHIVE_SIGNATURE_INVALID");
});

for(const invalid of ["key","noncanonical bytes"] as const)test(`whole-record export and inspection reject invalid ${invalid} in a correctly hashed block`,async()=>{
  const f=await fixture(),frames=sourceFrames(f),block=JSON.parse(Buffer.from(frames[1]!).toString()) as ArchiveBlock;
  const fragment=block.fragments[0]!,bytes=Buffer.from(fragment.data,"base64");
  expect(fragment.offset).toBe(0);expect(bytes.length).toBe(fragment.totalLength);
  if(invalid==="key")fragment.key[0]="f".repeat(64);
  else {fragment.data=Buffer.concat([bytes,Buffer.from(" ")]).toString("base64");fragment.totalLength++;}
  const {hash:_hash,...unsigned}=block;block.hash=archiveBlockHash(unsigned);frames[1]=Buffer.from(canonical(block));
  await expect(backupStreamFrames(stream(frames),f.outputPath,f.keyPath,f.options)).rejects.toThrow("ARCHIVE_RECORD_KEY_MISMATCH");
  expect(existsSync(f.outputPath)).toBe(false);
  const independentlyEncrypted=join(f.directory,"invalid-whole-record.sbx-backup");await writeStreamContainer(stream(frames),independentlyEncrypted,f.keyPath);
  await expect(inspectStreamBackup(independentlyEncrypted,f.keyPath,f.options)).rejects.toThrow("ARCHIVE_RECORD_KEY_MISMATCH");
});

test("record fragments cannot switch identity inside a correctly rehashed block chain",async()=>{
  const f=await fixture(true),frames=sourceFrames(f),descriptor=JSON.parse(Buffer.from(frames[0]!).toString()) as ArchiveDescriptor;
  let previousHash:string|null=null,changed=false;
  for(let index=1;index<frames.length-1;index++) {
    const block=JSON.parse(Buffer.from(frames[index]!).toString()) as ArchiveBlock;
    const fragment=block.fragments[0]!;
    if(!changed&&fragment.table===9&&fragment.offset>0){fragment.key[0]="f".repeat(64);changed=true;}
    block.previousHash=previousHash;const {hash:_hash,...unsigned}=block;block.hash=archiveBlockHash(unsigned);previousHash=block.hash;
    frames[index]=Buffer.from(canonical(block));
  }
  expect(changed).toBe(true);
  const originalSeal=JSON.parse(Buffer.from(frames.at(-1)!).toString());
  frames[frames.length-1]=Buffer.from(canonical(signArchiveSeal({...originalSeal.payload,finalHash:previousHash},descriptor,f.identity)));
  await expect(backupStreamFrames(stream(frames),f.outputPath,f.keyPath,f.options)).rejects.toThrow("RECORD_FRAGMENT_MISMATCH");
  const independentlyEncrypted=join(f.directory,"invalid-record.sbx-backup");await writeStreamContainer(stream(frames),independentlyEncrypted,f.keyPath);
  await expect(inspectStreamBackup(independentlyEncrypted,f.keyPath,f.options)).rejects.toThrow("RECORD_FRAGMENT_MISMATCH");
});
