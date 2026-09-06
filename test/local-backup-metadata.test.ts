// Isolated synthetic recovery receipts. These are not production market data.
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ARCHIVE_FORMAT, ARCHIVE_TABLES, parseArchiveDescriptor, signArchiveDescriptor, signArchiveSeal, type ArchiveDescriptor } from "../src/archive-protocol";
import { beginCheckpoint, initializeCheckpointStorage } from "../src/checkpoint";
import { CHUNKED_JOURNAL_VERSION, ChunkedJournal } from "../src/chunked-journal";
import { canonical, generateIdentity, hash } from "../src/crypto";
import { archiveLocalRecoveryMetadata, parseRecoveryProvenance, RECOVERY_PROVENANCE_FORMAT, RECOVERY_PROVENANCE_LIMITS, verifyRecoveryProvenance, type RecoveryProvenanceRecord } from "../src/local-backup-metadata";
import { Store } from "../src/store";
import { environment, NOW } from "./helpers";

const RELEASE="ab".repeat(20),signer=generateIdentity();
const stores:Store[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});
function store():Store {const result=new Store(":memory:");stores.push(result);return result;}
function descriptor(parent?:string,createdAt=NOW,nodeName:"primary"|"secondary"|"local"="primary"):ArchiveDescriptor {
  return signArchiveDescriptor({format:ARCHIVE_FORMAT,checkpointId:randomUUID(),createdAt,expiresAt:createdAt+60000,
    source:{nodeId:signer.nodeId,publicKey:signer.publicKey,nodeName,operatorGroup:"isolated-metadata-test",release:RELEASE},
    configuration:{network:"sbx-test",intervalMs:300000,registryHash:"a".repeat(64),methodologyHash:"b".repeat(64)},
    cutoff:0,counts:ARCHIVE_TABLES.map(()=>0),snapshotHead:null,...(parent===undefined?{}:{recoveryProvenanceHash:parent})},signer);
}
function receipt(source=descriptor(),archiveBytes=1000):RecoveryProvenanceRecord {
  return {format:RECOVERY_PROVENANCE_FORMAT,descriptor:source,
    seal:signArchiveSeal({format:"SBX_CHECKPOINT_SEAL_V2",checkpointId:source.payload.checkpointId,
      descriptorHash:hash({domain:"SBX_ARCHIVE_DESCRIPTOR_HASH_V2",payload:source.payload}),blockCount:0,totalBytes:0,counts:source.payload.counts,finalHash:null},source,signer),
    archiveSha256:"c".repeat(64),archiveBytes};
}
function metadata(journal:Store,value=receipt(),check=true):void {
  journal.db.exec(`CREATE TABLE local_journal_storage (id INTEGER PRIMARY KEY${check?" CHECK(id=1)":""},version TEXT NOT NULL);
    CREATE TABLE archive_recovery_provenance (id INTEGER PRIMARY KEY${check?" CHECK(id=1)":""},descriptor TEXT NOT NULL,seal TEXT NOT NULL,archive_sha256 TEXT NOT NULL,archive_bytes INTEGER NOT NULL)`);
  journal.db.query("INSERT INTO local_journal_storage VALUES(1,?)").run(CHUNKED_JOURNAL_VERSION);
  journal.db.query("INSERT INTO archive_recovery_provenance VALUES(1,?,?,?,?)").run(canonical(value.descriptor),canonical(value.seal),value.archiveSha256,value.archiveBytes);
}
function localTables(journal:Store):number {return (journal.db.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('local_journal_storage','archive_recovery_provenance')").get() as {count:number}).count;}

test("local descriptors and optional receipt hashes preserve old hosted V2 compatibility",()=>{
  const hosted=descriptor();
  expect(parseArchiveDescriptor(canonical(hosted),signer.nodeId,RELEASE)).toEqual(hosted);
  expect(canonical(hosted)).not.toContain("recoveryProvenanceHash");
  const local=descriptor("d".repeat(64),NOW,"local");
  expect(parseArchiveDescriptor(canonical(local),signer.nodeId,RELEASE)).toEqual(local);
  expect(()=>parseArchiveDescriptor({...local,payload:{...local.payload,recoveryProvenanceHash:"invalid"}},signer.nodeId,RELEASE)).toThrow();
  expect(()=>parseArchiveDescriptor({...local,payload:{...local.payload,recoveryProvenanceHash:"e".repeat(64)}},signer.nodeId,RELEASE)).toThrow("ARCHIVE_SIGNATURE_INVALID");
});

test("checkpoint signs local receipt reference only when the configuration is registered",()=>{
  const s=store(),journal=new ChunkedJournal(s.db),e=environment(),value=receipt(),parent=journal.saveConfiguration(value);
  journal.saveConfiguration(e.registry);journal.saveConfiguration(e.methodology);initializeCheckpointStorage(journal);
  const source={nodeName:"local" as const,operatorGroup:"isolated-metadata-test",release:RELEASE,
    network:e.registry.network,intervalMs:300000,registry:e.registry,methodology:e.methodology};
  expect(()=>beginCheckpoint(journal,signer,{...source,recoveryProvenanceHash:"f".repeat(64)},{now:NOW+1})).toThrow("ARCHIVE_CONFIGURATION_MISSING");
  const valueDescriptor=beginCheckpoint(journal,signer,{...source,recoveryProvenanceHash:parent},{now:NOW+1});
  expect(valueDescriptor.payload.source.nodeName).toBe("local");
  expect(valueDescriptor.payload.recoveryProvenanceHash).toBe(parent);
  expect(verifyRecoveryProvenance(journal,valueDescriptor)).toEqual({records:1,linkedRecords:1,ciphertextVerification:"NOT_PERFORMED"});
});

test("copy-only migration preserves the exact prior receipt as a hashed configuration",()=>{
  const s=store(),value=receipt();metadata(s,value);
  const reference=archiveLocalRecoveryMetadata(s);
  expect(reference).toBe(hash(value));expect(s.configuration(reference!)).toEqual(value);expect(localTables(s)).toBe(0);
  expect(verifyRecoveryProvenance(s,descriptor(reference,NOW+1,"local"))).toEqual({records:1,linkedRecords:1,ciphertextVerification:"NOT_PERFORMED"});
  expect(archiveLocalRecoveryMetadata(s)).toBeUndefined();
  expect(canonical(value)).not.toContain("PRIVATE KEY");
});

test("successive receipts retain bounded hash links rather than nesting old archives",()=>{
  const s=store(),first=receipt();metadata(s,first);const firstHash=archiveLocalRecoveryMetadata(s)!;
  const second=receipt(descriptor(firstHash,NOW+1,"local"));metadata(s,second);const secondHash=archiveLocalRecoveryMetadata(s)!;
  expect(s.configuration(firstHash)).toEqual(first);expect(s.configuration(secondHash)).toEqual(second);
  expect(verifyRecoveryProvenance(s,descriptor(secondHash,NOW+2,"local"))).toEqual({records:2,linkedRecords:2,ciphertextVerification:"NOT_PERFORMED"});
  expect(Buffer.byteLength(canonical(second))-Buffer.byteLength(canonical(first))).toBeLessThan(150);
});

test("missing paired metadata, unsupported storage version, and extra singleton rows fail without dropping tables",()=>{
  const s=store();s.db.exec("CREATE TABLE local_journal_storage (id INTEGER PRIMARY KEY,version TEXT NOT NULL)");
  expect(()=>archiveLocalRecoveryMetadata(s)).toThrow("TABLE_PAIR_REQUIRED");expect(localTables(s)).toBe(1);
  const version=store();metadata(version);version.db.query("UPDATE local_journal_storage SET version=?").run("unsupported");
  expect(()=>archiveLocalRecoveryMetadata(version)).toThrow("STORAGE_VERSION_INVALID");expect(localTables(version)).toBe(2);
  const duplicate=store();metadata(duplicate,receipt(),false);duplicate.db.query("INSERT INTO local_journal_storage VALUES(2,?)").run(CHUNKED_JOURNAL_VERSION);
  expect(()=>archiveLocalRecoveryMetadata(duplicate)).toThrow("SINGLETON_REQUIRED");expect(localTables(duplicate)).toBe(2);
});

test("changed local schemas including hidden columns are not silently discarded",()=>{
  for(const change of ["ALTER TABLE local_journal_storage ADD COLUMN extra TEXT","ALTER TABLE local_journal_storage ADD COLUMN extra TEXT GENERATED ALWAYS AS (version) VIRTUAL"]) {
    const s=store();metadata(s);s.db.exec(change);
    expect(()=>archiveLocalRecoveryMetadata(s)).toThrow("SCHEMA_REVIEW_REQUIRED");expect(localTables(s)).toBe(2);
  }
});

test("metadata text is bounded before payload selection and bad routing is rejected",()=>{
  const s=store();metadata(s);s.db.query("UPDATE archive_recovery_provenance SET descriptor=?").run("x".repeat(16*1024+1));
  expect(()=>archiveLocalRecoveryMetadata(s)).toThrow("RECORD_TOO_LARGE");expect(localTables(s)).toBe(2);
  const badId=store();metadata(badId,receipt(),false);badId.db.exec("UPDATE archive_recovery_provenance SET id=2");
  expect(()=>archiveLocalRecoveryMetadata(badId)).toThrow();expect(localTables(badId)).toBe(2);
});

test("prior signatures, seal binding, digest encoding, and byte accounting are checked",()=>{
  const value=receipt();
  expect(()=>parseRecoveryProvenance({...value,descriptor:{...value.descriptor,signature:"A".repeat(88)}})).toThrow("ARCHIVE_SIGNATURE_INVALID");
  expect(()=>parseRecoveryProvenance({...value,seal:receipt().seal})).toThrow("ARCHIVE_SEAL_MISMATCH");
  expect(()=>parseRecoveryProvenance({...value,archiveSha256:"C".repeat(64)})).toThrow("RECORD_INVALID");
  expect(()=>parseRecoveryProvenance({...value,archiveBytes:-1})).toThrow("RECORD_INVALID");
  expect(()=>parseRecoveryProvenance({...value,extra:"not permitted"})).toThrow("RECORD_INVALID");
});

test("receipt failures roll back new configuration insertion and preserve original metadata",()=>{
  const s=store(),value=receipt(descriptor("f".repeat(64)));metadata(s,value);
  expect(()=>archiveLocalRecoveryMetadata(s)).toThrow("CHAIN_LINK_MISSING");
  expect(localTables(s)).toBe(2);expect(s.configuration(hash(value))).toBeNull();
});

test("missing root links, unrelated malformed receipts, and tampered configuration hashes fail",()=>{
  const s=store();expect(()=>verifyRecoveryProvenance(s,descriptor("f".repeat(64)))).toThrow("CHAIN_LINK_MISSING");
  s.saveConfiguration({format:RECOVERY_PROVENANCE_FORMAT,notAReceipt:true});
  expect(()=>verifyRecoveryProvenance(s,descriptor())).toThrow("RECORD_INVALID");
  const corrupt=store(),key=corrupt.saveConfiguration(receipt());corrupt.db.query("UPDATE configurations SET payload=? WHERE hash=?").run(canonical({format:RECOVERY_PROVENANCE_FORMAT}),key);
  expect(()=>verifyRecoveryProvenance(corrupt,descriptor())).toThrow("CONFIGURATION_HASH_MISMATCH");
});

test("all ancestral edges must resolve to receipts and remain chronological",()=>{
  const s=store(),ordinary=s.saveConfiguration({ordinary:"configuration"});
  s.saveConfiguration(receipt(descriptor(ordinary)));
  expect(()=>verifyRecoveryProvenance(s,descriptor())).toThrow("CHAIN_LINK_MISSING");
  const time=store(),later=time.saveConfiguration(receipt(descriptor(undefined,NOW+1)));
  time.saveConfiguration(receipt(descriptor(later,NOW)));
  expect(()=>verifyRecoveryProvenance(time,descriptor(undefined,NOW+2))).toThrow("CHAIN_CLOCK");
  expect(()=>verifyRecoveryProvenance(time,descriptor())).toThrow("RECEIPT_CLOCK");
});

test("a linked receipt chain has an explicit depth limit",()=>{
  const s=store();let parent:string|undefined;
  for(let index=0;index<RECOVERY_PROVENANCE_LIMITS.chainDepth;index++)parent=s.saveConfiguration(receipt(descriptor(parent,NOW+index)));
  expect(verifyRecoveryProvenance(s,descriptor(parent,NOW+1000)).linkedRecords).toBe(RECOVERY_PROVENANCE_LIMITS.chainDepth);
  parent=s.saveConfiguration(receipt(descriptor(parent,NOW+1000)));
  expect(()=>verifyRecoveryProvenance(s,descriptor(parent,NOW+1001))).toThrow("CHAIN_CAPACITY");
});

test("unlinked receipts also have a total retained-record limit",()=>{
  const s=store(),value=receipt();
  for(let index=0;index<=RECOVERY_PROVENANCE_LIMITS.records;index++)s.saveConfiguration({...value,archiveBytes:index+1});
  expect(()=>verifyRecoveryProvenance(s,descriptor())).toThrow("RECORD_CAPACITY");
});

test("oversized ordinary configurations are rejected without loading their payload",()=>{
  const s=store();s.db.query("INSERT INTO configurations VALUES(?,?)").run("a".repeat(64),"x".repeat(RECOVERY_PROVENANCE_LIMITS.configurationBytes+1));
  expect(()=>verifyRecoveryProvenance(s,descriptor())).toThrow("CONFIGURATION_TOO_LARGE");
});
