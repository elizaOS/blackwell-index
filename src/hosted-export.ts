/** Private, signed logical snapshots. This module has no HTTP route or filesystem access. */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { z } from "zod";
import { canonical, nodeIdFor } from "./crypto";
import type { Journal } from "./journal";
import type { Methodology, NodeIdentity, Registry } from "./types";
import { parseMethodology, parseRegistry } from "./validation";

export const HOSTED_EXPORT_FORMAT = "SBX_HOSTED_JOURNAL_V1";
export const HOSTED_EXPORT_LIMITS = {bytes:8*1024*1024,rows:100_000} as const;
const domain = `${HOSTED_EXPORT_FORMAT}\n`;
// workerd's KV includes the private signer. Never select its rows or serialize its schema.
export const HOSTED_INTERNAL_TABLES = new Set(["_cf_KV","_cf_METADATA","__miniflare_do_name"]);
// Exact private V2 operational table names; unknown archive_* names still require review.
export const ARCHIVE_INTERNAL_TABLES = new Set(["archive_schema","archive_entries","archive_checkpoints","archive_frozen_counters","archive_frozen_candidates","archive_frozen_schedules","archive_blocks"]);
export const HOSTED_TABLES = [
  {name:"counters",columns:["id","value"],order:"id"},
  {name:"reports",columns:["hash","node_id","sequence","received_at","payload"],order:"node_id,sequence"},
  {name:"candidates",columns:["node_id","sequence","received_at","hash","payload","payload_bytes"],order:"node_id"},
  {name:"equivocations",columns:["node_id","detected_at","conflicting_payload"],order:"node_id"},
  {name:"equivocation_proofs",columns:["id","node_id","detected_at","first_payload","second_payload","payload_bytes"],order:"id"},
  {name:"evidence",columns:["hash","source","url","received_at","content_type","body"],order:"hash"},
  {name:"captures",columns:["id","collected_at","observations","errors"],order:"id"},
  {name:"snapshots",columns:["id","calculated_at","hash","previous_hash","payload"],order:"id"},
  {name:"configurations",columns:["hash","payload"],order:"hash"},
  {name:"evidence_chunks",columns:["hash","part","body"],order:"hash,part"},
  {name:"evidence_sizes",columns:["hash","bytes","parts"],order:"hash"},
  {name:"collection_captures",columns:["id","collected_at"],order:"id"},
  {name:"collector_schedules",columns:["collector_id","next_attempt_at","failures","reason","last_seen_at","version","lease_owner","lease_until"],order:"collector_id"},
] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const natural = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = natural.min(1);
const timestamp = positive.max(8_640_000_000_000_000);
const scheduleTime = natural.max(8_640_000_000_000_000);
const textCell = z.string().max(HOSTED_EXPORT_LIMITS.bytes);
const blobCell = z.object({base64:textCell}).strict();
// SQLite affinity does not enforce a column's declared type. Validate every exported cell.
export const hostedRowSchemas:Record<(typeof HOSTED_TABLES)[number]["name"],z.ZodType> = {
  counters:z.tuple([digest,positive]),
  reports:z.tuple([digest,digest,positive,timestamp,textCell]),
  candidates:z.tuple([digest,positive,timestamp,digest,textCell,natural]),
  equivocations:z.tuple([digest,timestamp,textCell]),
  equivocation_proofs:z.tuple([positive,digest,timestamp,textCell,textCell,natural]),
  evidence:z.tuple([digest,textCell,textCell,timestamp,textCell,blobCell]),
  captures:z.tuple([positive,timestamp,textCell,textCell]),
  snapshots:z.tuple([positive,timestamp,digest,digest.nullable(),textCell]),
  configurations:z.tuple([digest,textCell]),
  evidence_chunks:z.tuple([digest,natural,blobCell]),
  evidence_sizes:z.tuple([digest,natural,natural]),
  collection_captures:z.tuple([positive,timestamp]),
  collector_schedules:z.tuple([z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),scheduleTime,natural.max(16),
    z.enum(["READY","HTTP_429_BACKOFF","HTTP_503_BACKOFF"]),timestamp,natural,z.string().uuid().nullable(),scheduleTime]),
};
const cell = z.union([z.string().max(HOSTED_EXPORT_LIMITS.bytes),z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),z.null(),z.object({base64:z.string().max(HOSTED_EXPORT_LIMITS.bytes)}).strict()]);
const envelopeSchema = z.object({payload:z.object({format:z.literal(HOSTED_EXPORT_FORMAT),exportedAt:timestamp,
  source:z.object({nodeId:digest,publicKey:z.string().max(100),nodeName:z.enum(["primary","secondary"]),operatorGroup:z.string().min(1).max(128),release:z.string().regex(/^[a-f0-9]{40}$/).nullable()}).strict(),
  configuration:z.object({network:z.string(),intervalMs:z.number().int().min(30000).max(86400000),registry:z.unknown(),methodology:z.unknown()}).strict(),
  tables:z.array(z.object({name:z.string(),columns:z.array(z.string()),rows:z.array(z.array(cell)).max(HOSTED_EXPORT_LIMITS.rows)}).strict()).length(HOSTED_TABLES.length),
}).strict(),signature:z.string().length(88)}).strict();
export type HostedExport = z.infer<typeof envelopeSchema>;

export function encodeHostedCell(value:unknown):z.infer<typeof cell> {
  if(value instanceof ArrayBuffer)return {base64:Buffer.from(value).toString("base64")};
  if(ArrayBuffer.isView(value))return {base64:Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString("base64")};
  return cell.parse(value);
}

/** Consume every cursor synchronously in one transaction; never paginate live mutable tables. */
export function createHostedExport(journal:Journal,identity:NodeIdentity,metadata:{nodeName:"primary"|"secondary";operatorGroup:string;release:string|null;network:string;intervalMs:number;registry:Registry;methodology:Methodology},now=Date.now(),maximumBytes=HOSTED_EXPORT_LIMITS.bytes):string {
  if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>HOSTED_EXPORT_LIMITS.bytes)throw new Error("INVALID_EXPORT_LIMIT");
  const payload = journal.db.transaction(() => {
    const names=(journal.db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name);
    if(names.some(name=>!HOSTED_TABLES.some(table=>table.name===name)&&!name.startsWith("sqlite_")&&!HOSTED_INTERNAL_TABLES.has(name)&&!ARCHIVE_INTERNAL_TABLES.has(name)))throw new Error("HOSTED_EXPORT_SCHEMA_REVIEW_REQUIRED");
    let bytes=0,rows=0;
    const tables=HOSTED_TABLES.map(table=>{
      const values:z.infer<typeof cell>[][]=[];
      if(!names.includes(table.name)) {
        if(table.name!=="collector_schedules")throw new Error("HOSTED_EXPORT_TABLE_MISSING");
      } else {
        const columns=(journal.db.query(`PRAGMA table_info(${table.name})`).all() as {name:string}[]).map(column=>column.name);
        if(canonical(columns)!==canonical(table.columns))throw new Error("HOSTED_EXPORT_SCHEMA_REVIEW_REQUIRED");
        for(const row of journal.db.query(`SELECT ${table.columns.join(",")} FROM ${table.name} ORDER BY ${table.order}`).iterate() as Iterable<Record<string,unknown>>) {
          const value=table.columns.map(column=>encodeHostedCell(row[column]));
          if(!hostedRowSchemas[table.name].safeParse(value).success)throw new Error("HOSTED_EXPORT_CELL_DOMAIN_MISMATCH");
          bytes+=Buffer.byteLength(canonical(value));rows++;
          if(bytes>maximumBytes||rows>HOSTED_EXPORT_LIMITS.rows)throw new Error("HOSTED_EXPORT_LIMIT_REQUIRES_STREAMING_ARCHIVE");
          values.push(value);
        }
      }
      return {name:table.name,columns:[...table.columns],rows:values};
    });
    return {format:HOSTED_EXPORT_FORMAT,exportedAt:now,source:{nodeId:identity.nodeId,publicKey:identity.publicKey,nodeName:metadata.nodeName,operatorGroup:metadata.operatorGroup,release:metadata.release},
      configuration:{network:metadata.network,intervalMs:metadata.intervalMs,registry:metadata.registry,methodology:metadata.methodology},tables};
  })();
  const signature=sign(null,Buffer.from(domain+canonical(payload)),createPrivateKey(identity.privateKeyPem)).toString("base64");
  const encoded=canonical({payload,signature});
  if(Buffer.byteLength(encoded)>maximumBytes)throw new Error("HOSTED_EXPORT_LIMIT_REQUIRES_STREAMING_ARCHIVE");
  return encoded;
}

export function parseHostedExport(encoded:string,expectedNodeId:string,expectedRelease:string):HostedExport {
  if(Buffer.byteLength(encoded)>HOSTED_EXPORT_LIMITS.bytes)throw new Error("HOSTED_EXPORT_TOO_LARGE");
  const envelope=envelopeSchema.parse(JSON.parse(encoded)),{payload,signature}=envelope;
  if(payload.source.nodeId!==expectedNodeId||payload.source.release!==expectedRelease||nodeIdFor(payload.source.publicKey)!==payload.source.nodeId)throw new Error("HOSTED_EXPORT_SOURCE_MISMATCH");
  if(Buffer.from(signature,"base64").toString("base64")!==signature||Buffer.from(payload.source.publicKey,"base64").toString("base64")!==payload.source.publicKey)throw new Error("HOSTED_EXPORT_SIGNATURE_INVALID");
  const key=createPublicKey({key:Buffer.from(payload.source.publicKey,"base64"),type:"spki",format:"der"});
  if(key.asymmetricKeyType!=="ed25519"||!verify(null,Buffer.from(domain+canonical(payload)),key,Buffer.from(signature,"base64")))throw new Error("HOSTED_EXPORT_SIGNATURE_INVALID");
  const registry=parseRegistry(payload.configuration.registry);parseMethodology(payload.configuration.methodology);
  if(registry.network!==payload.configuration.network)throw new Error("HOSTED_EXPORT_NETWORK_MISMATCH");
  let rows=0;
  for(const [index,table] of payload.tables.entries()) {
    const expected=HOSTED_TABLES[index]!;
    if(table.name!==expected.name||canonical(table.columns)!==canonical(expected.columns))throw new Error("HOSTED_EXPORT_SCHEMA_MISMATCH");
    for(const row of table.rows) {
      if(row.length!==expected.columns.length||++rows>HOSTED_EXPORT_LIMITS.rows)throw new Error("HOSTED_EXPORT_ROW_MISMATCH");
      if(!hostedRowSchemas[expected.name].safeParse(row).success)throw new Error("HOSTED_EXPORT_CELL_DOMAIN_MISMATCH");
      for(const [column,value] of row.entries()) {
        if(typeof value==="object"&&value!==null) {
          if(expected.columns[column]!=="body"||Buffer.from(value.base64,"base64").toString("base64")!==value.base64)throw new Error("HOSTED_EXPORT_BLOB_MISMATCH");
        } else if(expected.columns[column]==="body")throw new Error("HOSTED_EXPORT_BLOB_MISMATCH");
      }
    }
  }
  return envelope;
}
