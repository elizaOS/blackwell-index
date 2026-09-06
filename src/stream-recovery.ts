/** Bounded-memory authenticated import. Source SQL and private signing keys are never accepted. */
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, constants, copyFileSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { ARCHIVE_LIMITS, ARCHIVE_TABLES, archiveDescriptorHash, decodeArchiveRecord, parseArchiveBlock, parseArchiveDescriptor, parseArchiveSeal, type ArchiveCursor, type ArchiveDescriptor, type ArchiveFragment, type ArchiveSeal } from "./archive-protocol";
import { ChunkedJournal, CHUNKED_JOURNAL_VERSION } from "./chunked-journal";
import { collectorSchedule } from "./collection-control";
import { parseConfig, type NodeConfig } from "./config";
import { canonical, generateIdentity, hash, verifyBatch } from "./crypto";
import { calculate } from "./engine";
import { JOURNAL_LIMITS, validateEquivocationProof, type SqlDriver } from "./journal";
import { parseRecoveryProvenance, RECOVERY_PROVENANCE_LIMITS, verifyRecoveryProvenance, type RecoveryProvenanceRecord } from "./local-backup-metadata";
import { restoreArchivedPythState, verifyPythStateContinuity } from "./pyth/recovery-state";
import { RECOVERY_MARKER } from "./recovery";
import { readStreamContainer, writeStreamContainer, type StreamContainerOptions, type StreamContainerSummary } from "./stream-container";
import type { SignedBatch } from "./types";
import { observationSchema, parseMethodology, parseRegistry, signedBatchSchema } from "./validation";

export const STREAM_RECOVERY_LIMITS = Object.freeze({maxRecords:5_000_000,maxDatabaseBytes:20*1024*1024*1024,
  maxSnapshotInputs:1000,maxSnapshotInputBytes:32*1024*1024,maxSnapshotObservations:50_000,minFreeDiskBytes:64*1024*1024});
export interface StreamRecoveryOptions extends StreamContainerOptions {
  expectedNodeId:string;
  expectedRelease:string;
  maxRecords?:number;
  maxDatabaseBytes?:number;
  maxSnapshotInputs?:number;
  maxSnapshotInputBytes?:number;
  maxSnapshotObservations?:number;
}
const digest=z.string().regex(/^[a-f0-9]{64}$/),positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const snapshotReferences=z.object({schemaVersion:z.literal(1),calculatedAt:positive,registryHash:digest,methodologyHash:digest,
  inputBatchHashes:z.array(digest),rejected:z.array(z.object({batchHash:digest,reason:z.string()}).strict())}).passthrough();
const quarantineReference=z.object({sequence:positive,first:digest,second:digest}).strict();
function fail(code:string):never {throw new Error(`STREAM_RECOVERY_${code}`);}
function limit(value:number|undefined,fallback:number):number {
  const actual=value??fallback;if(!Number.isSafeInteger(actual)||actual<1)fail("INVALID_LIMIT");return actual;
}
function boundedJson(text:string,maximum=ARCHIVE_LIMITS.recordBytes):unknown {
  if(Buffer.byteLength(text)>maximum)fail("RECORD_TOO_LARGE");return JSON.parse(text) as unknown;
}
function checkpoint(database:Database,options:StreamRecoveryOptions):void {
  options.signal?.throwIfAborted();
  const pages=(database.query("PRAGMA page_count").get() as {page_count:number}).page_count;
  const size=(database.query("PRAGMA page_size").get() as {page_size:number}).page_size;
  if(pages*size>limit(options.maxDatabaseBytes,STREAM_RECOVERY_LIMITS.maxDatabaseBytes))fail("DATABASE_BUDGET_EXCEEDED");
}
function disk(path:string,additionalBytes:number,options:StreamRecoveryOptions):void {
  const reserve=options.minFreeDiskBytes??STREAM_RECOVERY_LIMITS.minFreeDiskBytes;
  if(!Number.isSafeInteger(reserve)||reserve<0)fail("INVALID_LIMIT");
  const stat=statfsSync(path,{bigint:true});
  if(stat.bavail*stat.bsize<BigInt(additionalBytes)+BigInt(reserve))fail("DISK_RESERVE");
}
function privateJson(path:string,value:unknown):void {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const fd=openSync(path,"wx",0o600);
  try{writeFileSync(fd,canonical(value));fsyncSync(fd);}finally{closeSync(fd);}
}
function count(journal:ChunkedJournal,query:string,...values:unknown[]):number {
  return (journal.db.query(query).get(...values) as {count:number}).count;
}

/** All history is checked, with one bounded snapshot input set resident at a time. */
export async function verifyStreamDatabase(journal:ChunkedJournal,descriptor:ArchiveDescriptor,options:StreamRecoveryOptions) {
  const db=journal.db,sourceNodeId=descriptor.payload.source.nodeId,createdAt=descriptor.payload.createdAt;
  const maximumInputs=limit(options.maxSnapshotInputs,STREAM_RECOVERY_LIMITS.maxSnapshotInputs);
  const maximumBytes=limit(options.maxSnapshotInputBytes,STREAM_RECOVERY_LIMITS.maxSnapshotInputBytes);
  const maximumObservations=limit(options.maxSnapshotObservations,STREAM_RECOVERY_LIMITS.maxSnapshotObservations);
  let steps=0;
  const tick=async()=>{if(++steps%128===0){await setImmediate();options.signal?.throwIfAborted();}};
  options.signal?.throwIfAborted();
  for(const row of db.query("PRAGMA integrity_check").iterate() as Iterable<{integrity_check:string}>)if(row.integrity_check!=="ok")fail("DATABASE_INTEGRITY");
  for(const [table,expected] of descriptor.payload.counts.entries()) {
    if(count(journal,`SELECT COUNT(*) AS count FROM ${ARCHIVE_TABLES[table]!.name}`)!==expected)fail("TABLE_COUNT_MISMATCH");
  }
  const head=db.query("SELECT id,hash FROM snapshots ORDER BY id DESC LIMIT 1").get();
  if(canonical(head??null)!==canonical(descriptor.payload.snapshotHead))fail("SNAPSHOT_HEAD_MISMATCH");
  if(count(journal,"SELECT COUNT(*) AS count FROM evidence WHERE length(body)<>0")||
    count(journal,"SELECT COUNT(*) AS count FROM evidence e LEFT JOIN evidence_sizes s ON e.hash=s.hash WHERE s.hash IS NULL")||
    count(journal,"SELECT COUNT(*) AS count FROM evidence_sizes s LEFT JOIN evidence e ON e.hash=s.hash WHERE e.hash IS NULL")||
    count(journal,"SELECT COUNT(*) AS count FROM evidence_chunks c LEFT JOIN evidence e ON e.hash=c.hash WHERE e.hash IS NULL"))fail("EVIDENCE_METADATA_MISMATCH");
  if(count(journal,"SELECT COUNT(*) AS count FROM evidence WHERE received_at>?",createdAt))fail("EVIDENCE_RECEIPT_CLOCK");
  let evidenceBytes=0;
  for(const row of db.query("SELECT hash FROM evidence ORDER BY hash").iterate() as Iterable<{hash:string}>) {
    for(const bytes of journal.evidenceParts(row.hash)){evidenceBytes+=bytes.byteLength;await tick();}
    await tick();
  }
  for(const row of db.query("SELECT hash,payload FROM configurations").iterate() as Iterable<{hash:string;payload:string}>) {
    if(hash(boundedJson(row.payload,1_000_000))!==row.hash)fail("CONFIGURATION_DIGEST_MISMATCH");await tick();
  }
  const registry=parseRegistry(journal.configuration(descriptor.payload.configuration.registryHash));
  const methodology=parseMethodology(journal.configuration(descriptor.payload.configuration.methodologyHash));
  if(registry.network!==descriptor.payload.configuration.network)fail("NETWORK_MISMATCH");
  const usage=journal.candidateUsage();
  if(usage.identities>JOURNAL_LIMITS.candidateIdentities||usage.bytes>JOURNAL_LIMITS.candidatesTotalBytes||
    count(journal,"SELECT COUNT(*) AS count FROM reports")>JOURNAL_LIMITS.reportRows)fail("REPORT_CAPACITY");
  if(count(journal,"SELECT COUNT(*) AS count FROM collector_schedules")>256)fail("COLLECTOR_SCHEDULE_CAPACITY");
  if(count(journal,"SELECT COUNT(*) AS count FROM candidates c WHERE EXISTS (SELECT 1 FROM reports r WHERE r.node_id=c.node_id AND r.sequence>=c.sequence)"))fail("CANDIDATE_HIGHWATER_MISMATCH");
  const checkCounter=(report:SignedBatch)=>{
    const counter=db.query("SELECT value FROM counters WHERE id=?").get(report.payload.nodeId) as {value:number}|null;
    if(counter?counter.value<report.payload.sequence:report.payload.nodeId===sourceNodeId)fail("COUNTER_HIGHWATER_MISMATCH");
  };
  for(const row of db.query("SELECT id,value FROM counters").iterate() as Iterable<{id:string;value:number}>) {
    if(!digest.safeParse(row.id).success||!positive.safeParse(row.value).success)fail("COUNTER_INVALID");await tick();
  }
  for(const row of db.query("SELECT hash,node_id,sequence,received_at,payload,NULL AS payload_bytes FROM reports UNION ALL SELECT hash,node_id,sequence,received_at,payload,payload_bytes FROM candidates").iterate() as Iterable<{hash:string;node_id:string;sequence:number;received_at:number;payload:string;payload_bytes:number|null}>) {
    const bytes=Buffer.byteLength(row.payload),report=signedBatchSchema.parse(boundedJson(row.payload,row.payload_bytes===null?JOURNAL_LIMITS.reportBytes:JOURNAL_LIMITS.candidateBytes)) as SignedBatch;
    if(hash(report)!==row.hash||!verifyBatch(report))fail("REPORT_SIGNATURE_INVALID");
    if(row.node_id!==report.payload.nodeId||row.sequence!==report.payload.sequence||!positive.safeParse(row.received_at).success||row.received_at>createdAt||row.payload_bytes!==null&&row.payload_bytes!==bytes)fail("REPORT_ROUTING_MISMATCH");
    checkCounter(report);await tick();
  }
  for(const row of db.query("SELECT node_id,detected_at,conflicting_payload FROM equivocations").iterate() as Iterable<{node_id:string;detected_at:number;conflicting_payload:string}>) {
    const ref=quarantineReference.parse(boundedJson(row.conflicting_payload));
    if(!digest.safeParse(row.node_id).success||!positive.safeParse(row.detected_at).success||row.detected_at>createdAt||ref.first===ref.second)fail("QUARANTINE_INVALID");await tick();
  }
  let verifiedProofs=0,proofBytes=0;
  for(const row of db.query("SELECT id,node_id,detected_at,first_payload,second_payload,payload_bytes FROM equivocation_proofs").iterate() as Iterable<{id:number;node_id:string;detected_at:number;first_payload:string;second_payload:string;payload_bytes:number}>) {
    const first=boundedJson(row.first_payload,JOURNAL_LIMITS.reportBytes) as SignedBatch,second=boundedJson(row.second_payload,JOURNAL_LIMITS.reportBytes) as SignedBatch;
    validateEquivocationProof({first,second});
    const exclusion=db.query("SELECT detected_at,conflicting_payload FROM equivocations WHERE node_id=?").get(row.node_id) as {detected_at:number;conflicting_payload:string}|null;
    const ref=exclusion?quarantineReference.parse(boundedJson(exclusion.conflicting_payload)):null;
    if(row.node_id!==first.payload.nodeId||!positive.safeParse(row.id).success||!positive.safeParse(row.detected_at).success||row.detected_at>createdAt||row.payload_bytes!==Buffer.byteLength(row.first_payload)+Buffer.byteLength(row.second_payload)||!exclusion||!ref||exclusion.detected_at>row.detected_at||ref.sequence!==first.payload.sequence||ref.first!==hash(first)||ref.second!==hash(second))fail("QUARANTINE_LINKAGE_MISMATCH");
    proofBytes+=row.payload_bytes;verifiedProofs++;
    if(verifiedProofs>JOURNAL_LIMITS.proofRows||proofBytes>JOURNAL_LIMITS.proofsTotalBytes)fail("PROOF_CAPACITY");
    checkCounter(first);checkCounter(second);await tick();
  }
  const unavailable=count(journal,"SELECT COUNT(*) AS count FROM equivocations e LEFT JOIN equivocation_proofs p ON e.node_id=p.node_id WHERE p.node_id IS NULL");
  if(count(journal,"SELECT COUNT(*) AS count FROM (SELECT collected_at FROM collection_captures GROUP BY collected_at HAVING COUNT(*)<>1)")||
    count(journal,"SELECT COUNT(*) AS count FROM collection_captures c WHERE NOT EXISTS (SELECT 1 FROM captures b WHERE b.collected_at=c.collected_at)")||
    count(journal,"SELECT COUNT(*) AS count FROM captures b WHERE NOT EXISTS (SELECT 1 FROM collection_captures c WHERE c.collected_at=b.collected_at)"))fail("CAPTURE_CYCLE_MEMBERSHIP");
  for(const row of db.query("SELECT id,collected_at FROM collection_captures").iterate() as Iterable<{id:number;collected_at:number}>) {
    if(!positive.safeParse(row.id).success||!positive.safeParse(row.collected_at).success||row.collected_at>createdAt)fail("CAPTURE_CYCLE_INVALID");await tick();
  }
  let observationCount=0;
  for(const row of db.query("SELECT id,collected_at,observations,errors FROM captures ORDER BY id").iterate() as Iterable<{id:number;collected_at:number;observations:string;errors:string}>) {
    if(!positive.safeParse(row.id).success||!positive.safeParse(row.collected_at).success||row.collected_at>createdAt)fail("CAPTURE_ROUTING_INVALID");
    const observations=boundedJson(row.observations),errors=boundedJson(row.errors);
    if(!Array.isArray(observations)||!Array.isArray(errors)||errors.some(value=>typeof value!=="string"))fail("CAPTURE_SCHEMA_INVALID");
    for(const raw of observations) {
      const observation=observationSchema.parse(raw);
      if(observation.observedAt>row.collected_at)fail("CAPTURE_OBSERVATION_CLOCK");
      const evidence=db.query("SELECT received_at FROM evidence WHERE hash=?").get(observation.evidenceHash) as {received_at:number}|null;
      if(!evidence)fail("CAPTURE_EVIDENCE_MISSING");
      if(evidence.received_at>row.collected_at)fail("CAPTURE_EVIDENCE_RECEIPT_CLOCK");
      observationCount++;await tick();
    }
    await tick();
  }
  let reproducedSnapshots=0,previousHash:string|null=null;
  for(const row of db.query("SELECT id,calculated_at,hash,previous_hash,payload FROM snapshots ORDER BY id").iterate() as Iterable<{id:number;calculated_at:number;hash:string;previous_hash:string|null;payload:string}>) {
    const original=boundedJson(row.payload),references=snapshotReferences.parse(original);
    if(!positive.safeParse(row.id).success||row.calculated_at!==references.calculatedAt||row.calculated_at>createdAt||row.previous_hash!==previousHash||hash({previousHash,snapshot:original})!==row.hash)fail("SNAPSHOT_HISTORY_MISMATCH");
    if(references.inputBatchHashes.length+references.rejected.length>maximumInputs)fail("SNAPSHOT_INPUT_BUDGET");
    const inputs:SignedBatch[]=[],seen=new Set<string>();let bytes=0,observations=0;
    for(const inputHash of [...references.inputBatchHashes,...references.rejected.map(item=>item.batchHash)]) {
      if(seen.has(inputHash))continue;seen.add(inputHash);
      const report=db.query("SELECT payload FROM reports WHERE hash=?").get(inputHash) as {payload:string}|null;
      if(!report)fail("SNAPSHOT_REPORT_MISSING");
      bytes+=Buffer.byteLength(report.payload);if(bytes>maximumBytes)fail("SNAPSHOT_INPUT_BUDGET");
      const value=boundedJson(report.payload,JOURNAL_LIMITS.reportBytes) as SignedBatch;
      observations+=value.payload.observations.length;if(observations>maximumObservations)fail("SNAPSHOT_OBSERVATION_BUDGET");inputs.push(value);
    }
    const reproduced=calculate(inputs,parseRegistry(journal.configuration(references.registryHash)),parseMethodology(journal.configuration(references.methodologyHash)),references.calculatedAt);
    if(hash(reproduced)!==hash(original))fail("SNAPSHOT_REPRODUCTION_MISMATCH");
    previousHash=row.hash;reproducedSnapshots++;await tick();
  }
  options.signal?.throwIfAborted();
  const recoveryProvenance=verifyRecoveryProvenance(journal,descriptor);
  let currentDescriptor:ArchiveDescriptor|undefined=descriptor,pythRecovery:ReturnType<typeof verifyPythStateContinuity>|undefined,depth=0;
  // A malformed intermediate recovery cannot erase an older signed floor.
  // Verify every linked edge at its own historical clock, not only the tip.
  while(currentDescriptor) {
    if(++depth>RECOVERY_PROVENANCE_LIMITS.chainDepth+1)fail("PYTH_RECOVERY_CHAIN_CAPACITY");
    const prior:RecoveryProvenanceRecord|undefined=currentDescriptor.payload.recoveryProvenanceHash===undefined?undefined:parseRecoveryProvenance(journal.configuration(currentDescriptor.payload.recoveryProvenanceHash));
    const checked=verifyPythStateContinuity(journal,currentDescriptor.payload.pythStateHash,prior?.descriptor.payload.pythStateHash,currentDescriptor.payload.createdAt);
    pythRecovery??=checked;currentDescriptor=prior?.descriptor;await tick();
  }
  if(!pythRecovery)fail("PYTH_RECOVERY_CHAIN_MISSING");
  return {history:{valid:true as const,count:reproducedSnapshots},counts:journal.counts(),coverage:journal.captureCounts(),reproducedSnapshots,
    evidenceBytes,observations:observationCount,quarantineProofs:{verified:verifiedProofs,unavailable,requiresReview:unavailable>0},
    recoveryProvenance,pythRecovery,registry,methodology};
}

async function stage(inputPath:string,keyPath:string,options:StreamRecoveryOptions) {
  if(!digest.safeParse(options.expectedNodeId).success||!/^[a-f0-9]{40}$/.test(options.expectedRelease))fail("SOURCE_PIN_REQUIRED");
  const maximumRecords=limit(options.maxRecords,STREAM_RECOVERY_LIMITS.maxRecords);
  limit(options.maxDatabaseBytes,STREAM_RECOVERY_LIMITS.maxDatabaseBytes);
  options.signal?.throwIfAborted();
  const directory=mkdtempSync(join(tmpdir(),"sbx-stream-recovery-"));chmodSync(directory,0o700);
  let database:Database|undefined,reader:ReturnType<typeof readStreamContainer>|undefined;
  try {
    disk(directory,0,options);
    const path=join(directory,"journal.sqlite");database=new Database(path,{create:true,strict:true});chmodSync(path,0o600);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    const journal=new ChunkedJournal(database as unknown as SqlDriver);collectorSchedule(journal,"stream-import",1);
    const inserts=ARCHIVE_TABLES.map(table=>database!.query(`INSERT INTO ${table.name}(${table.columns.join(",")}) VALUES(${table.columns.map(()=>"?").join(",")})`));
    reader=readStreamContainer(inputPath,keyPath,options);
    const first=await reader.next();if(first.done)fail("DESCRIPTOR_MISSING");
    const descriptor=parseArchiveDescriptor(new TextDecoder("utf-8",{fatal:true}).decode(first.value),options.expectedNodeId,options.expectedRelease);
    if(descriptor.payload.counts.reduce((sum,value)=>sum+value,0)>maximumRecords)fail("RECORD_BUDGET");
    let current:{fragment:ArchiveFragment;bytes:Buffer;offset:number}|null=null,blockCount=0,totalBytes=0,totalRecords=0;
    let previousHash:string|null=null,cursor:ArchiveCursor={table:0,position:0,offset:0},seal:ArchiveSeal|null=null,summary:StreamContainerSummary|undefined;
    const counts=ARCHIVE_TABLES.map(()=>0);
    for(;;) {
      const next=await reader.next();if(next.done){summary=next.value;break;}
      if(seal)fail("TRAILING_SOURCE_FRAME");
      const text=new TextDecoder("utf-8",{fatal:true}).decode(next.value),raw=boundedJson(text,ARCHIVE_LIMITS.transportBytes);
      if(raw&&typeof raw==="object"&&"payload" in raw&&(raw as {payload?:{format?:string}}).payload?.format==="SBX_CHECKPOINT_SEAL_V2") {
        if(current)fail("TRUNCATED_RECORD");
        if(canonical(cursor)!==canonical({table:ARCHIVE_TABLES.length,position:0,offset:0}))fail("TERMINAL_CURSOR_MISSING");
        seal=parseArchiveSeal(raw,descriptor,{blockCount,totalBytes,counts,finalHash:previousHash});continue;
      }
      const block=parseArchiveBlock(raw,descriptor,{index:blockCount,previousHash,cursor});
      disk(directory,ARCHIVE_LIMITS.recordBytes*2,options);
      database.transaction(()=>{
        for(const fragment of block.fragments) {
          const bytes=Buffer.from(fragment.data,"base64");totalBytes+=bytes.byteLength;
          if(!Number.isSafeInteger(totalBytes))fail("BYTE_OVERFLOW");
          if(!current) {
            if(fragment.offset!==0)fail("RECORD_FRAGMENT_GAP");
            current={fragment,bytes:Buffer.allocUnsafe(fragment.totalLength),offset:0};
          }
          if(fragment.table!==current.fragment.table||fragment.position!==current.fragment.position||canonical(fragment.key)!==canonical(current.fragment.key)||fragment.totalLength!==current.bytes.length||fragment.offset!==current.offset)fail("RECORD_FRAGMENT_MISMATCH");
          current.bytes.set(bytes,current.offset);current.offset+=bytes.length;
          if(current.offset===current.bytes.length) {
            const row=decodeArchiveRecord(fragment.table,fragment.key,current.bytes);
            inserts[fragment.table]!.run(...row.map(value=>typeof value==="object"&&value!==null?Buffer.from(value.base64,"base64"):value));
            counts[fragment.table]=counts[fragment.table]!+1;totalRecords++;
            if(totalRecords>maximumRecords||counts[fragment.table]!>descriptor.payload.counts[fragment.table]!)fail("RECORD_COUNT_MISMATCH");
            current=null;
          }
        }
      })();
      blockCount++;previousHash=block.hash;cursor=block.end;
      checkpoint(database,options);await setImmediate();options.signal?.throwIfAborted();
    }
    if(!seal||!summary||current)fail("SOURCE_SEAL_MISSING");
    // These local indexes are operational metadata, never archive-supplied SQL.
    database.exec("CREATE INDEX IF NOT EXISTS stream_capture_time ON captures(collected_at); CREATE INDEX IF NOT EXISTS stream_cycle_time ON collection_captures(collected_at)");
    const verified=await verifyStreamDatabase(journal,descriptor,options);
    restoreArchivedPythState(journal,descriptor.payload.pythStateHash,descriptor.payload.createdAt);
    database.exec("CREATE TABLE local_journal_storage (id INTEGER PRIMARY KEY CHECK(id=1),version TEXT NOT NULL); CREATE TABLE archive_recovery_provenance (id INTEGER PRIMARY KEY CHECK(id=1),descriptor TEXT NOT NULL,seal TEXT NOT NULL,archive_sha256 TEXT NOT NULL,archive_bytes INTEGER NOT NULL)");
    database.query("INSERT INTO local_journal_storage(id,version) VALUES(1,?)").run(CHUNKED_JOURNAL_VERSION);
    database.query("INSERT INTO archive_recovery_provenance(id,descriptor,seal,archive_sha256,archive_bytes) VALUES(1,?,?,?,?)").run(canonical(descriptor),canonical(seal),summary.sha256,summary.archiveBytes);
    checkpoint(database,options);database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    // A portable recovery image must be readable without creating WAL/SHM sidecars.
    // Reviewed Store startup can explicitly opt back into WAL afterward.
    const mode=database.query("PRAGMA journal_mode=DELETE").get() as {journal_mode:string};
    if(mode.journal_mode!=="delete")fail("PORTABLE_DATABASE_CHECKPOINT");
    database.close();database=undefined;
    return {directory,path,descriptor,seal,summary,verified};
  } catch(error) {try{database?.close();}finally{rmSync(directory,{recursive:true,force:true});}throw error;}
  finally {await reader?.return(undefined as never);}
}
function publicSummary(data:Awaited<ReturnType<typeof stage>>) {
  const {registry:_registry,methodology:_methodology,...verification}=data.verified;
  return {format:data.summary.format,sourceNodeId:data.descriptor.payload.source.nodeId,sourceRelease:data.descriptor.payload.source.release,
    checkpointId:data.descriptor.payload.checkpointId,createdAt:data.descriptor.payload.createdAt,descriptorHash:archiveDescriptorHash(data.descriptor),
    archiveSha256:data.summary.sha256,archiveBytes:data.summary.archiveBytes,databaseBytes:statSync(data.path).size,
    blockCount:data.seal.payload.blockCount,storageVersion:CHUNKED_JOURNAL_VERSION,...verification};
}
export async function inspectStreamBackup(inputPath:string,keyPath:string,options:StreamRecoveryOptions) {
  const data=await stage(inputPath,keyPath,options);
  try{return publicSummary(data);}finally{rmSync(data.directory,{recursive:true,force:true});}
}

/** Authenticate source framing while writing only ciphertext. Content inspection is a separate pass. */
export async function backupStreamFrames(frames:AsyncIterable<Uint8Array>,outputPath:string,keyPath:string,options:StreamRecoveryOptions) {
  const maximumRecords=limit(options.maxRecords,STREAM_RECOVERY_LIMITS.maxRecords);
  let descriptor:ArchiveDescriptor|undefined,seal:ArchiveSeal|undefined;
  async function* verifiedFrames() {
    let index=0,totalBytes=0,totalRecords=0,previousHash:string|null=null,cursor:ArchiveCursor={table:0,position:0,offset:0};
    const counts=ARCHIVE_TABLES.map(()=>0);
    let current:{fragment:ArchiveFragment;bytes:Buffer;offset:number}|null=null;
    for await(const frame of frames) {
      options.signal?.throwIfAborted();
      if(frame.byteLength>ARCHIVE_LIMITS.transportBytes)fail("FRAME_TOO_LARGE");
      const text=new TextDecoder("utf-8",{fatal:true}).decode(frame);
      if(!descriptor) {
        descriptor=parseArchiveDescriptor(text,options.expectedNodeId,options.expectedRelease);
        if(descriptor.payload.counts.reduce((sum,value)=>sum+value,0)>maximumRecords)fail("RECORD_BUDGET");
      } else {
        if(seal)fail("TRAILING_SOURCE_FRAME");
        const raw=boundedJson(text,ARCHIVE_LIMITS.transportBytes);
        if(raw&&typeof raw==="object"&&"payload" in raw&&(raw as {payload?:{format?:string}}).payload?.format==="SBX_CHECKPOINT_SEAL_V2") {
          if(current)fail("TRUNCATED_RECORD");
          if(canonical(cursor)!==canonical({table:ARCHIVE_TABLES.length,position:0,offset:0}))fail("TERMINAL_CURSOR_MISSING");
          seal=parseArchiveSeal(raw,descriptor,{blockCount:index,totalBytes,counts,finalHash:previousHash});
        } else {
          const block=parseArchiveBlock(raw,descriptor,{index,previousHash,cursor});
          for(const fragment of block.fragments) {
            const bytes=Buffer.from(fragment.data,"base64");totalBytes+=bytes.byteLength;
            if(!Number.isSafeInteger(totalBytes))fail("BYTE_OVERFLOW");
            if(!current) {
              if(fragment.offset!==0)fail("RECORD_FRAGMENT_GAP");
              current={fragment,bytes:Buffer.allocUnsafe(fragment.totalLength),offset:0};
            }
            if(fragment.table!==current.fragment.table||fragment.position!==current.fragment.position||canonical(fragment.key)!==canonical(current.fragment.key)||fragment.totalLength!==current.bytes.length||fragment.offset!==current.offset)fail("RECORD_FRAGMENT_MISMATCH");
            current.bytes.set(bytes,current.offset);current.offset+=bytes.length;
            if(current.offset===current.bytes.length) {
              decodeArchiveRecord(fragment.table,fragment.key,current.bytes);counts[fragment.table]=counts[fragment.table]!+1;totalRecords++;
              if(totalRecords>maximumRecords||counts[fragment.table]!>descriptor.payload.counts[fragment.table]!)fail("RECORD_COUNT_MISMATCH");
              current=null;
            }
          }
          index++;previousHash=block.hash;cursor=block.end;
        }
      }
      yield frame;
    }
    if(!descriptor||!seal||current)fail("SOURCE_SEAL_MISSING");
  }
  const result=await writeStreamContainer(verifiedFrames(),outputPath,keyPath,options);
  return {...result,sourceNodeId:descriptor!.payload.source.nodeId,sourceRelease:descriptor!.payload.source.release,checkpointId:descriptor!.payload.checkpointId,
    descriptorHash:archiveDescriptorHash(descriptor!),sourceVerified:true,contentInspection:"REQUIRED",privateKeysIncluded:false,providerCredentialsIncluded:false};
}
export async function restoreStreamNode(inputPath:string,keyPath:string,destination:string,options:StreamRecoveryOptions) {
  try{lstatSync(destination);fail("NEW_DESTINATION_REQUIRED");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const data=await stage(inputPath,keyPath,options);
  try {
    options.signal?.throwIfAborted();
    const summary=publicSummary(data),identity=generateIdentity(),sourceNodeId=data.descriptor.payload.source.nodeId;
    const configuration:NodeConfig={schemaVersion:1,network:data.descriptor.payload.configuration.network,identityPath:"data/node-identity.json",databasePath:"data/node.sqlite",
      registryPath:"config/registry.local.json",methodologyPath:"config/methodology.local.json",host:"127.0.0.1",port:3410,intervalMs:data.descriptor.payload.configuration.intervalMs,
      collectors:[],peers:[],allowLoopbackPeers:false};
    const registry={...data.verified.registry,version:`recovery-${Date.now()}`,operators:data.verified.registry.operators.filter(operator=>operator.nodeId!==sourceNodeId)};
    parseRegistry(registry);parseConfig(configuration);disk(dirname(resolve(destination)),summary.databaseBytes,options);
    mkdirSync(destination,{mode:0o700});
    privateJson(join(destination,RECOVERY_MARKER),{status:"RECOVERY_REVIEW_REQUIRED",sourceNodeId,newNodeId:identity.nodeId,restoredAt:Date.now(),
      archiveSha256:summary.archiveSha256,requirements:["Review source history and retain the encrypted source archive and its separately protected key.",
        "Never resume the previous signing identity from this historical counter; explicitly reconcile or revoke the previous signer.",
        "Run and independently inspect a local backup-stream archive, then establish offsite custody and restore tests before production activation. Legacy V1 backup does not support chunked journals.",
        "Review source rights, independent-operator admission, credentials, peers and Pyth setup. Collectors, peers and Pyth remain disabled.",
        "Pyth submission high-water marks and queue receipts are retained; process locks are cleared. Stop or revoke the previous Pyth signer and reconcile newer attempts after this backup before enabling any publisher. Queue receipts are not upstream or onchain proof.",
        "Remove this marker only after documented operator review."]});
    copyFileSync(data.path,join(destination,configuration.databasePath),constants.COPYFILE_EXCL);chmodSync(join(destination,configuration.databasePath),0o600);
    const databaseFd=openSync(join(destination,configuration.databasePath),"r");try{fsyncSync(databaseFd);}finally{closeSync(databaseFd);}
    privateJson(join(destination,configuration.identityPath),identity);privateJson(join(destination,configuration.registryPath),registry);
    privateJson(join(destination,configuration.methodologyPath),data.verified.methodology);privateJson(join(destination,"config/node.local.json"),configuration);
    return {destination,newNodeId:identity.nodeId,status:"RECOVERY_REVIEW_REQUIRED",privateKeysIncluded:false,providerCredentialsIncluded:false,...summary};
  } finally {rmSync(data.directory,{recursive:true,force:true});}
}
