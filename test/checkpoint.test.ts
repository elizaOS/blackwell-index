// Isolated synthetic protocol/capacity fixtures. Never used as production market history.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ChunkedJournal } from "../src/chunked-journal";
import { canonical, generateIdentity, signBatch } from "../src/crypto";
import { calculate } from "../src/engine";
import { createHostedExport, parseHostedExport } from "../src/hosted-export";
import { ARCHIVE_LIMITS, ARCHIVE_TABLES, archiveBlockHash, decodeArchiveRecord, parseArchiveBlock, parseArchiveDescriptor, parseArchiveSeal,
  type ArchiveBlock, type ArchiveCell, type ArchiveCursor, type ArchiveDescriptor } from "../src/archive-protocol";
import { CHECKPOINT_STAGING_LIMITS, beginCheckpoint, initializeCheckpointStorage, readCheckpointBlock, releaseCheckpoint, sealCheckpoint, verifyCheckpointMembership } from "../src/checkpoint";
import { JOURNAL_LIMITS } from "../src/journal";
import { Store } from "../src/store";
import { environment, NOW } from "./helpers";

const stores:Store[]=[];afterEach(()=>{for(const store of stores.splice(0))store.close();});
const RELEASE="ab".repeat(20);
async function fixture(bytes=512*1024+31,initialize=true) {
  const store=new Store(":memory:");stores.push(store);const journal=new ChunkedJournal(store.db),e=environment(),identity=e.identities[0]!;
  journal.saveConfiguration(e.registry);journal.saveConfiguration(e.methodology);
  if(initialize)initializeCheckpointStorage(journal);
  const body=Buffer.alloc(bytes,37),evidenceHash=createHash("sha256").update(body).digest("hex");
  await journal.archive({hash:evidenceHash,source:"checkpoint-test",url:"https://alpha.example/test-only",receivedAt:NOW-1000,contentType:"application/octet-stream",body});
  const observations=e.observations.map(observation=>({...observation,evidenceHash}));
  journal.capture(observations,[],NOW);journal.nextSequence(identity.nodeId);
  const batches=e.identities.map(signer=>signBatch({schemaVersion:1,network:e.registry.network,nodeId:signer.nodeId,publicKey:signer.publicKey,sequence:1,createdAt:NOW,observations},signer));
  for(const batch of batches)journal.accept(batch,NOW,true);
  journal.snapshot(calculate(batches,e.registry,e.methodology,NOW));
  const metadata={nodeName:"primary" as const,operatorGroup:"checkpoint-test",release:RELEASE,network:e.registry.network,intervalMs:300000,registry:e.registry,methodology:e.methodology};
  return {store,journal,e,identity,metadata,body,evidenceHash,batches,observations};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function begin(f:Fixture,ttlMs?:number):ArchiveDescriptor {return beginCheckpoint(f.journal,f.identity,f.metadata,{now:NOW+1000,...(ttlMs===undefined?{}:{ttlMs})});}
function download(f:Fixture,descriptor:ArchiveDescriptor,journal=f.journal) {
  const blocks:ArchiveBlock[]=[],rows:ArchiveCell[][][]=ARCHIVE_TABLES.map(()=>[]);let previousHash:string|null=null,cursor:ArchiveCursor={table:0,position:0,offset:0},bytes=0;
  let pending:{table:number;key:[string,number];position:number;totalLength:number;parts:Uint8Array[];length:number}|null=null;
  for(let index=0;index<10000;index++) {
    const block=readCheckpointBlock(journal,f.identity,f.metadata,descriptor.payload.checkpointId,index,NOW+2000);if(!block)break;
    parseArchiveBlock(block,descriptor,{index,previousHash,cursor});blocks.push(block);previousHash=block.hash;cursor=block.end;
    for(const fragment of block.fragments) {
      if(!pending)pending={table:fragment.table,key:fragment.key,position:fragment.position,totalLength:fragment.totalLength,parts:[],length:0};
      expect(fragment.table).toBe(pending.table);expect(fragment.position).toBe(pending.position);expect(fragment.key).toEqual(pending.key);expect(fragment.totalLength).toBe(pending.totalLength);expect(fragment.offset).toBe(pending.length);
      const part=Buffer.from(fragment.data,"base64");pending.parts.push(part);pending.length+=part.length;bytes+=part.length;
      if(pending.length===pending.totalLength) {rows[pending.table]!.push(decodeArchiveRecord(pending.table,pending.key,Buffer.concat(pending.parts)));pending=null;}
    }
  }
  expect(pending).toBeNull();expect(cursor).toEqual({table:ARCHIVE_TABLES.length,position:0,offset:0});
  const seal=sealCheckpoint(journal,f.identity,f.metadata,descriptor.payload.checkpointId,NOW+2000);
  parseArchiveSeal(seal,descriptor,{blockCount:blocks.length,totalBytes:bytes,counts:rows.map(table=>table.length),finalHash:previousHash});
  return {blocks,rows,seal};
}
const sorted=(rows:unknown[])=>rows.map(canonical).sort();

test("native-key bootstrap and later atomic registration preserve V1 rows and bounded V2 fragments",async()=>{
  const f=await fixture(undefined,false);initializeCheckpointStorage(f.journal);verifyCheckpointMembership(f.journal);
  const original=parseHostedExport(createHostedExport(f.journal,f.identity,f.metadata,NOW+1000),f.identity.nodeId,RELEASE);
  const descriptor=begin(f),result=download(f,descriptor);
  expect(result.blocks.length).toBeGreaterThan(2);
  expect(result.blocks.some(block=>block.fragments.some(fragment=>fragment.offset>0))).toBe(true);
  for(const block of result.blocks) {expect(Buffer.byteLength(canonical(block))).toBeLessThanOrEqual(ARCHIVE_LIMITS.transportBytes);expect(block.fragments.reduce((sum,fragment)=>sum+Buffer.from(fragment.data,"base64").length,0)).toBeLessThanOrEqual(ARCHIVE_LIMITS.blockBytes);}
  for(const [index,table] of original.payload.tables.entries())expect(sorted(result.rows[index]!)).toEqual(sorted(table.rows));
  expect(f.journal.db.query("SELECT value FROM counters WHERE id=?").get(f.identity.nodeId)).toEqual({value:1});
  expect(JSON.stringify(descriptor)).not.toContain("PRIVATE KEY");
});

test("frozen counters, candidates and schedules ignore live admission, new captures and exclusions",async()=>{
  const f=await fixture(64),candidate=generateIdentity(),admitted=generateIdentity();
  const batch=(signer:typeof candidate,sequence:number)=>signBatch({...f.batches[0]!.payload,nodeId:signer.nodeId,publicKey:signer.publicKey,sequence},signer);
  f.journal.accept(batch(candidate,1),NOW,false);f.journal.accept(batch(admitted,1),NOW,false);
  f.journal.db.query("INSERT INTO collector_schedules VALUES(?,0,0,'READY',?,0,NULL,0)").run("isolated-test",NOW);
  const original=parseHostedExport(createHostedExport(f.journal,f.identity,f.metadata,NOW+1000),f.identity.nodeId,RELEASE),descriptor=begin(f);
  f.journal.nextSequence(f.identity.nodeId);f.journal.accept(batch(candidate,2),NOW+2000,false);f.journal.accept(batch(admitted,1),NOW+2000,true);
  f.journal.capture(f.observations,[],NOW+2000);
  f.journal.db.query("UPDATE collector_schedules SET next_attempt_at=?,failures=1,reason='HTTP_429_BACKOFF' WHERE collector_id=?").run(NOW+60000,"isolated-test");
  const first=f.batches[2]!,second=signBatch({...first.payload,createdAt:NOW+1},f.e.identities[2]!);f.journal.recordEquivocation({first,second},NOW+2000);
  verifyCheckpointMembership(f.journal);
  const result=download(f,descriptor);
  for(const [index,table] of original.payload.tables.entries())expect(sorted(result.rows[index]!)).toEqual(sorted(table.rows));
  releaseCheckpoint(f.journal,descriptor.payload.checkpointId,NOW+3000,true);
  const next=beginCheckpoint(f.journal,f.identity,f.metadata,{now:NOW+4000});
  expect(next.payload.counts[2]).toBe(1);expect(next.payload.counts[3]).toBe(1);expect(next.payload.counts[4]).toBe(1);expect(next.payload.counts[11]).toBe(2);
});

test("durable retries are identical after lost delivery, live insertion and same-release reconstruction",async()=>{
  const f=await fixture(),descriptor=begin(f),id=descriptor.payload.checkpointId;
  const first=readCheckpointBlock(f.journal,f.identity,f.metadata,id,0,NOW+2000)!;
  f.journal.capture(f.observations,[],NOW+2000);f.journal.nextSequence(f.identity.nodeId);
  const reconstructed=new ChunkedJournal(f.store.db);initializeCheckpointStorage(reconstructed);
  expect(canonical(readCheckpointBlock(reconstructed,f.identity,f.metadata,id,0,NOW+2000))).toBe(canonical(first));
  const result=download(f,descriptor,reconstructed);
  expect(canonical(result.blocks[0])).toBe(canonical(first));
  expect(sealCheckpoint(reconstructed,f.identity,f.metadata,id,NOW+2000)).toEqual(result.seal);
  expect(readCheckpointBlock(reconstructed,f.identity,f.metadata,id,result.blocks.length,NOW+2000)).toBeNull();
});

test("incomplete, out-of-order, wrong identity/release, and expired requests cannot seal or resume",async()=>{
  const f=await fixture(),descriptor=begin(f,3000),id=descriptor.payload.checkpointId;
  expect(()=>sealCheckpoint(f.journal,f.identity,f.metadata,id,NOW+2000)).toThrow("ARCHIVE_CHECKPOINT_INCOMPLETE");
  expect(()=>readCheckpointBlock(f.journal,f.identity,f.metadata,id,1,NOW+2000)).toThrow("ARCHIVE_BLOCK_ORDER_MISMATCH");
  expect(()=>readCheckpointBlock(f.journal,generateIdentity(),f.metadata,id,0,NOW+2000)).toThrow("ARCHIVE_SOURCE_MISMATCH");
  expect(()=>readCheckpointBlock(f.journal,f.identity,{...f.metadata,release:"cd".repeat(20)},id,0,NOW+2000)).toThrow("ARCHIVE_SOURCE_MISMATCH");
  expect(()=>readCheckpointBlock(f.journal,f.identity,f.metadata,id,0,NOW)).toThrow("ARCHIVE_CLOCK_ROLLBACK");
  expect(()=>readCheckpointBlock(f.journal,f.identity,f.metadata,id,0,NOW+4000)).toThrow("ARCHIVE_CHECKPOINT_EXPIRED");
  expect(()=>releaseCheckpoint(f.journal,id,NOW+2000,true)).toThrow("ARCHIVE_CHECKPOINT_NOT_COMPLETE");
  const counts=f.journal.counts(),entries=f.journal.db.query("SELECT COUNT(*) AS count FROM archive_entries").get();
  const replacement=beginCheckpoint(f.journal,f.identity,f.metadata,{now:NOW+4000});
  expect(replacement.payload.checkpointId).not.toBe(id);expect(f.journal.counts()).toEqual(counts);expect(f.journal.db.query("SELECT COUNT(*) AS count FROM archive_entries").get()).toEqual(entries);
  expect(()=>readCheckpointBlock(f.journal,f.identity,f.metadata,id,0,NOW+4000)).toThrow("ARCHIVE_CHECKPOINT_NOT_FOUND");
});

test("begin rejects collection, second checkpoint and missing configuration atomically",async()=>{
  const f=await fixture(64);
  expect(()=>beginCheckpoint(f.journal,f.identity,f.metadata,{now:NOW+1000,collectionRunning:true})).toThrow("COLLECTION_RUNNING_RETRY_EXPORT");
  expect(()=>beginCheckpoint(f.journal,f.identity,{...f.metadata,methodology:{...f.metadata.methodology,version:"missing-config"}},{now:NOW+1000})).toThrow("ARCHIVE_CONFIGURATION_MISSING");
  expect(()=>beginCheckpoint(f.journal,{...f.identity,privateKeyPem:"invalid-test-key"},f.metadata,{now:NOW+1000})).toThrow();
  expect(f.journal.db.query("SELECT COUNT(*) AS count FROM archive_frozen_counters").get()).toEqual({count:0});
  begin(f);expect(()=>begin(f)).toThrow("ARCHIVE_CHECKPOINT_ALREADY_ACTIVE");
});

test("frozen capacity checks use actual payload bytes even when stored byte accounting lies",async()=>{
  const f=await fixture(64),candidate=generateIdentity();
  f.journal.db.query("INSERT INTO candidates(node_id,sequence,received_at,hash,payload,payload_bytes) VALUES(?,1,?,?,?,0)").run(candidate.nodeId,NOW,"f".repeat(64),"x".repeat(JOURNAL_LIMITS.candidatesTotalBytes+1));
  expect(()=>begin(f)).toThrow("ARCHIVE_FROZEN_CAPACITY");
  expect(f.journal.db.query("SELECT COUNT(*) AS count FROM archive_frozen_candidates").get()).toEqual({count:0});
});

test("oversized records stop traversal before advancement or sealing",async()=>{
  const f=await fixture(64);
  f.journal.capture([], ["x".repeat(ARCHIVE_LIMITS.recordBytes+1)],NOW+1);
  const descriptor=begin(f),id=descriptor.payload.checkpointId;
  expect(()=>readCheckpointBlock(f.journal,f.identity,f.metadata,id,0,NOW+2000)).toThrow("ARCHIVE_RECORD_TOO_LARGE");
  expect(f.journal.db.query("SELECT next_block FROM archive_checkpoints WHERE id=?").get(id)).toEqual({next_block:0});
  expect(()=>sealCheckpoint(f.journal,f.identity,f.metadata,id,NOW+2000)).toThrow("ARCHIVE_CHECKPOINT_INCOMPLETE");
});

test("checkpoint metadata budget fails before advancement and never prunes source rows",async()=>{
  const f=await fixture(64),descriptor=begin(f),id=descriptor.payload.checkpointId,counts=f.journal.counts();
  f.journal.db.query("UPDATE archive_checkpoints SET metadata_bytes=? WHERE id=?").run(CHECKPOINT_STAGING_LIMITS.metadataBytes,id);
  expect(()=>readCheckpointBlock(f.journal,f.identity,f.metadata,id,0,NOW+2000)).toThrow("ARCHIVE_CHECKPOINT_STAGING_CAPACITY");
  expect(f.journal.db.query("SELECT next_block FROM archive_checkpoints WHERE id=?").get(id)).toEqual({next_block:0});
  expect(f.journal.db.query("SELECT COUNT(*) AS count FROM archive_blocks").get()).toEqual({count:0});expect(f.journal.counts()).toEqual(counts);
});

for(const failure of ["missing member","wrong key","unknown code","unregistered source row"] as const)test(`exact membership fails closed: ${failure}`,async()=>{
  const f=await fixture(64);
  if(failure==="missing member")f.journal.db.query("DELETE FROM archive_entries WHERE table_code=5").run();
  if(failure==="wrong key")f.journal.db.query("UPDATE archive_entries SET key_text=? WHERE table_code=5").run("f".repeat(64));
  if(failure==="unknown code")f.journal.db.query("INSERT INTO archive_entries(table_code,key_text,key_integer) VALUES(99,'',0)").run();
  if(failure==="unregistered source row")f.journal.db.query("INSERT INTO captures(collected_at,observations,errors) VALUES(?,'[]','[]')").run(NOW);
  expect(()=>begin(f)).toThrow("ARCHIVE_MEMBERSHIP_INCOMPLETE");
  expect(f.journal.db.query("SELECT COUNT(*) AS count FROM archive_checkpoints").get()).toEqual({count:0});
});

test("immutable application writes reject replacement/deletion while mutable counters remain writable",async()=>{
  const f=await fixture(64);
  for(const sql of ["UPDATE captures SET errors='[]'","DELETE FROM evidence","INSERT OR REPLACE INTO configurations(hash,payload) VALUES('x','{}')","DROP TABLE reports","ALTER TABLE snapshots ADD COLUMN future TEXT"])expect(()=>f.journal.db.query(sql).run()).toThrow("ARCHIVE_IMMUTABLE_MUTATION_REJECTED");
  expect(f.journal.nextSequence(f.identity.nodeId)).toBe(2);
  // A database-owner bypass is not an application write; independent retry hashes detect it.
  const descriptor=begin(f),id=descriptor.payload.checkpointId;readCheckpointBlock(f.journal,f.identity,f.metadata,id,0,NOW+2000);
  f.store.db.query("UPDATE reports SET received_at=received_at+1").run();
  expect(()=>readCheckpointBlock(f.journal,f.identity,f.metadata,id,0,NOW+2000)).toThrow("ARCHIVE_IMMUTABLE_DATA_CHANGED");
});

test("schema additions and failed initial key migration roll back without a partial completeness marker",async()=>{
  const f=await fixture(64,false);
  f.store.db.query("INSERT INTO equivocations(node_id,detected_at,conflicting_payload) VALUES(NULL,?,'{}')").run(NOW);
  expect(()=>initializeCheckpointStorage(f.journal)).toThrow();
  expect(f.journal.db.query("SELECT name FROM sqlite_master WHERE name='archive_schema'").get()).toBeNull();
  f.store.db.query("DELETE FROM equivocations").run();initializeCheckpointStorage(f.journal);
  f.store.db.exec("ALTER TABLE captures ADD COLUMN future_private_value TEXT");
  expect(()=>begin(f)).toThrow("ARCHIVE_SCHEMA_REVIEW_REQUIRED");
});

test("proof-capacity failure retains both exclusion and membership in its separate transaction",async()=>{
  const f=await fixture(64,false);
  f.journal.db.transaction(()=>{for(let i=0;i<JOURNAL_LIMITS.proofRows;i++)f.journal.db.query("INSERT INTO equivocation_proofs(node_id,detected_at,first_payload,second_payload,payload_bytes) VALUES(?,?,'{}','{}',4)").run(i.toString(16).padStart(64,"0"),NOW);})();
  initializeCheckpointStorage(f.journal);
  const first=f.batches[1]!,second=signBatch({...first.payload,createdAt:NOW+1},f.e.identities[1]!);
  expect(()=>f.journal.recordEquivocation({first,second},NOW+2000)).toThrow("EQUIVOCATION_PROOF_CAPACITY_ARCHIVE_REQUIRED");
  expect(f.journal.db.query("SELECT node_id FROM equivocations WHERE node_id=?").get(first.payload.nodeId)).not.toBeNull();
  expect(f.journal.db.query("SELECT sequence FROM archive_entries WHERE table_code=3 AND key_text=?").get(first.payload.nodeId)).not.toBeNull();
  verifyCheckpointMembership(f.journal);
});

test("strict parsers reject malformed signatures, block fields, fragment offsets/base64/cutoffs and seal totals",async()=>{
  const f=await fixture(64),descriptor=begin(f),result=download(f,descriptor),first=result.blocks[0]!;
  expect(()=>parseArchiveDescriptor({...descriptor,signature:"A".repeat(88)},f.identity.nodeId,RELEASE)).toThrow("ARCHIVE_SIGNATURE_INVALID");
  expect(()=>parseArchiveBlock({...first,unexpected:true},descriptor)).toThrow();
  expect(()=>parseArchiveBlock({...first,hash:"f".repeat(64)},descriptor)).toThrow("ARCHIVE_BLOCK_HASH_MISMATCH");
  for(const mutate of [(block:ArchiveBlock)=>{block.fragments[0]!.offset=1;},(block:ArchiveBlock)=>{block.fragments[0]!.data="%%%";},(block:ArchiveBlock)=>{block.fragments.find(fragment=>!ARCHIVE_TABLES[fragment.table]!.mutable)!.position=descriptor.payload.cutoff+1;}]) {
    const altered=structuredClone(first);mutate(altered);const {hash:_,...unsigned}=altered;altered.hash=archiveBlockHash(unsigned);expect(()=>parseArchiveBlock(altered,descriptor)).toThrow();
  }
  expect(()=>parseArchiveSeal(result.seal,descriptor,{blockCount:result.blocks.length,totalBytes:result.seal.payload.totalBytes+1,counts:descriptor.payload.counts,finalHash:result.seal.payload.finalHash})).toThrow("ARCHIVE_SEAL_MISMATCH");
});
