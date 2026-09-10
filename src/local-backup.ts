/** Local V2 export. The running journal is opened read-only; only a private SQLite copy is changed. */
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { ARCHIVE_LIMITS } from "./archive-protocol";
import { beginCheckpoint, initializeCheckpointStorage, readCheckpointBlock, sealCheckpoint } from "./checkpoint";
import { ChunkedJournal } from "./chunked-journal";
import { parseConfig } from "./config";
import { canonical, hash, nodeIdFor } from "./crypto";
import { HOSTED_TABLES } from "./hosted-export";
import type { SqlDriver } from "./journal";
import { archiveLocalRecoveryMetadata } from "./local-backup-metadata";
import { archivePythRuntimeState, PYTH_RUNTIME_TABLES, validatePythRuntimeSchema } from "./pyth/recovery-state";
import { backupStreamFrames, inspectStreamBackup, verifyStreamDatabase, STREAM_RECOVERY_LIMITS, type StreamRecoveryOptions } from "./stream-recovery";
import type { NodeIdentity } from "./types";
import { parseMethodology, parseRegistry } from "./validation";

export interface LocalStreamBackupOptions extends StreamRecoveryOptions {operatorGroup:string}
function fail(code:string):never {throw new Error(`LOCAL_BACKUP_${code}`);}
function newPath(path:string):void {
  try{lstatSync(path);fail("NEW_OUTPUT_REQUIRED");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
}
/** Bound the allocation even if a file grows while it is being read. */
function regularBytes(path:string,maximum:number,privateFile=false):Buffer {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=fstatSync(fd);
    if(!before.isFile()||before.size<1||before.size>maximum)fail("BOUNDED_REGULAR_FILE_REQUIRED");
    if(privateFile&&(before.mode&0o077)!==0)fail("PRIVATE_FILE_PERMISSIONS");
    const bytes=Buffer.allocUnsafe(before.size+1);let used=0;
    while(used<bytes.length){const count=readSync(fd,bytes,used,bytes.length-used,null);if(!count)break;used+=count;}
    const after=fstatSync(fd);
    if(used!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail("FILE_CHANGED");
    return bytes.subarray(0,used);
  }finally{closeSync(fd);}
}
function json(path:string,privateFile=false):unknown {return JSON.parse(regularBytes(path,1024*1024,privateFile).toString("utf8"));}
function settings(root:string,configPath:string) {
  const config=parseConfig(json(configPath));
  const identity=json(resolve(root,config.identityPath),true) as NodeIdentity;
  if(!identity||typeof identity.privateKeyPem!=="string"||identity.privateKeyPem.length>4096||nodeIdFor(identity.publicKey)!==identity.nodeId)fail("IDENTITY_INVALID");
  const registry=parseRegistry(json(resolve(root,config.registryPath))),methodology=parseMethodology(json(resolve(root,config.methodologyPath)));
  if(config.network!==registry.network)fail("NETWORK_MISMATCH");
  return {config,identity,registry,methodology};
}
function disk(path:string,additionalBytes:number,options:LocalStreamBackupOptions):void {
  const reserve=options.minFreeDiskBytes??STREAM_RECOVERY_LIMITS.minFreeDiskBytes;
  if(!Number.isSafeInteger(reserve)||reserve<0)fail("INVALID_LIMIT");
  const stat=statfsSync(path,{bigint:true});
  if(stat.bavail*stat.bsize<BigInt(additionalBytes)+BigInt(reserve))fail("DISK_RESERVE");
}
function databaseBytes(database:Database,options:LocalStreamBackupOptions):number {
  const maximum=options.maxDatabaseBytes??STREAM_RECOVERY_LIMITS.maxDatabaseBytes;
  if(!Number.isSafeInteger(maximum)||maximum<1)fail("INVALID_LIMIT");
  const pages=(database.query("PRAGMA page_count").get() as {page_count:number}).page_count;
  const size=(database.query("PRAGMA page_size").get() as {page_size:number}).page_size;
  const bytes=pages*size;if(!Number.isSafeInteger(bytes)||bytes>maximum)fail("DATABASE_BUDGET_EXCEEDED");return bytes;
}
/** Never execute source-supplied views/triggers or silently omit additional tables. */
function schema(database:Database):void {
  const names=new Set<string>([...HOSTED_TABLES.map(table=>table.name),...PYTH_RUNTIME_TABLES,"local_journal_storage","archive_recovery_provenance","sqlite_sequence"]);
  const rows=database.query("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','view','trigger') LIMIT 64").all() as {type:string;name:string;sql:string|null}[];
  if(rows.length>=64||rows.some(row=>row.type!=="table"||!names.has(row.name)||/\bVIRTUAL\b/i.test(row.sql??"")))fail("SCHEMA_REVIEW_REQUIRED");
  validatePythRuntimeSchema(database as unknown as SqlDriver);
  for(const table of HOSTED_TABLES) {
    if(!rows.some(row=>row.name===table.name))fail("CHUNKED_JOURNAL_REQUIRED");
    const columns=database.query(`PRAGMA table_xinfo(${table.name})`).all() as {name:string;hidden:number}[];
    if(columns.some(column=>column.hidden!==0)||canonical(columns.map(column=>column.name))!==canonical(table.columns))fail("SCHEMA_REVIEW_REQUIRED");
  }
  if(!rows.some(row=>row.name==="local_journal_storage")||!rows.some(row=>row.name==="archive_recovery_provenance"))fail("CHUNKED_RECOVERY_METADATA_REQUIRED");
}

/**
 * The release is an explicit operator assertion of the local build, not a hosted-deployment attestation.
 * Files are compared before/after the transaction-consistent SQLite copy and after export; this is not
 * a filesystem-wide atomic snapshot. Stop configuration changes while backing up. Normal collection
 * may continue. No signer counter is allocated and no source database migration is performed.
 */
export async function backupLocalStreamNode(root:string,configPath:string,outputPath:string,keyPath:string,options:LocalStreamBackupOptions) {
  options.signal?.throwIfAborted();
  if(!/^[a-f0-9]{64}$/.test(options.expectedNodeId)||!/^[a-f0-9]{40}$/.test(options.expectedRelease)||!options.operatorGroup||options.operatorGroup.length>128)fail("SOURCE_PIN_REQUIRED");
  newPath(outputPath);newPath(`${outputPath}.partial`);
  const encoded=regularBytes(keyPath,100,true).toString("utf8").trim(),key=Buffer.from(encoded,"base64");
  try{if(key.length!==32||key.toString("base64")!==encoded)fail("KEY_ENCODING");}finally{key.fill(0);}
  const initial=settings(root,configPath),settingsHash=hash(initial);
  if(initial.identity.nodeId!==options.expectedNodeId)fail("SOURCE_IDENTITY_MISMATCH");
  const sourcePath=resolve(root,initial.config.databasePath),sourceStat=lstatSync(sourcePath);
  if(!sourceStat.isFile()||sourceStat.isSymbolicLink())fail("REGULAR_DATABASE_REQUIRED");
  const unchangedSourceFile=()=>{
    const current=lstatSync(sourcePath);
    if(current.dev!==sourceStat.dev||current.ino!==sourceStat.ino||!current.isFile()||current.isSymbolicLink())fail("SOURCE_DATABASE_REPLACED");
  };
  const directory=mkdtempSync(join(tmpdir(),"sbx-local-stream-"));chmodSync(directory,0o700);
  const path=join(directory,"journal.sqlite");let copy:Database|undefined;
  try {
    const source=new Database(sourcePath,{readonly:true,strict:true});
    try {
      unchangedSourceFile();
      source.exec("PRAGMA busy_timeout=5000; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE");
      schema(source);disk(directory,databaseBytes(source,options),options);
      // VACUUM INTO includes committed WAL pages and preserves a transaction-consistent cut.
      // Its synchronous SQLite operation is not interruptible by the JS AbortSignal.
      source.query("VACUUM INTO ?").run(path);
      unchangedSourceFile();
    }finally{source.close(true);}
    chmodSync(path,0o600);options.signal?.throwIfAborted();
    if(hash(settings(root,configPath))!==settingsHash)fail("CONFIGURATION_CHANGED");
    copy=new Database(path,{strict:true});
    copy.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE");
    databaseBytes(copy,options);disk(directory,0,options);schema(copy);
    const journal=new ChunkedJournal(copy as unknown as SqlDriver);
    const recoveryProvenanceHash=archiveLocalRecoveryMetadata(journal);
    const pythStateHash=archivePythRuntimeState(journal,Date.now());
    // Current files can legitimately differ from historical snapshot configurations after restore.
    // Archive both on the copy; do not rewrite historical configurations or the running source.
    journal.saveConfiguration(initial.registry);journal.saveConfiguration(initial.methodology);
    initializeCheckpointStorage(journal);
    databaseBytes(copy,options);disk(directory,0,options);
    const metadata={nodeName:"local" as const,operatorGroup:options.operatorGroup,release:options.expectedRelease,
      network:initial.config.network,intervalMs:initial.config.intervalMs,registry:initial.registry,methodology:initial.methodology,
      ...(recoveryProvenanceHash?{recoveryProvenanceHash}:{}),...(pythStateHash?{pythStateHash}:{})};
    const descriptor=beginCheckpoint(journal,initial.identity,metadata,{ttlMs:ARCHIVE_LIMITS.maxTtlMs});
    databaseBytes(copy,options);disk(directory,0,options);
    // Reject corrupt retained content before creating the ciphertext. The independent
    // readback below still verifies the actual encrypted output, not just this copy.
    await verifyStreamDatabase(journal,descriptor,options);
    async function* frames():AsyncGenerator<Uint8Array> {
      yield Buffer.from(canonical(descriptor));
      for(let index=0;;index++) {
        await setImmediate();options.signal?.throwIfAborted();
        const block=readCheckpointBlock(journal,initial.identity,metadata,descriptor.payload.checkpointId,index);
        if(!block)break;
        databaseBytes(copy!,options);disk(directory,0,options);
        yield Buffer.from(canonical(block));
      }
      yield Buffer.from(canonical(sealCheckpoint(journal,initial.identity,metadata,descriptor.payload.checkpointId)));
    }
    await backupStreamFrames(frames(),outputPath,keyPath,options);
    // A promoted ciphertext is not a successful backup until this independent full import verifies.
    // Release the connection and all owned statements before the independent
    // import opens another database; do not defer native cleanup until GC.
    copy.close(true);copy=undefined;
    const inspection=await inspectStreamBackup(outputPath,keyPath,options);
    unchangedSourceFile();
    if(hash(settings(root,configPath))!==settingsHash)fail("CONFIGURATION_CHANGED");
    return {...inspection,file:outputPath,sourceName:"local",sourceBuildVerification:"OPERATOR_ASSERTED",
      contentInspection:"VERIFIED",privateKeysIncluded:false,providerCredentialsIncluded:false};
  }finally {
    try{copy?.close(true);}finally{
      // Exact directory created by this operation, never a user-supplied root or destination.
      rmSync(directory,{recursive:true,force:true});
    }
  }
}
