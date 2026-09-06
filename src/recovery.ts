/** Encrypted self-hosted node recovery. Restores never reuse an old signing identity. */
import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { parseConfig, type NodeConfig } from "./config";
import { canonical, generateIdentity, hash, nodeIdFor, verifyBatch } from "./crypto";
import { calculate } from "./engine";
import { Journal, validateEquivocationProof, type SqlDriver } from "./journal";
import { resetRecoveredPythLocks, verifyPythRuntimeState } from "./pyth/recovery-state";
import { parseMethodology, parseRegistry, signedBatchSchema } from "./validation";
import type { SignedBatch } from "./types";

const FORMAT = "SBX_NODE_RECOVERY_V1";
const AAD = Buffer.from(FORMAT);
const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const RECOVERY_MARKER = "data/RECOVERY_REVIEW_REQUIRED.json";
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const envelopeSchema = z.object({format:z.literal(FORMAT),nonce:z.string().max(32),tag:z.string().max(32),ciphertext:z.string().max(MAX_ARCHIVE_BYTES)}).strict();
const payloadSchema = z.object({format:z.literal(FORMAT),createdAt:z.number().int().positive(),source:z.object({nodeId:z.string(),publicKey:z.string()}).strict(),
  configuration:z.unknown(),registry:z.unknown(),methodology:z.unknown(),database:z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),body:z.string().max(90 * 1024 * 1024)}).strict()}).strict();
const recoveryDigest = z.string().regex(/^[a-f0-9]{64}$/);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// The full original object is compared with calculate(), so no snapshot field is ignored.
const snapshotReferences = z.object({schemaVersion:z.literal(1),calculatedAt:positiveInteger,registryHash:recoveryDigest,methodologyHash:recoveryDigest,
  inputBatchHashes:z.array(recoveryDigest),rejected:z.array(z.object({batchHash:recoveryDigest,reason:z.string()}).strict())}).passthrough();
const quarantineReference = z.object({sequence:positiveInteger,first:recoveryDigest,second:recoveryDigest}).strict();

function regularBytes(path:string, maximum:number, privateFile=false):Buffer {
  const stat=lstatSync(path);
  if(!stat.isFile() || stat.size>maximum)throw new Error("Recovery input must be a bounded regular file");
  if(privateFile && (stat.mode & 0o077)!==0)throw new Error("Recovery key must not be accessible to group or other users");
  return readFileSync(path);
}
function base64(value:string, exactLength?:number):Buffer {
  const bytes=Buffer.from(value,"base64");
  if(bytes.toString("base64")!==value || (exactLength!==undefined&&bytes.length!==exactLength))throw new Error("Invalid recovery encoding");
  return bytes;
}
function keyBytes(path:string):Buffer {return base64(regularBytes(path,100,true).toString("utf8").trim(),32);}
function newFile(path:string, contents:Uint8Array|string):void {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const fd=openSync(path,"wx",0o600);
  try {writeFileSync(fd,contents);fsyncSync(fd);} finally {closeSync(fd);}
}
function json(path:string):unknown {return JSON.parse(regularBytes(path,1024*1024).toString("utf8")) as unknown;}
function temporary<T>(operation:(path:string)=>T):T {
  const directory=mkdtempSync(join(tmpdir(),"sbx-recovery-"));chmodSync(directory,0o700);
  const path=join(directory,"journal.sqlite");
  try{return operation(path);}finally{
    // These exact files belong to the newly created private temporary directory.
    for(const file of [path,`${path}-wal`,`${path}-shm`])if(existsSync(file))unlinkSync(file);
    rmdirSync(directory);
  }
}
function verifyDatabase(path:string,sourceNodeId:string,cutoffMs=Date.now()) {
  const database=new Database(path,{readonly:true,strict:true});
  try {
    if((database.query("PRAGMA integrity_check").get() as {integrity_check:string}).integrity_check!=="ok")throw new Error("Recovery database integrity check failed");
    const pythRecovery=verifyPythRuntimeState(database as unknown as SqlDriver,cutoffMs);
    const journal=new Journal(database as unknown as SqlDriver);
    const history=journal.verifyHistory();
    if(!history.valid)throw new Error("Recovery snapshot history verification failed");
    for(const row of database.query("SELECT hash,body FROM evidence").iterate() as Iterable<{hash:string;body:Uint8Array}>) {
      if(digest(row.body)!==row.hash)throw new Error("Recovery evidence digest mismatch");
    }
    for(const row of database.query("SELECT hash,payload FROM configurations").iterate() as Iterable<{hash:string;payload:string}>) {
      if(hash(JSON.parse(row.payload))!==row.hash)throw new Error("Recovery configuration digest mismatch");
    }
    const highwater=new Map<string,number>();
    const remember=(report:SignedBatch)=>highwater.set(report.payload.nodeId,Math.max(highwater.get(report.payload.nodeId)??0,report.payload.sequence));
    for(const row of database.query("SELECT hash,node_id,sequence,received_at,payload,NULL AS payload_bytes FROM reports UNION ALL SELECT hash,node_id,sequence,received_at,payload,payload_bytes FROM candidates").iterate() as Iterable<{hash:string;node_id:string;sequence:number;received_at:number;payload:string;payload_bytes:number|null}>) {
      const report=signedBatchSchema.parse(JSON.parse(row.payload)) as SignedBatch;
      if(hash(report)!==row.hash || !verifyBatch(report))throw new Error("Recovery report verification failed");
      if(row.node_id!==report.payload.nodeId || row.sequence!==report.payload.sequence || !positiveInteger.safeParse(row.received_at).success)throw new Error("Recovery report routing mismatch");
      if(row.payload_bytes!==null && row.payload_bytes!==Buffer.byteLength(row.payload))throw new Error("Recovery candidate byte accounting mismatch");
      remember(report);
    }
    let verifiedProofs=0;
    const exclusions=new Map<string,{detectedAt:number;sequence:number;first:string;second:string}>();
    for(const row of database.query("SELECT node_id,detected_at,conflicting_payload FROM equivocations").iterate() as Iterable<{node_id:string;detected_at:number;conflicting_payload:string}>) {
      if(!recoveryDigest.safeParse(row.node_id).success || !positiveInteger.safeParse(row.detected_at).success)throw new Error("Recovery quarantine routing mismatch");
      const reference=quarantineReference.parse(JSON.parse(row.conflicting_payload));
      if(reference.first===reference.second)throw new Error("Recovery quarantine proof reference mismatch");
      exclusions.set(row.node_id,{detectedAt:row.detected_at,...reference});
    }
    for(const row of database.query("SELECT id,node_id,detected_at,first_payload,second_payload,payload_bytes FROM equivocation_proofs").iterate() as Iterable<{id:number;node_id:string;detected_at:number;first_payload:string;second_payload:string;payload_bytes:number}>) {
      const first=JSON.parse(row.first_payload) as SignedBatch,second=JSON.parse(row.second_payload) as SignedBatch;
      try {validateEquivocationProof({first,second});}catch {throw new Error("Recovery equivocation proof verification failed");}
      if(row.node_id!==first.payload.nodeId || !positiveInteger.safeParse(row.id).success || !positiveInteger.safeParse(row.detected_at).success || row.payload_bytes!==Buffer.byteLength(row.first_payload)+Buffer.byteLength(row.second_payload))throw new Error("Recovery equivocation proof routing mismatch");
      const exclusion=exclusions.get(row.node_id);
      if(!exclusion || exclusion.detectedAt>row.detected_at || exclusion.sequence!==first.payload.sequence || exclusion.first!==hash(first) || exclusion.second!==hash(second))throw new Error("Recovery equivocation quarantine linkage mismatch");
      exclusions.delete(row.node_id);verifiedProofs++;remember(first);remember(second);
    }
    // Capacity exhaustion deliberately retains exclusion before storing the full proof.
    // Preserve that fail-closed state, but explicitly report that its proof cannot be verified.
    const quarantinesWithoutProof=exclusions.size;
    const counters=new Set<string>();
    for(const row of database.query("SELECT id,value FROM counters").iterate() as Iterable<{id:string;value:number}>) {
      if(!recoveryDigest.safeParse(row.id).success || !positiveInteger.safeParse(row.value).success || row.value<(highwater.get(row.id)??0))throw new Error("Recovery signing counter highwater mismatch");
      counters.add(row.id);
    }
    // Peers do not have local signing counters. The source signer must have one
    // if any of its signed records survive; unused allocated sequence gaps are valid.
    if(highwater.has(sourceNodeId) && !counters.has(sourceNodeId))throw new Error("Recovery source signing counter missing");
    let reproducedSnapshots=0;
    for(const row of database.query("SELECT id,calculated_at,payload FROM snapshots ORDER BY id").iterate() as Iterable<{id:number;calculated_at:number;payload:string}>) {
      const original:unknown=JSON.parse(row.payload),references=snapshotReferences.parse(original);
      if(!positiveInteger.safeParse(row.id).success || row.calculated_at!==references.calculatedAt)throw new Error("Recovery snapshot routing mismatch");
      const registry=journal.configuration(references.registryHash),methodology=journal.configuration(references.methodologyHash);
      if(registry===null || methodology===null)throw new Error("Recovery snapshot configuration reference missing");
      const inputs=[...new Set([...references.inputBatchHashes,...references.rejected.map(item=>item.batchHash)])].map(digest=>{
        // Private candidates are never a substitute for a retained trusted-history input.
        const report=database.query("SELECT payload FROM reports WHERE hash=?").get(digest) as {payload:string}|null;
        if(!report)throw new Error("Recovery snapshot report reference missing");
        return JSON.parse(report.payload) as SignedBatch;
      });
      const reproduced=calculate(inputs,parseRegistry(registry),parseMethodology(methodology),references.calculatedAt);
      if(hash(reproduced)!==hash(original))throw new Error("Recovery snapshot calculation reproduction mismatch");
      reproducedSnapshots++;
    }
    return {history,counts:journal.counts(),coverage:journal.captureCounts(),reproducedSnapshots,pythRecovery,
      quarantineProofs:{verified:verifiedProofs,unavailable:quarantinesWithoutProof,requiresReview:quarantinesWithoutProof>0}};
  } finally {database.close();}
}

export function createRecoveryKey(path:string) {
  newFile(path,`${randomBytes(32).toString("base64")}\n`);
  return {keyFile:path,note:"Keep a separate protected copy. Losing this key makes encrypted recovery bundles unusable."};
}

export function backupNode(root:string,configPath:string,outputPath:string,keyPath:string) {
  if(existsSync(outputPath))throw new Error("Recovery output already exists");
  const key=keyBytes(keyPath),configuration=parseConfig(json(configPath));
  const registry=parseRegistry(json(resolve(root,configuration.registryPath))),methodology=parseMethodology(json(resolve(root,configuration.methodologyPath)));
  const identity=json(resolve(root,configuration.identityPath)) as {nodeId:string;publicKey:string};
  if(!identity || nodeIdFor(identity.publicKey)!==identity.nodeId || configuration.network!==registry.network)throw new Error("Recovery source configuration mismatch");
  return temporary(path=>{
    const source=new Database(resolve(root,configuration.databasePath),{readonly:true,strict:true});
    try {
      source.exec("PRAGMA busy_timeout=5000");
      if(source.query("SELECT name FROM sqlite_master WHERE type='table' AND name='local_journal_storage'").get())throw new Error("Chunked journals require the V2 streaming backup path: use backup-stream and independently inspect the result");
      const pages=(source.query("PRAGMA page_count").get() as {page_count:number}).page_count;
      const pageSize=(source.query("PRAGMA page_size").get() as {page_size:number}).page_size;
      if(pages*pageSize>MAX_DATABASE_BYTES)throw new Error("Recovery database exceeds the 64 MiB bundle limit; use a reviewed streaming backup procedure");
      // SQLite creates a transaction-consistent standalone copy, including committed WAL pages.
      source.query("VACUUM INTO ?").run(path);
    } finally {source.close();}
    chmodSync(path,0o600);
    const createdAt=Date.now(),verified=verifyDatabase(path,identity.nodeId,createdAt),database=regularBytes(path,MAX_DATABASE_BYTES);
    const payload={format:FORMAT,createdAt,source:{nodeId:identity.nodeId,publicKey:identity.publicKey},configuration,registry,methodology,
      database:{sha256:digest(database),body:database.toString("base64")}};
    const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,nonce);cipher.setAAD(AAD);
    const ciphertext=Buffer.concat([cipher.update(canonical(payload)),cipher.final()]);
    const envelope={format:FORMAT,nonce:nonce.toString("base64"),tag:cipher.getAuthTag().toString("base64"),ciphertext:ciphertext.toString("base64")};
    const encoded=JSON.stringify(envelope)+"\n";
    if(Buffer.byteLength(encoded)>MAX_ARCHIVE_BYTES)throw new Error("Recovery bundle exceeds size limit");
    newFile(outputPath,encoded);
    key.fill(0);
    return {file:outputPath,sourceNodeId:identity.nodeId,databaseBytes:database.length,createdAt:payload.createdAt,...verified,
      privateKeysIncluded:false,providerCredentialsIncluded:false,note:"Encrypted self-hosted journal recovery only. Restore generates a new identity and remains disabled pending review."};
  });
}

function decryptBackup(inputPath:string,keyPath:string) {
  const envelope=envelopeSchema.parse(JSON.parse(regularBytes(inputPath,MAX_ARCHIVE_BYTES).toString("utf8")));
  const key=keyBytes(keyPath);
  let plaintext:Buffer;
  try {
    const decipher=createDecipheriv("aes-256-gcm",key,base64(envelope.nonce,12));decipher.setAAD(AAD);decipher.setAuthTag(base64(envelope.tag,16));
    plaintext=Buffer.concat([decipher.update(base64(envelope.ciphertext)),decipher.final()]);
  } catch {throw new Error("Recovery authentication failed: wrong key or damaged bundle");}
  finally {key.fill(0);}
  const payload=payloadSchema.parse(JSON.parse(plaintext.toString("utf8")));
  if(nodeIdFor(payload.source.publicKey)!==payload.source.nodeId)throw new Error("Invalid recovery source identity");
  const configuration=parseConfig(payload.configuration),registry=parseRegistry(payload.registry),methodology=parseMethodology(payload.methodology);
  if(configuration.network!==registry.network)throw new Error("Recovery network mismatch");
  const database=base64(payload.database.body);
  if(database.length>MAX_DATABASE_BYTES || digest(database)!==payload.database.sha256)throw new Error("Recovery database digest mismatch");
  return {payload,configuration,registry,methodology,database};
}

export function inspectBackup(inputPath:string,keyPath:string) {
  const data=decryptBackup(inputPath,keyPath);
  return temporary(path=>{newFile(path,data.database);return {sourceNodeId:data.payload.source.nodeId,createdAt:data.payload.createdAt,databaseBytes:data.database.length,...verifyDatabase(path,data.payload.source.nodeId,data.payload.createdAt)};});
}

export function restoreNode(inputPath:string,keyPath:string,destination:string) {
  if(existsSync(destination))throw new Error("Recovery requires a new destination directory; existing data will not be overwritten");
  const data=decryptBackup(inputPath,keyPath);
  const {verified,restoredDatabase}=temporary(path=>{
    newFile(path,data.database);
    const verified=verifyDatabase(path,data.payload.source.nodeId,data.payload.createdAt);
    if(verified.pythRecovery.present) {
      // A recovered process cannot inherit an earlier process's lease. Preserve the
      // publisher's attempted/queued high-water marks and receipt bytes unchanged.
      const database=new Database(path,{strict:true});
      try {resetRecoveredPythLocks(database as unknown as SqlDriver);} finally {database.close();}
    }
    return {verified,restoredDatabase:regularBytes(path,MAX_DATABASE_BYTES)};
  });
  const identity=generateIdentity();
  const configuration:NodeConfig={schemaVersion:1,network:data.configuration.network,identityPath:"data/node-identity.json",databasePath:"data/node.sqlite",
    registryPath:"config/registry.local.json",methodologyPath:"config/methodology.local.json",host:"127.0.0.1",port:data.configuration.port,intervalMs:data.configuration.intervalMs,
    collectors:[],peers:[],allowLoopbackPeers:false};
  const registry={...data.registry,version:`recovery-${Date.now()}`,operators:data.registry.operators.filter(operator=>operator.nodeId!==data.payload.source.nodeId)};
  parseRegistry(registry);parseConfig(configuration);
  mkdirSync(destination,{mode:0o700});
  const marker={status:"RECOVERY_REVIEW_REQUIRED",sourceNodeId:data.payload.source.nodeId,newNodeId:identity.nodeId,restoredAt:Date.now(),
    pythRecovery:verified.pythRecovery,pythRuntimeLocksCleared:verified.pythRecovery.locks,
    requirements:["Keep the old signer stopped or explicitly revoke it; this restore never reuses its private key.","Reconcile retained history and source rights; configure collectors, credentials and peers.","Obtain independent-operator admission for the new identity; do not reset old signing counters.","Review Pyth configuration separately; no Pyth signer, provider credentials or publication manifest was restored.","Before enabling Pyth, stop or revoke the old Pyth publisher and reconcile its latest high-water marks, including attempts after this backup. Preserved local queue receipts do not prove upstream publication.","After documented operator review, remove this marker to permit collection or serving."]};
  newFile(join(destination,RECOVERY_MARKER),JSON.stringify(marker,null,2)+"\n");
  newFile(join(destination,configuration.databasePath),restoredDatabase);
  newFile(join(destination,configuration.identityPath),canonical(identity));
  newFile(join(destination,configuration.registryPath),JSON.stringify(registry,null,2)+"\n");
  newFile(join(destination,configuration.methodologyPath),JSON.stringify(data.methodology,null,2)+"\n");
  newFile(join(destination,"config/node.local.json"),JSON.stringify(configuration,null,2)+"\n");
  return {destination,sourceNodeId:data.payload.source.nodeId,newNodeId:identity.nodeId,status:marker.status,pythRuntimeLocksCleared:verified.pythRecovery.locks,...verified};
}
