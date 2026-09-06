/** Bounded, domain-separated wire protocol. No database, filesystem or network access. */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { z } from "zod";
import { canonical, hash, nodeIdFor } from "./crypto";
import { HOSTED_TABLES, encodeHostedCell, hostedRowSchemas } from "./hosted-export";
import type { NodeIdentity } from "./types";

export const ARCHIVE_FORMAT = "SBX_CHECKPOINT_V2" as const;
/** Private operator diagnostics only. Arbitrary database/validation messages are never forwarded. */
export const ARCHIVE_OPERATOR_ERRORS=Object.freeze([
  "COLLECTION_RUNNING_RETRY_EXPORT","ARCHIVE_RELEASE_REQUIRED","ARCHIVE_CHECKPOINT_ALREADY_ACTIVE","ARCHIVE_CHECKPOINT_NOT_FOUND",
  "ARCHIVE_CHECKPOINT_EXPIRED","ARCHIVE_CHECKPOINT_NOT_COMPLETE","ARCHIVE_CHECKPOINT_INCOMPLETE","ARCHIVE_CHECKPOINT_STAGING_CAPACITY",
  "ARCHIVE_FROZEN_CAPACITY","ARCHIVE_SOURCE_MISMATCH","ARCHIVE_MEMBERSHIP_INCOMPLETE","ARCHIVE_SCHEMA_REVIEW_REQUIRED",
  "ARCHIVE_MEMBERSHIP_VERSION_UNSUPPORTED","ARCHIVE_RECORD_TOO_LARGE","ARCHIVE_CONFIGURATION_MISSING","ARCHIVE_CLOCK_ROLLBACK",
  "ARCHIVE_BLOCK_ORDER_MISMATCH","ARCHIVE_BLOCK_METADATA_MISSING","ARCHIVE_IMMUTABLE_DATA_CHANGED","ARCHIVE_CHECKPOINT_CAPACITY",
] as const);
export const ARCHIVE_LIMITS = Object.freeze({blockBytes:256*1024,transportBytes:512*1024,recordBytes:2*1024*1024,descriptorBytes:16*1024,ttlMs:60*60*1000,maxTtlMs:24*60*60*1000,maxFragments:4096});
export const ARCHIVE_TABLES = HOSTED_TABLES.map((table,code)=>({...table,code,
  mutable:code===0||code===2||code===12,
  keyText:code===0?"id":code===2||code===3?"node_id":code===12?"collector_id":[1,5,8,9,10].includes(code)?"hash":null,
  keyInteger:[4,6,7,11].includes(code)?"id":code===9?"part":null,
}));
export type ArchiveCell = string|number|null|{base64:string};
export type ArchiveRecordKey = [string,number];
const natural=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),positive=natural.min(1);
const digest=z.string().regex(/^[a-f0-9]{64}$/),timestamp=positive.max(8_640_000_000_000_000);
const checkpointId=z.string().uuid(),tableCode=natural.max(HOSTED_TABLES.length-1);
const keySchema=z.tuple([z.string().max(128),natural]);
const counts=z.array(natural).length(HOSTED_TABLES.length);
const signature=z.string().length(88);
const sourceSchema=z.object({nodeId:digest,publicKey:z.string().max(100),nodeName:z.enum(["primary","secondary","local"]),operatorGroup:z.string().min(1).max(128),release:z.string().regex(/^[a-f0-9]{40}$/)}).strict();
export const archiveCursorSchema=z.object({table:natural.max(HOSTED_TABLES.length),position:natural,offset:natural.max(ARCHIVE_LIMITS.recordBytes-1)}).strict();
export type ArchiveCursor=z.infer<typeof archiveCursorSchema>;
const descriptorPayloadSchema=z.object({format:z.literal(ARCHIVE_FORMAT),checkpointId,createdAt:timestamp,expiresAt:timestamp,source:sourceSchema,
  configuration:z.object({network:z.string().min(1).max(128),intervalMs:positive.min(30000).max(86400000),registryHash:digest,methodologyHash:digest}).strict(),
  cutoff:natural,counts,snapshotHead:z.object({id:positive,hash:digest}).strict().nullable(),
  // Optional for compatibility with existing hosted V2 archives. The referenced
  // configuration contains a bounded signed recovery receipt, not nested archives.
  recoveryProvenanceHash:digest.optional(),
  // Pyth operational state is non-secret, versioned, and separately hash-bound.
  pythStateHash:digest.optional(),
}).strict();
const descriptorSchema=z.object({payload:descriptorPayloadSchema,signature}).strict();
export type ArchiveDescriptor=z.infer<typeof descriptorSchema>;
export type ArchiveDescriptorPayload=ArchiveDescriptor["payload"];
const fragmentSchema=z.object({table:tableCode,key:keySchema,position:positive,offset:natural.max(ARCHIVE_LIMITS.recordBytes-1),totalLength:positive.max(ARCHIVE_LIMITS.recordBytes),data:z.string().max(Math.ceil(ARCHIVE_LIMITS.blockBytes/3)*4)}).strict();
const blockSchema=z.object({checkpointId,descriptorHash:digest,index:natural,previousHash:digest.nullable(),start:archiveCursorSchema,end:archiveCursorSchema,
  fragments:z.array(fragmentSchema).min(1).max(ARCHIVE_LIMITS.maxFragments),hash:digest}).strict();
export type ArchiveBlock=z.infer<typeof blockSchema>;
export type ArchiveFragment=ArchiveBlock["fragments"][number];
const sealPayloadSchema=z.object({format:z.literal("SBX_CHECKPOINT_SEAL_V2"),checkpointId,descriptorHash:digest,blockCount:natural,totalBytes:natural,counts,finalHash:digest.nullable()}).strict();
const sealSchema=z.object({payload:sealPayloadSchema,signature}).strict();
export type ArchiveSeal=z.infer<typeof sealSchema>;

function parsed(value:unknown,maximum:number):unknown {
  if(typeof value!=="string") {if(Buffer.byteLength(canonical(value))>maximum)throw new Error("ARCHIVE_ENVELOPE_TOO_LARGE");return value;}
  if(Buffer.byteLength(value)>maximum)throw new Error("ARCHIVE_ENVELOPE_TOO_LARGE");
  return JSON.parse(value);
}
function signatureFor(domain:string,payload:unknown,identity:NodeIdentity):string {
  if(nodeIdFor(identity.publicKey)!==identity.nodeId)throw new Error("ARCHIVE_SOURCE_MISMATCH");
  const result=sign(null,Buffer.from(`${domain}\n${canonical(payload)}`),createPrivateKey(identity.privateKeyPem)).toString("base64");
  verifySignature(domain,payload,result,identity.publicKey);return result;
}
function verifySignature(domain:string,payload:unknown,signatureValue:string,publicKey:string):void {
  try {
    if(Buffer.from(signatureValue,"base64").toString("base64")!==signatureValue||Buffer.from(publicKey,"base64").toString("base64")!==publicKey)throw new Error();
    const key=createPublicKey({key:Buffer.from(publicKey,"base64"),type:"spki",format:"der"});
    if(key.asymmetricKeyType!=="ed25519"||!verify(null,Buffer.from(`${domain}\n${canonical(payload)}`),key,Buffer.from(signatureValue,"base64")))throw new Error();
  } catch {throw new Error("ARCHIVE_SIGNATURE_INVALID");}
}
export function archiveDescriptorHash(descriptor:ArchiveDescriptor):string {return hash({domain:"SBX_ARCHIVE_DESCRIPTOR_HASH_V2",payload:descriptor.payload});}
export function signArchiveDescriptor(payload:ArchiveDescriptorPayload,identity:NodeIdentity):ArchiveDescriptor {
  descriptorPayloadSchema.parse(payload);const result={payload,signature:signatureFor("SBX_ARCHIVE_DESCRIPTOR_V2",payload,identity)};
  return parseArchiveDescriptor(result,identity.nodeId,payload.source.release);
}
export function parseArchiveDescriptor(value:unknown,expectedNodeId:string,expectedRelease:string):ArchiveDescriptor {
  const descriptor=descriptorSchema.parse(parsed(value,ARCHIVE_LIMITS.descriptorBytes)),p=descriptor.payload;
  if(p.source.nodeId!==expectedNodeId||p.source.release!==expectedRelease||nodeIdFor(p.source.publicKey)!==p.source.nodeId)throw new Error("ARCHIVE_SOURCE_MISMATCH");
  if(p.expiresAt<=p.createdAt||p.expiresAt-p.createdAt>ARCHIVE_LIMITS.maxTtlMs)throw new Error("ARCHIVE_EXPIRY_INVALID");
  if((p.counts[7]===0)!==(p.snapshotHead===null))throw new Error("ARCHIVE_SNAPSHOT_HEAD_MISMATCH");
  verifySignature("SBX_ARCHIVE_DESCRIPTOR_V2",p,descriptor.signature,p.source.publicKey);return descriptor;
}
export function archiveBlockHash(block:Omit<ArchiveBlock,"hash">):string {return hash({domain:"SBX_ARCHIVE_BLOCK_V2",block});}
export function archiveRecordKey(table:number,row:ArchiveCell[]):ArchiveRecordKey {
  const specification=ARCHIVE_TABLES[table];if(!specification)throw new Error("ARCHIVE_TABLE_INVALID");
  const columns=specification.columns as readonly string[];
  return [specification.keyText?row[columns.indexOf(specification.keyText)] as string:"",specification.keyInteger?row[columns.indexOf(specification.keyInteger)] as number:0];
}
export function encodeArchiveRecord(table:number,row:Record<string,unknown>|ArchiveCell[]):Uint8Array {
  const specification=ARCHIVE_TABLES[table];if(!specification)throw new Error("ARCHIVE_TABLE_INVALID");
  const values=Array.isArray(row)?row:specification.columns.map(column=>encodeHostedCell(row[column]));
  validateArchiveRow(table,values);
  const encoded=Buffer.from(canonical(values));if(encoded.byteLength>ARCHIVE_LIMITS.recordBytes)throw new Error("ARCHIVE_RECORD_TOO_LARGE");return encoded;
}
export function validateArchiveRow(table:number,row:unknown):asserts row is ArchiveCell[] {
  const specification=ARCHIVE_TABLES[table];if(!specification||!hostedRowSchemas[specification.name].safeParse(row).success)throw new Error("ARCHIVE_RECORD_INVALID");
  for(const cell of row as ArchiveCell[])if(typeof cell==="object"&&cell!==null&&Buffer.from(cell.base64,"base64").toString("base64")!==cell.base64)throw new Error("ARCHIVE_BASE64_INVALID");
}
export function decodeArchiveRecord(table:number,key:ArchiveRecordKey,bytes:Uint8Array):ArchiveCell[] {
  if(bytes.byteLength>ARCHIVE_LIMITS.recordBytes)throw new Error("ARCHIVE_RECORD_TOO_LARGE");
  const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes),row:unknown=JSON.parse(text);validateArchiveRow(table,row);
  if(canonical(row)!==text||canonical(archiveRecordKey(table,row))!==canonical(key))throw new Error("ARCHIVE_RECORD_KEY_MISMATCH");return row;
}
export function parseArchiveBlock(value:unknown,descriptor:ArchiveDescriptor,expected?:{index:number;previousHash:string|null;cursor:ArchiveCursor}):ArchiveBlock {
  const block=blockSchema.parse(parsed(value,ARCHIVE_LIMITS.transportBytes)),{hash:blockHash,...unsigned}=block;
  if(block.checkpointId!==descriptor.payload.checkpointId||block.descriptorHash!==archiveDescriptorHash(descriptor))throw new Error("ARCHIVE_CHECKPOINT_MISMATCH");
  if(archiveBlockHash(unsigned)!==blockHash)throw new Error("ARCHIVE_BLOCK_HASH_MISMATCH");
  if(expected&&(block.index!==expected.index||block.previousHash!==expected.previousHash||canonical(block.start)!==canonical(expected.cursor)))throw new Error("ARCHIVE_BLOCK_ORDER_MISMATCH");
  let bytes=0,cursor={...block.start};
  for(const fragment of block.fragments) {
    const data=Buffer.from(fragment.data,"base64");bytes+=data.length;
    if(!ARCHIVE_TABLES[fragment.table]!.mutable&&fragment.position>descriptor.payload.cutoff)throw new Error("ARCHIVE_MEMBERSHIP_CUTOFF_MISMATCH");
    if(!data.length||data.toString("base64")!==fragment.data||fragment.offset+data.length>fragment.totalLength)throw new Error("ARCHIVE_FRAGMENT_INVALID");
    if(fragment.table<cursor.table||fragment.table>cursor.table&&cursor.offset!==0||fragment.table===cursor.table&&(cursor.offset===0?fragment.position<=cursor.position:fragment.position!==cursor.position||fragment.offset!==cursor.offset)||fragment.table>cursor.table&&fragment.offset!==0)throw new Error("ARCHIVE_CURSOR_MISMATCH");
    if(cursor.offset===0&&fragment.offset!==0)throw new Error("ARCHIVE_FRAGMENT_GAP");
    cursor={table:fragment.table,position:fragment.position,offset:fragment.offset+data.length===fragment.totalLength?0:fragment.offset+data.length};
  }
  if(bytes>ARCHIVE_LIMITS.blockBytes)throw new Error("ARCHIVE_BLOCK_TOO_LARGE");
  // End may advance through empty tables, but never skip an unfinished record.
  if(block.end.table<cursor.table||block.end.table===cursor.table&&(block.end.position!==cursor.position||block.end.offset!==cursor.offset)||block.end.table>cursor.table&&(cursor.offset!==0||block.end.offset!==0||block.end.position!==0))throw new Error("ARCHIVE_CURSOR_MISMATCH");
  if(block.end.table===HOSTED_TABLES.length&&(block.end.position!==0||block.end.offset!==0))throw new Error("ARCHIVE_CURSOR_MISMATCH");
  return block;
}
export function signArchiveSeal(payload:ArchiveSeal["payload"],descriptor:ArchiveDescriptor,identity:NodeIdentity):ArchiveSeal {
  const seal={payload,signature:signatureFor("SBX_ARCHIVE_SEAL_V2",payload,identity)};return parseArchiveSeal(seal,descriptor);
}
export function parseArchiveSeal(value:unknown,descriptor:ArchiveDescriptor,expected?:{blockCount:number;totalBytes:number;counts:number[];finalHash:string|null}):ArchiveSeal {
  const seal=sealSchema.parse(parsed(value,ARCHIVE_LIMITS.descriptorBytes)),p=seal.payload;
  if(p.checkpointId!==descriptor.payload.checkpointId||p.descriptorHash!==archiveDescriptorHash(descriptor)||canonical(p.counts)!==canonical(descriptor.payload.counts))throw new Error("ARCHIVE_SEAL_MISMATCH");
  if((p.blockCount===0)!==(p.finalHash===null)||expected&&(p.blockCount!==expected.blockCount||p.totalBytes!==expected.totalBytes||p.finalHash!==expected.finalHash||canonical(p.counts)!==canonical(expected.counts)))throw new Error("ARCHIVE_SEAL_MISMATCH");
  verifySignature("SBX_ARCHIVE_SEAL_V2",p,seal.signature,descriptor.payload.source.publicKey);return seal;
}
