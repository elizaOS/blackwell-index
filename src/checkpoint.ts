/** Private durable checkpoints. All SQL cursors finish before this synchronous API returns. */
import { randomUUID } from "node:crypto";
import { canonical, hash } from "./crypto";
import { ARCHIVE_INTERNAL_TABLES, HOSTED_INTERNAL_TABLES, HOSTED_TABLES } from "./hosted-export";
import { ARCHIVE_FORMAT, ARCHIVE_LIMITS, ARCHIVE_TABLES, archiveBlockHash, archiveDescriptorHash, archiveRecordKey, encodeArchiveRecord,
  parseArchiveBlock, parseArchiveDescriptor, parseArchiveSeal, signArchiveDescriptor, signArchiveSeal, archiveCursorSchema,
  type ArchiveBlock, type ArchiveCursor, type ArchiveDescriptor, type ArchiveSeal } from "./archive-protocol";
import { JOURNAL_LIMITS, type Journal } from "./journal";
import type { Methodology, NodeIdentity, Registry } from "./types";
import { parseMethodology, parseRegistry } from "./validation";

export interface CheckpointSource {nodeName:"primary"|"secondary";operatorGroup:string;release:string}
export interface CheckpointMetadata extends CheckpointSource {network:string;intervalMs:number;registry:Registry;methodology:Methodology}
const INITIAL_CURSOR:ArchiveCursor={table:0,position:0,offset:0};
const MAX_FROZEN_BYTES=18*1024*1024;
export const CHECKPOINT_STAGING_LIMITS=Object.freeze({frozenBytes:MAX_FROZEN_BYTES,blockCount:65536,metadataBytes:32*1024*1024});
const frozenNames:Record<number,string>={0:"archive_frozen_counters",2:"archive_frozen_candidates",12:"archive_frozen_schedules"};
const privateColumns:Record<string,readonly string[]>={
  archive_schema:["id","version"],archive_entries:["sequence","table_code","key_text","key_integer"],
  archive_checkpoints:["id","expires_at","descriptor","cursor","next_block","last_hash","total_bytes","counts","state","seal","metadata_bytes"],
  archive_frozen_counters:["ordinal","checkpoint_id","id","value"],
  archive_frozen_candidates:["ordinal","checkpoint_id","node_id","sequence","received_at","hash","payload","payload_bytes"],
  archive_frozen_schedules:["ordinal","checkpoint_id","collector_id","next_attempt_at","failures","reason","last_seen_at","version","lease_owner","lease_until"],
  archive_blocks:["checkpoint_id","block_number","start_cursor","end_cursor","bytes","previous_hash","hash"],
};
interface CheckpointRow {id:string;expires_at:number;descriptor:string;cursor:string;next_block:number;last_hash:string|null;total_bytes:number;counts:string;state:"ACTIVE"|"SEALED";seal:string|null;metadata_bytes:number}
interface BlockRow {checkpoint_id:string;block_number:number;start_cursor:string;end_cursor:string;bytes:number;previous_hash:string|null;hash:string}
function count(journal:Journal,sql:string,...bindings:unknown[]):number {const value=(journal.db.query(sql).get(...bindings) as {count:number}).count;if(!Number.isSafeInteger(value)||value<0)throw new Error("ARCHIVE_COUNT_INVALID");return value;}
function time(now:number):void {if(!Number.isSafeInteger(now)||now<1||now>8_640_000_000_000_000-ARCHIVE_LIMITS.maxTtlMs)throw new Error("ARCHIVE_CLOCK_INVALID");}
function match(table:(typeof ARCHIVE_TABLES)[number],row="t",entry="a"):string {
  return `${entry}.key_text=${table.keyText?`${row}.${table.keyText}`:"''"} AND ${entry}.key_integer=${table.keyInteger?`${row}.${table.keyInteger}`:"0"}`;
}
function schema(journal:Journal,includePrivate=true):void {
  const names=(journal.db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name);
  if(names.some(name=>!HOSTED_TABLES.some(table=>table.name===name)&&!HOSTED_INTERNAL_TABLES.has(name)&&!ARCHIVE_INTERNAL_TABLES.has(name)&&!name.startsWith("sqlite_")))throw new Error("ARCHIVE_SCHEMA_REVIEW_REQUIRED");
  for(const table of HOSTED_TABLES) {
    if(!names.includes(table.name))throw new Error("ARCHIVE_TABLE_MISSING");
    const actual=(journal.db.query(`PRAGMA table_info(${table.name})`).all() as {name:string}[]).map(row=>row.name);
    if(canonical(actual)!==canonical(table.columns))throw new Error("ARCHIVE_SCHEMA_REVIEW_REQUIRED");
  }
  if(includePrivate)for(const [name,columns] of Object.entries(privateColumns)) {
    const actual=(journal.db.query(`PRAGMA table_info(${name})`).all() as {name:string}[]).map(row=>row.name);
    if(canonical(actual)!==canonical(columns))throw new Error("ARCHIVE_SCHEMA_REVIEW_REQUIRED");
  }
}
/** SQL-only key migration: no evidence or historical payloads are read into JavaScript. */
export function initializeCheckpointStorage(journal:Journal):void {
  journal.db.transaction(()=>{
    journal.db.exec("CREATE TABLE IF NOT EXISTS collector_schedules (collector_id TEXT PRIMARY KEY, next_attempt_at INTEGER NOT NULL, failures INTEGER NOT NULL, reason TEXT NOT NULL, last_seen_at INTEGER NOT NULL, version INTEGER NOT NULL, lease_owner TEXT, lease_until INTEGER NOT NULL)");
    schema(journal,false);
    journal.db.exec(`
      CREATE TABLE IF NOT EXISTS archive_schema (id INTEGER PRIMARY KEY,version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS archive_entries (sequence INTEGER PRIMARY KEY AUTOINCREMENT,table_code INTEGER NOT NULL,key_text TEXT NOT NULL,key_integer INTEGER NOT NULL,UNIQUE(table_code,key_text,key_integer));
      CREATE INDEX IF NOT EXISTS archive_entry_page ON archive_entries(table_code,sequence);
      CREATE TABLE IF NOT EXISTS archive_checkpoints (id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,descriptor TEXT NOT NULL,cursor TEXT NOT NULL,next_block INTEGER NOT NULL,last_hash TEXT,total_bytes INTEGER NOT NULL,counts TEXT NOT NULL,state TEXT NOT NULL,seal TEXT,metadata_bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS archive_frozen_counters (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,checkpoint_id TEXT NOT NULL,id TEXT NOT NULL,value INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS archive_counter_page ON archive_frozen_counters(checkpoint_id,ordinal);
      CREATE TABLE IF NOT EXISTS archive_frozen_candidates (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,checkpoint_id TEXT NOT NULL,node_id TEXT NOT NULL,sequence INTEGER NOT NULL,received_at INTEGER NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,payload_bytes INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS archive_candidate_page ON archive_frozen_candidates(checkpoint_id,ordinal);
      CREATE TABLE IF NOT EXISTS archive_frozen_schedules (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,checkpoint_id TEXT NOT NULL,collector_id TEXT NOT NULL,next_attempt_at INTEGER NOT NULL,failures INTEGER NOT NULL,reason TEXT NOT NULL,last_seen_at INTEGER NOT NULL,version INTEGER NOT NULL,lease_owner TEXT,lease_until INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS archive_schedule_page ON archive_frozen_schedules(checkpoint_id,ordinal);
      CREATE TABLE IF NOT EXISTS archive_blocks (checkpoint_id TEXT NOT NULL,block_number INTEGER NOT NULL,start_cursor TEXT NOT NULL,end_cursor TEXT NOT NULL,bytes INTEGER NOT NULL,previous_hash TEXT,hash TEXT NOT NULL,PRIMARY KEY(checkpoint_id,block_number));
    `);
    schema(journal);
    const version=journal.db.query("SELECT version FROM archive_schema WHERE id=1").get() as {version:number}|null;
    if(version&&version.version!==1)throw new Error("ARCHIVE_MEMBERSHIP_VERSION_UNSUPPORTED");
    if(!version) {
      if(count(journal,"SELECT COUNT(*) AS count FROM archive_entries")!==0||count(journal,"SELECT COUNT(*) AS count FROM archive_checkpoints")!==0)throw new Error("ARCHIVE_MEMBERSHIP_MIGRATION_INCOMPLETE");
      for(const table of ARCHIVE_TABLES.filter(table=>!table.mutable))journal.db.exec(`INSERT INTO archive_entries(table_code,key_text,key_integer) SELECT ${table.code},${table.keyText??"''"},${table.keyInteger??"0"} FROM ${table.name} ORDER BY ${table.order}`);
      verifyCheckpointMembership(journal);
      journal.db.query("INSERT INTO archive_schema(id,version) VALUES(1,1)").run();
    }
  })();
  journal.enableArchiveRegistration();
}
/** Exact bidirectional key joins reject omissions, unknown codes, and dangling entries. */
export function verifyCheckpointMembership(journal:Journal):void {
  let expected=0;
  for(const table of ARCHIVE_TABLES.filter(table=>!table.mutable)) {
    const actual=count(journal,`SELECT COUNT(*) AS count FROM ${table.name}`),members=count(journal,"SELECT COUNT(*) AS count FROM archive_entries WHERE table_code=?",table.code);
    if(actual!==members||count(journal,`SELECT COUNT(*) AS count FROM archive_entries a JOIN ${table.name} t ON ${match(table)} WHERE a.table_code=?`,table.code)!==actual)throw new Error("ARCHIVE_MEMBERSHIP_INCOMPLETE");
    expected+=actual;
  }
  if(count(journal,"SELECT COUNT(*) AS count FROM archive_entries")!==expected)throw new Error("ARCHIVE_MEMBERSHIP_INCOMPLETE");
}
function cleanup(journal:Journal,id:string):void {
  // Static allowlist; source tables and the permanent ledger are never cleanup targets.
  for(const table of [...Object.values(frozenNames),"archive_blocks"])journal.db.query(`DELETE FROM ${table} WHERE checkpoint_id=?`).run(id);
  journal.db.query("DELETE FROM archive_checkpoints WHERE id=?").run(id);
}
export function releaseCheckpoint(journal:Journal,id:string,now=Date.now(),completed=false):void {
  time(now);journal.db.transaction(()=>{
    const row=journal.db.query("SELECT * FROM archive_checkpoints WHERE id=?").get(id) as CheckpointRow|null;
    if(!row)throw new Error("ARCHIVE_CHECKPOINT_NOT_FOUND");
    if(row.expires_at>now&&!(completed&&row.state==="SEALED"))throw new Error("ARCHIVE_CHECKPOINT_NOT_COMPLETE");
    cleanup(journal,id);
  })();
}
export function beginCheckpoint(journal:Journal,identity:NodeIdentity,metadata:CheckpointMetadata,options:{now?:number;ttlMs?:number;collectionRunning?:boolean}={}):ArchiveDescriptor {
  const now=options.now??Date.now(),ttl=options.ttlMs??ARCHIVE_LIMITS.ttlMs;time(now);
  if(options.collectionRunning)throw new Error("COLLECTION_RUNNING_RETRY_EXPORT");
  if(!Number.isSafeInteger(ttl)||ttl<1000||ttl>ARCHIVE_LIMITS.maxTtlMs)throw new Error("ARCHIVE_EXPIRY_INVALID");
  return journal.db.transaction(()=>{
    schema(journal);
    const version=journal.db.query("SELECT version FROM archive_schema WHERE id=1").get() as {version:number}|null;
    if(version?.version!==1)throw new Error("ARCHIVE_MEMBERSHIP_VERSION_UNSUPPORTED");
    const existing=journal.db.query("SELECT id,expires_at FROM archive_checkpoints LIMIT 2").all() as {id:string;expires_at:number}[];
    if(existing.length>1)throw new Error("ARCHIVE_CHECKPOINT_CAPACITY");
    for(const row of existing) {if(row.expires_at>now)throw new Error("ARCHIVE_CHECKPOINT_ALREADY_ACTIVE");cleanup(journal,row.id);}
    verifyCheckpointMembership(journal);
    const candidateUsage=journal.candidateUsage();
    const candidateActualBytes=count(journal,"SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS count FROM candidates");
    if(candidateUsage.identities>JOURNAL_LIMITS.candidateIdentities||candidateUsage.bytes>JOURNAL_LIMITS.candidatesTotalBytes||candidateActualBytes>JOURNAL_LIMITS.candidatesTotalBytes||count(journal,"SELECT COUNT(*) AS count FROM counters")>4096||count(journal,"SELECT COUNT(*) AS count FROM collector_schedules")>256)throw new Error("ARCHIVE_FROZEN_CAPACITY");
    let frozenBytes=0;
    for(const table of ARCHIVE_TABLES.filter(table=>table.mutable))frozenBytes+=count(journal,`SELECT COALESCE(SUM(${table.columns.map(column=>`COALESCE(length(CAST(${column} AS BLOB)),0)+8`).join("+")}),0) AS count FROM ${table.name}`);
    if(frozenBytes>MAX_FROZEN_BYTES)throw new Error("ARCHIVE_FROZEN_CAPACITY");
    const registry=parseRegistry(metadata.registry),methodology=parseMethodology(metadata.methodology);
    if(registry.network!==metadata.network)throw new Error("ARCHIVE_NETWORK_MISMATCH");
    const registryHash=hash(registry),methodologyHash=hash(methodology),cutoff=count(journal,"SELECT COALESCE(MAX(sequence),0) AS count FROM archive_entries");
    for(const digest of [registryHash,methodologyHash])if(!journal.configuration(digest)||!journal.db.query("SELECT sequence FROM archive_entries WHERE table_code=8 AND key_text=? AND key_integer=0 AND sequence<=?").get(digest,cutoff))throw new Error("ARCHIVE_CONFIGURATION_MISSING");
    const id=randomUUID();
    for(const table of ARCHIVE_TABLES.filter(table=>table.mutable))journal.db.query(`INSERT INTO ${frozenNames[table.code]}(checkpoint_id,${table.columns.join(",")}) SELECT ?,${table.columns.join(",")} FROM ${table.name} ORDER BY ${table.order}`).run(id);
    const counts=ARCHIVE_TABLES.map(table=>table.mutable?count(journal,`SELECT COUNT(*) AS count FROM ${frozenNames[table.code]} WHERE checkpoint_id=?`,id):count(journal,"SELECT COUNT(*) AS count FROM archive_entries WHERE table_code=? AND sequence<=?",table.code,cutoff));
    const snapshotHead=journal.db.query("SELECT id,hash FROM snapshots ORDER BY id DESC LIMIT 1").get() as {id:number;hash:string}|null;
    const descriptor=signArchiveDescriptor({format:ARCHIVE_FORMAT,checkpointId:id,createdAt:now,expiresAt:now+ttl,
      source:{nodeId:identity.nodeId,publicKey:identity.publicKey,nodeName:metadata.nodeName,operatorGroup:metadata.operatorGroup,release:metadata.release},
      configuration:{network:metadata.network,intervalMs:metadata.intervalMs,registryHash,methodologyHash},cutoff,counts,snapshotHead},identity);
    journal.db.query("INSERT INTO archive_checkpoints(id,expires_at,descriptor,cursor,next_block,last_hash,total_bytes,counts,state,seal,metadata_bytes) VALUES(?,?,?,?,0,NULL,0,?,'ACTIVE',NULL,0)").run(id,now+ttl,canonical(descriptor),canonical(INITIAL_CURSOR),canonical(counts.map(()=>0)));
    return descriptor;
  })();
}
function load(journal:Journal,identity:NodeIdentity,source:CheckpointSource,id:string,now:number):{row:CheckpointRow;descriptor:ArchiveDescriptor} {
  time(now);const row=journal.db.query("SELECT * FROM archive_checkpoints WHERE id=?").get(id) as CheckpointRow|null;
  if(!row)throw new Error("ARCHIVE_CHECKPOINT_NOT_FOUND");
  const descriptor=parseArchiveDescriptor(row.descriptor,identity.nodeId,source.release),p=descriptor.payload;
  if(p.source.publicKey!==identity.publicKey||p.source.nodeName!==source.nodeName||p.source.operatorGroup!==source.operatorGroup)throw new Error("ARCHIVE_SOURCE_MISMATCH");
  if(now<p.createdAt)throw new Error("ARCHIVE_CLOCK_ROLLBACK");
  if(now>=p.expiresAt||row.expires_at!==p.expiresAt)throw new Error("ARCHIVE_CHECKPOINT_EXPIRED");
  return {row,descriptor};
}
function nextRecord(journal:Journal,descriptor:ArchiveDescriptor,cursor:ArchiveCursor):Record<string,unknown>|null {
  const table=ARCHIVE_TABLES[cursor.table];if(!table)return null;
  const comparison=cursor.offset?"=":">";
  const parameters=table.mutable?[descriptor.payload.checkpointId,cursor.position]:[table.code,cursor.position,descriptor.payload.cutoff];
  const from=table.mutable?`FROM ${frozenNames[table.code]} t WHERE checkpoint_id=? AND ordinal${comparison}? ORDER BY ordinal LIMIT 1`:`FROM archive_entries a JOIN ${table.name} t ON ${match(table)} WHERE a.table_code=? AND a.sequence${comparison}? AND a.sequence<=? ORDER BY a.sequence LIMIT 1`;
  // Reject oversized raw records inside SQL before selecting their payload. Canonical
  // escaping may still make a bounded raw row exceed the separate encoded-record cap.
  const size=journal.db.query(`SELECT ${table.columns.map(column=>`COALESCE(length(CAST(t.${column} AS BLOB)),0)`).join("+")} AS bytes ${from}`).get(...parameters) as {bytes:number}|null;
  if(!size)return null;
  if(!Number.isSafeInteger(size.bytes)||size.bytes>ARCHIVE_LIMITS.recordBytes)throw new Error("ARCHIVE_RECORD_TOO_LARGE");
  return journal.db.query(`SELECT ${table.mutable?"t.ordinal":"a.sequence"} AS archive_position,${table.columns.map(column=>`t.${column}`).join(",")} ${from}`).get(...parameters) as Record<string,unknown>|null;
}
function normalize(journal:Journal,descriptor:ArchiveDescriptor,cursor:ArchiveCursor):ArchiveCursor {
  while(cursor.table<ARCHIVE_TABLES.length) {
    const table=ARCHIVE_TABLES[cursor.table]!,comparison=cursor.offset?"=":">";
    const exists=table.mutable?journal.db.query(`SELECT ordinal FROM ${frozenNames[table.code]} WHERE checkpoint_id=? AND ordinal${comparison}? ORDER BY ordinal LIMIT 1`).get(descriptor.payload.checkpointId,cursor.position):journal.db.query(`SELECT a.sequence FROM archive_entries a JOIN ${table.name} t ON ${match(table)} WHERE a.table_code=? AND a.sequence${comparison}? AND a.sequence<=? ORDER BY a.sequence LIMIT 1`).get(table.code,cursor.position,descriptor.payload.cutoff);
    if(exists)break;
    if(cursor.offset)throw new Error("ARCHIVE_FRAGMENT_RECORD_MISSING");cursor={table:cursor.table+1,position:0,offset:0};
  }
  return cursor;
}
function generate(journal:Journal,descriptor:ArchiveDescriptor,index:number,previousHash:string|null,start:ArchiveCursor):{block:ArchiveBlock|null;bytes:number;counts:number[]} {
  let cursor={...start},bytes=0,envelopeBytes=4096;const fragments:ArchiveBlock["fragments"]=[],counts=ARCHIVE_TABLES.map(()=>0);
  while(bytes<ARCHIVE_LIMITS.blockBytes&&fragments.length<ARCHIVE_LIMITS.maxFragments) {
    cursor=normalize(journal,descriptor,cursor);if(cursor.table===ARCHIVE_TABLES.length)break;
    const row=nextRecord(journal,descriptor,cursor)!;
    const encoded=encodeArchiveRecord(cursor.table,row),position=row.archive_position as number;
    if(cursor.offset>=encoded.byteLength)throw new Error("ARCHIVE_FRAGMENT_OFFSET_INVALID");
    const values=ARCHIVE_TABLES[cursor.table]!.columns.map(column=>row[column]);
    // Derive the key from validated, canonically encoded values (BLOB keys do not exist).
    const key=archiveRecordKey(cursor.table,values as never);
    const header={table:cursor.table,key,position,offset:cursor.offset,totalLength:encoded.byteLength,data:""};
    const headerBytes=Buffer.byteLength(canonical(header))+1;
    const available=Math.max(0,Math.floor((ARCHIVE_LIMITS.transportBytes-envelopeBytes-headerBytes-4)/4)*3);
    const size=Math.min(encoded.byteLength-cursor.offset,ARCHIVE_LIMITS.blockBytes-bytes,available);
    if(size===0)break;
    const fragment={...header,data:Buffer.from(encoded.subarray(cursor.offset,cursor.offset+size)).toString("base64")};
    fragments.push(fragment);bytes+=size;envelopeBytes+=Buffer.byteLength(canonical(fragment))+1;
    const complete=cursor.offset+size===encoded.byteLength;
    if(complete)counts[cursor.table]=counts[cursor.table]!+1;
    cursor={table:cursor.table,position,offset:complete?0:cursor.offset+size};
    if(!complete)break;
  }
  cursor=normalize(journal,descriptor,cursor);
  if(!fragments.length) {if(cursor.table!==ARCHIVE_TABLES.length)throw new Error("ARCHIVE_BLOCK_CANNOT_PROGRESS");return {block:null,bytes:0,counts};}
  const unsigned={checkpointId:descriptor.payload.checkpointId,descriptorHash:archiveDescriptorHash(descriptor),index,previousHash,start,end:cursor,fragments};
  const block={...unsigned,hash:archiveBlockHash(unsigned)};parseArchiveBlock(block,descriptor,{index,previousHash,cursor:start});return {block,bytes,counts};
}
/** Retry metadata and advancement commit atomically; no in-memory state survives between calls. */
export function readCheckpointBlock(journal:Journal,identity:NodeIdentity,source:CheckpointSource,id:string,index:number,now=Date.now()):ArchiveBlock|null {
  if(!Number.isSafeInteger(index)||index<0)throw new Error("ARCHIVE_BLOCK_INDEX_INVALID");
  return journal.db.transaction(()=>{
    const {row,descriptor}=load(journal,identity,source,id,now);
    if(index>row.next_block)throw new Error("ARCHIVE_BLOCK_ORDER_MISMATCH");
    const saved=journal.db.query("SELECT * FROM archive_blocks WHERE checkpoint_id=? AND block_number=?").get(id,index) as BlockRow|null;
    if(index<row.next_block) {
      if(!saved)throw new Error("ARCHIVE_BLOCK_METADATA_MISSING");
      const result=generate(journal,descriptor,index,saved.previous_hash,archiveCursorSchema.parse(JSON.parse(saved.start_cursor)));
      if(!result.block||result.block.hash!==saved.hash||canonical(result.block.end)!==saved.end_cursor||result.bytes!==saved.bytes)throw new Error("ARCHIVE_IMMUTABLE_DATA_CHANGED");return result.block;
    }
    const start=archiveCursorSchema.parse(JSON.parse(row.cursor));
    if(start.table===ARCHIVE_TABLES.length)return null;
    if(row.state!=="ACTIVE"||saved)throw new Error("ARCHIVE_CHECKPOINT_STATE_INVALID");
    if(row.next_block>=CHECKPOINT_STAGING_LIMITS.blockCount||!Number.isSafeInteger(row.metadata_bytes)||row.metadata_bytes<0)throw new Error("ARCHIVE_CHECKPOINT_STAGING_CAPACITY");
    const result=generate(journal,descriptor,index,row.last_hash,start);
    if(!result.block)throw new Error("ARCHIVE_CHECKPOINT_EMPTY_PROGRESS");
    const counts=(JSON.parse(row.counts) as number[]).map((count,i)=>count+result.counts[i]!);
    if(counts.some((count,i)=>count>descriptor.payload.counts[i]!)||!Number.isSafeInteger(row.total_bytes+result.bytes))throw new Error("ARCHIVE_COUNT_MISMATCH");
    const startText=canonical(start),endText=canonical(result.block.end);
    // Serialized cell lengths plus a fixed per-row/index reserve. SQLite page/file
    // allocation is measured separately; this is the logical staging policy budget.
    const metadataBytes=row.metadata_bytes+Buffer.byteLength(canonical([id,index,startText,endText,result.bytes,row.last_hash,result.block.hash]))+256;
    if(metadataBytes>CHECKPOINT_STAGING_LIMITS.metadataBytes)throw new Error("ARCHIVE_CHECKPOINT_STAGING_CAPACITY");
    journal.db.query("INSERT INTO archive_blocks(checkpoint_id,block_number,start_cursor,end_cursor,bytes,previous_hash,hash) VALUES(?,?,?,?,?,?,?)").run(id,index,startText,endText,result.bytes,row.last_hash,result.block.hash);
    journal.db.query("UPDATE archive_checkpoints SET cursor=?,next_block=?,last_hash=?,total_bytes=?,counts=?,metadata_bytes=? WHERE id=?").run(endText,index+1,result.block.hash,row.total_bytes+result.bytes,canonical(counts),metadataBytes,id);
    return result.block;
  })();
}
export function sealCheckpoint(journal:Journal,identity:NodeIdentity,source:CheckpointSource,id:string,now=Date.now()):ArchiveSeal {
  return journal.db.transaction(()=>{
    const {row,descriptor}=load(journal,identity,source,id,now);
    if(row.seal)return parseArchiveSeal(row.seal,descriptor);
    const cursor=archiveCursorSchema.parse(JSON.parse(row.cursor)),counts=JSON.parse(row.counts) as number[];
    if(cursor.table!==ARCHIVE_TABLES.length||cursor.position!==0||cursor.offset!==0||canonical(counts)!==canonical(descriptor.payload.counts)||count(journal,"SELECT COUNT(*) AS count FROM archive_blocks WHERE checkpoint_id=?",id)!==row.next_block)throw new Error("ARCHIVE_CHECKPOINT_INCOMPLETE");
    const seal=signArchiveSeal({format:"SBX_CHECKPOINT_SEAL_V2",checkpointId:id,descriptorHash:archiveDescriptorHash(descriptor),blockCount:row.next_block,totalBytes:row.total_bytes,counts,finalHash:row.last_hash},descriptor,identity);
    journal.db.query("UPDATE archive_checkpoints SET state='SEALED',seal=? WHERE id=?").run(canonical(seal),id);return seal;
  })();
}
