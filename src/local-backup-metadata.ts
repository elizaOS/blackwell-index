/** Local-copy-only recovery metadata handling. Never invoke migration on a live source. */
import { z } from "zod";
import { ARCHIVE_LIMITS, parseArchiveDescriptor, parseArchiveSeal, type ArchiveDescriptor, type ArchiveSeal } from "./archive-protocol";
import { CHUNKED_JOURNAL_VERSION } from "./chunked-journal";
import { canonical, hash } from "./crypto";
import type { Journal } from "./journal";

export const RECOVERY_PROVENANCE_FORMAT="SBX_RECOVERY_PROVENANCE_V1";
export const RECOVERY_PROVENANCE_LIMITS=Object.freeze({records:1024,chainDepth:256,recordBytes:48*1024,configurationBytes:1_000_000});
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema=z.object({format:z.literal(RECOVERY_PROVENANCE_FORMAT),descriptor:z.unknown(),seal:z.unknown(),
  archiveSha256:digest,archiveBytes:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
export interface RecoveryProvenanceRecord {
  format:typeof RECOVERY_PROVENANCE_FORMAT;
  descriptor:ArchiveDescriptor;
  seal:ArchiveSeal;
  archiveSha256:string;
  archiveBytes:number;
}
export interface RecoveryProvenanceSummary {
  records:number;
  linkedRecords:number;
  ciphertextVerification:"NOT_PERFORMED";
}

function fail(code:string):never {throw new Error(`LOCAL_RECOVERY_METADATA_${code}`);}
function parseJson(text:string,maximum:number):unknown {
  if(Buffer.byteLength(text)>maximum)fail("RECORD_TOO_LARGE");
  try{return JSON.parse(text) as unknown;}catch{fail("INVALID_JSON");}
}
/** A valid receipt authenticates the prior signer's claims, not unavailable ciphertext. */
export function parseRecoveryProvenance(value:unknown):RecoveryProvenanceRecord {
  if(Buffer.byteLength(canonical(value))>RECOVERY_PROVENANCE_LIMITS.recordBytes)fail("RECORD_TOO_LARGE");
  const result=recordSchema.safeParse(value);if(!result.success)fail("RECORD_INVALID");
  const raw=result.data.descriptor as Partial<ArchiveDescriptor>|null;
  const source=raw?.payload?.source;
  if(!source||!digest.safeParse(source.nodeId).success||typeof source.release!=="string")fail("RECORD_INVALID");
  const descriptor=parseArchiveDescriptor(result.data.descriptor,source.nodeId,source.release);
  const seal=parseArchiveSeal(result.data.seal,descriptor);
  return {...result.data,descriptor,seal};
}
/**
 * Verify every retained receipt, not only the current root. Payloads are fetched
 * one at a time after an SQL byte check; only bounded link metadata is retained.
 * Every parent edge must resolve to a verified receipt and move backward in time.
 */
export function verifyRecoveryProvenance(journal:Journal,descriptor:ArchiveDescriptor):RecoveryProvenanceSummary {
  const links=new Map<string,{parent:string|undefined;createdAt:number}>();
  const payloadQuery=journal.db.query("SELECT payload FROM configurations WHERE hash=?");
  for(const row of journal.db.query("SELECT hash,length(CAST(payload AS BLOB)) AS bytes FROM configurations ORDER BY hash").iterate() as Iterable<{hash:string;bytes:number}>) {
    if(!Number.isSafeInteger(row.bytes)||row.bytes<1||row.bytes>RECOVERY_PROVENANCE_LIMITS.configurationBytes)fail("CONFIGURATION_TOO_LARGE");
    const payload=(payloadQuery.get(row.hash) as {payload:string}|null)?.payload;
    if(typeof payload!=="string")fail("CONFIGURATION_MISSING");
    const value=parseJson(payload,RECOVERY_PROVENANCE_LIMITS.configurationBytes);
    if(hash(value)!==row.hash)fail("CONFIGURATION_HASH_MISMATCH");
    if(!value||typeof value!=="object"||(value as {format?:unknown}).format!==RECOVERY_PROVENANCE_FORMAT)continue;
    if(links.size>=RECOVERY_PROVENANCE_LIMITS.records)fail("RECORD_CAPACITY");
    const record=parseRecoveryProvenance(value);
    if(record.descriptor.payload.createdAt>descriptor.payload.createdAt)fail("RECEIPT_CLOCK");
    links.set(row.hash,{parent:record.descriptor.payload.recoveryProvenanceHash,createdAt:record.descriptor.payload.createdAt});
  }
  const depth=(root:string):number=>{
    let cursor:string|undefined=root,previousTime=descriptor.payload.createdAt,total=0;
    const seen=new Set<string>();
    while(cursor!==undefined) {
      if(seen.has(cursor))fail("CHAIN_CYCLE");
      if(++total>RECOVERY_PROVENANCE_LIMITS.chainDepth)fail("CHAIN_CAPACITY");
      seen.add(cursor);
      const entry=links.get(cursor);if(!entry)fail("CHAIN_LINK_MISSING");
      if(entry.createdAt>previousTime)fail("CHAIN_CLOCK");
      previousTime=entry.createdAt;cursor=entry.parent;
    }
    return total;
  };
  for(const key of links.keys())depth(key);
  const linkedRecords=descriptor.payload.recoveryProvenanceHash===undefined?0:depth(descriptor.payload.recoveryProvenanceHash);
  return {records:links.size,linkedRecords,ciphertextVerification:"NOT_PERFORMED"};
}

const columns:Record<string,readonly [string,string,number,number][]>={
  local_journal_storage:[["id","INTEGER",0,1],["version","TEXT",1,0]],
  archive_recovery_provenance:[["id","INTEGER",0,1],["descriptor","TEXT",1,0],["seal","TEXT",1,0],["archive_sha256","TEXT",1,0],["archive_bytes","INTEGER",1,0]],
};
function validateColumns(journal:Journal,name:keyof typeof columns):void {
  const actual=journal.db.query(`PRAGMA table_xinfo(${name})`).all() as {name:string;type:string;notnull:number;dflt_value:unknown;pk:number;hidden:number}[];
  const expected=columns[name]!;
  if(actual.length!==expected.length||actual.some((value,index)=>{
    const [column,type,notnull,pk]=expected[index]!;
    return value.name!==column||value.type.toUpperCase()!==type||value.notnull!==notnull||value.pk!==pk||value.dflt_value!==null||value.hidden!==0;
  }))fail("SCHEMA_REVIEW_REQUIRED");
}
/**
 * Validate and migrate only the two exact local recovery tables in a private
 * SQLite snapshot. The caller must separately reject unknown tables/views/
 * triggers before constructing or mutating the snapshot Journal.
 */
export function archiveLocalRecoveryMetadata(journal:Journal):string|undefined {
  return journal.db.transaction(()=>{
    const names=(journal.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('local_journal_storage','archive_recovery_provenance')").all() as {name:string}[]).map(row=>row.name);
    if(names.length===0)return undefined;
    if(names.length!==2)fail("TABLE_PAIR_REQUIRED");
    for(const name of Object.keys(columns)) {
      validateColumns(journal,name);
      const count=(journal.db.query(`SELECT COUNT(*) AS count FROM ${name}`).get() as {count:number}).count;
      if(count!==1)fail("SINGLETON_REQUIRED");
    }
    const size=journal.db.query("SELECT id,length(CAST(version AS BLOB)) AS bytes FROM local_journal_storage").get() as {id:number;bytes:number};
    if(size.id!==1||size.bytes>128)fail("STORAGE_VERSION_INVALID");
    const version=(journal.db.query("SELECT version FROM local_journal_storage WHERE id=1").get() as {version:string}).version;
    if(version!==CHUNKED_JOURNAL_VERSION)fail("STORAGE_VERSION_INVALID");
    const sizes=journal.db.query("SELECT id,length(CAST(descriptor AS BLOB)) AS descriptor_bytes,length(CAST(seal AS BLOB)) AS seal_bytes,length(CAST(archive_sha256 AS BLOB)) AS hash_bytes FROM archive_recovery_provenance").get() as {id:number;descriptor_bytes:number;seal_bytes:number;hash_bytes:number};
    if(sizes.id!==1||sizes.descriptor_bytes>ARCHIVE_LIMITS.descriptorBytes||sizes.seal_bytes>ARCHIVE_LIMITS.descriptorBytes||sizes.hash_bytes!==64)fail("RECORD_TOO_LARGE");
    const row=journal.db.query("SELECT descriptor,seal,archive_sha256,archive_bytes FROM archive_recovery_provenance WHERE id=1").get() as {descriptor:string;seal:string;archive_sha256:string;archive_bytes:number};
    const record=parseRecoveryProvenance({format:RECOVERY_PROVENANCE_FORMAT,
      descriptor:parseJson(row.descriptor,ARCHIVE_LIMITS.descriptorBytes),seal:parseJson(row.seal,ARCHIVE_LIMITS.descriptorBytes),archiveSha256:row.archive_sha256,archiveBytes:row.archive_bytes});
    // This also rejects missing/corrupt ancestral references before any metadata
    // is dropped. Recheck after insertion to enforce the total receipt budget.
    verifyRecoveryProvenance(journal,record.descriptor);
    const provenanceHash=journal.saveConfiguration(record);
    verifyRecoveryProvenance(journal,record.descriptor);
    journal.db.exec("DROP TABLE archive_recovery_provenance; DROP TABLE local_journal_storage");
    return provenanceHash;
  })();
}
