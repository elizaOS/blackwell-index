/** Versioned non-secret publishing state. Queue receipts never prove upstream publication. */
import { z } from "zod";
import { canonical, hash } from "../crypto";
import type { Journal, SqlDriver } from "../journal";

export const PYTH_RECOVERY_LIMITS=Object.freeze({states:8192,receipts:1000,locks:512,feeds:512,rowBytes:64*1024,rootBytes:800*1024});
export const PYTH_RUNTIME_TABLES=["pyth_submission_state","pyth_queue_receipts","pyth_runtime_locks"] as const;
type Table=typeof PYTH_RUNTIME_TABLES[number];
const digest=z.string().regex(/^[a-f0-9]{64}$/),natural=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),positive=natural.min(1);
const identifier=z.string().min(1).max(256).regex(/^[a-zA-Z0-9._:-]+$/);
const feed=z.object({feedId:positive.max(4_294_967_295),sourceTimestamp:positive}).strict();
const stateSchema=z.object({publisher:digest,feed_id:positive.max(4_294_967_295),last_attempted_timestamp:positive,last_queued_timestamp:natural,
  last_attempt_id:identifier,last_status:z.enum(["DELIVERY_UNCONFIRMED","QUEUED_LOCAL"]),updated_at:positive}).strict();
const receiptSchema=z.object({request_id:identifier,snapshot_hash:digest,queued_at:positive,feeds:z.string().min(1).max(PYTH_RECOVERY_LIMITS.rowBytes)}).strict();
const lockSchema=z.object({id:digest,owner:z.string().uuid(),expires_at:positive}).strict();
const schemas={pyth_submission_state:stateSchema,pyth_queue_receipts:receiptSchema,pyth_runtime_locks:lockSchema};
type State=z.infer<typeof stateSchema>; type Receipt=z.infer<typeof receiptSchema>; type Lock=z.infer<typeof lockSchema>;
type Row=State|Receipt|Lock;
const capacities={pyth_submission_state:PYTH_RECOVERY_LIMITS.states,pyth_queue_receipts:PYTH_RECOVERY_LIMITS.receipts,pyth_runtime_locks:PYTH_RECOVERY_LIMITS.locks};
const columns:Record<Table,readonly [string,string,number,number][]>={
  pyth_submission_state:[["publisher","TEXT",1,1],["feed_id","INTEGER",1,2],["last_attempted_timestamp","INTEGER",1,0],["last_queued_timestamp","INTEGER",1,0],["last_attempt_id","TEXT",1,0],["last_status","TEXT",1,0],["updated_at","INTEGER",1,0]],
  pyth_queue_receipts:[["request_id","TEXT",0,1],["snapshot_hash","TEXT",1,0],["queued_at","INTEGER",1,0],["feeds","TEXT",1,0]],
  pyth_runtime_locks:[["id","TEXT",0,1],["owner","TEXT",1,0],["expires_at","INTEGER",1,0]],
};
export const PYTH_RUNTIME_SQL=`
  CREATE TABLE IF NOT EXISTS pyth_runtime_locks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS pyth_submission_state (publisher TEXT NOT NULL, feed_id INTEGER NOT NULL, last_attempted_timestamp INTEGER NOT NULL, last_queued_timestamp INTEGER NOT NULL, last_attempt_id TEXT NOT NULL, last_status TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(publisher,feed_id));
  CREATE TABLE IF NOT EXISTS pyth_queue_receipts (request_id TEXT PRIMARY KEY, snapshot_hash TEXT NOT NULL, queued_at INTEGER NOT NULL, feeds TEXT NOT NULL);
`;
function normalizedSql(sql:string):string {return sql.replace(/\bIF\s+NOT\s+EXISTS\s+/gi,"").replace(/[\s;]+/g,"").toUpperCase();}
const definitions=new Map(PYTH_RUNTIME_SQL.split(";").filter(sql=>sql.trim()).map(sql=>[sql.match(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/)![1]!,normalizedSql(sql)]));
export interface PythRecoverySummary {present:boolean;states:number;receipts:number;locks:number;upstreamPublication:"NOT_PROVEN"}
const ROOT_FORMAT="SBX_PYTH_RECOVERY_V1",ROW_FORMAT="SBX_PYTH_RECOVERY_ROW_V1";
const rootSchema=z.object({format:z.literal(ROOT_FORMAT),rows:z.array(digest).max(PYTH_RECOVERY_LIMITS.states+PYTH_RECOVERY_LIMITS.receipts+PYTH_RECOVERY_LIMITS.locks)}).strict();
const rowSchema=z.object({format:z.literal(ROW_FORMAT),table:z.enum(PYTH_RUNTIME_TABLES),value:z.unknown()}).strict();
function fail(code:string):never {throw new Error(`PYTH_RECOVERY_${code}`);}
function empty(present=false):PythRecoverySummary {return {present,states:0,receipts:0,locks:0,upstreamPublication:"NOT_PROVEN"};}
/** Read schema before SELECTing arbitrary source objects; never execute imported SQL. */
export function validatePythRuntimeSchema(db:SqlDriver):boolean {
  const objects=db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'pyth_%' OR tbl_name LIKE 'pyth_%' LIMIT 32").all() as {type:string;name:string;tbl_name:string;sql:string|null}[];
  const tables=objects.filter(row=>row.type==="table");
  if(!objects.length)return false;
  if(objects.length>=32||tables.length!==3||objects.some(row=>
    !PYTH_RUNTIME_TABLES.includes(row.tbl_name as Table)||row.type!=="table"&&!(row.type==="index"&&row.sql===null&&row.name.startsWith("sqlite_autoindex_"))||/\bVIRTUAL\b/i.test(row.sql??"")))fail("SCHEMA_REVIEW_REQUIRED");
  for(const table of PYTH_RUNTIME_TABLES) {
    const definition=tables.find(row=>row.name===table);
    // Column metadata alone misses CHECK/FK/UNIQUE/collation changes. V1 retains
    // SQL schema, so only our reviewed CREATE statements may pass either path.
    if(!definition||normalizedSql(definition.sql??"")!==definitions.get(table))fail("SCHEMA_REVIEW_REQUIRED");
    const actual=db.query(`PRAGMA table_xinfo(${table})`).all() as {name:string;type:string;notnull:number;pk:number;dflt_value:unknown;hidden:number}[];
    const expected=columns[table];
    if(actual.length!==expected.length||actual.some((value,index)=>{
      const [name,type,notnull,pk]=expected[index]!;
      return value.name!==name||value.type.toUpperCase()!==type||value.notnull!==notnull||value.pk!==pk||value.dflt_value!==null||value.hidden!==0;
    }))fail("SCHEMA_REVIEW_REQUIRED");
  }
  return true;
}
class Validator {
  readonly summary=empty(true);
  private readonly keys=new Set<string>();
  private readonly latest=new Map<string,State[]>();
  constructor(private readonly cutoff:number) {if(!Number.isSafeInteger(cutoff)||cutoff<1||cutoff>Number.MAX_SAFE_INTEGER-60_000)fail("CLOCK_INVALID");}
  row(table:Table,value:unknown):Row {
    if(Buffer.byteLength(canonical(value))>PYTH_RECOVERY_LIMITS.rowBytes)fail("ROW_TOO_LARGE");
    const parsed=schemas[table].safeParse(value);if(!parsed.success)fail("ROW_INVALID");
    const row=parsed.data;
    const field=table==="pyth_submission_state"?"states":table==="pyth_queue_receipts"?"receipts":"locks";
    if(++this.summary[field]>capacities[table])fail("CAPACITY");
    const key=table+":"+(table==="pyth_submission_state"?`${(row as State).publisher}:${(row as State).feed_id}`:table==="pyth_queue_receipts"?(row as Receipt).request_id:(row as Lock).id);
    if(this.keys.has(key))fail("DUPLICATE_ROW");this.keys.add(key);
    if(table==="pyth_submission_state") {
      const state=row as State;
      if(state.last_queued_timestamp>state.last_attempted_timestamp||state.last_status==="QUEUED_LOCAL"&&state.last_queued_timestamp!==state.last_attempted_timestamp||
        state.updated_at>this.cutoff||BigInt(state.last_attempted_timestamp)>BigInt(this.cutoff+60_000)*1000n)fail("HIGHWATER_INVALID");
      const group=this.latest.get(state.last_attempt_id)??[];group.push(state);this.latest.set(state.last_attempt_id,group);
    } else if(table==="pyth_queue_receipts") {
      const receipt=row as Receipt;let raw:unknown;
      try{raw=JSON.parse(receipt.feeds);}catch{fail("RECEIPT_INVALID");}
      const result=z.array(feed).min(1).max(PYTH_RECOVERY_LIMITS.feeds).safeParse(raw);if(!result.success)fail("RECEIPT_INVALID");
      const feeds=result.data,ids=new Set<number>();
      if(receipt.queued_at>this.cutoff)fail("RECEIPT_CLOCK");
      for(const item of feeds) {
        if(ids.has(item.feedId)||BigInt(item.sourceTimestamp)>BigInt(receipt.queued_at+60_000)*1000n)fail("RECEIPT_INVALID");ids.add(item.feedId);
      }
      // Old receipts may outlive current attempt IDs; pruned receipts may be absent.
      // Where the latest successful attempt still has a receipt, it must agree.
      for(const state of this.latest.get(receipt.request_id)??[]) {
        const item=feeds.find(item=>item.feedId===state.feed_id);
        if(!item||item.sourceTimestamp!==state.last_attempted_timestamp||state.last_status!=="QUEUED_LOCAL"||state.last_queued_timestamp<item.sourceTimestamp||state.updated_at<receipt.queued_at)fail("RECEIPT_STATE_MISMATCH");
      }
    } else if((row as Lock).expires_at>this.cutoff+60_000)fail("LOCK_CLOCK");
    return row;
  }
}
function* runtimeRows(db:SqlDriver):Generator<{table:Table;value:Row}> {
  for(const table of PYTH_RUNTIME_TABLES) {
    const count=(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {count:number}).count;
    if(!Number.isSafeInteger(count)||count>capacities[table])fail("CAPACITY");
    const names=columns[table].map(column=>column[0]);
    // Check SQL byte lengths before transferring any untrusted TEXT into JS.
    const textBytes=columns[table].filter(column=>column[1]==="TEXT").map(column=>`COALESCE(length(CAST(${column[0]} AS BLOB)),0)`).join("+");
    if(db.query(`SELECT 1 FROM ${table} WHERE ${textBytes}>? LIMIT 1`).get(PYTH_RECOVERY_LIMITS.rowBytes-2048))fail("ROW_TOO_LARGE");
    const order=table==="pyth_submission_state"?"publisher,feed_id":table==="pyth_queue_receipts"?"request_id":"id";
    for(const value of db.query(`SELECT ${names.join(",")} FROM ${table} ORDER BY ${order}`).iterate() as Iterable<Row>)yield {table,value};
  }
}
export function verifyPythRuntimeState(db:SqlDriver,cutoffMs:number):PythRecoverySummary {
  if(!validatePythRuntimeSchema(db))return empty();
  const validator=new Validator(cutoffMs);
  for(const {table,value} of runtimeRows(db))validator.row(table,value);
  return validator.summary;
}
/** Must only be called on a verified, inactive restoration image, never a live journal. */
export function resetRecoveredPythLocks(db:SqlDriver):void {
  if(validatePythRuntimeSchema(db))db.query("DELETE FROM pyth_runtime_locks").run();
}
/** Copy-only transformation. Keep each bounded row hash-addressed; do not copy signer material. */
export function archivePythRuntimeState(journal:Journal,cutoffMs:number):string|undefined {
  if(!validatePythRuntimeSchema(journal.db))return undefined;
  return journal.db.transaction(()=>{
    const validator=new Validator(cutoffMs),rows:string[]=[];
    for(const {table,value} of runtimeRows(journal.db))rows.push(journal.saveConfiguration({format:ROW_FORMAT,table,value:validator.row(table,value)}));
    const root={format:ROOT_FORMAT,rows};if(Buffer.byteLength(canonical(root))>PYTH_RECOVERY_LIMITS.rootBytes)fail("ROOT_TOO_LARGE");
    const result=journal.saveConfiguration(root);
    for(const table of PYTH_RUNTIME_TABLES)journal.db.exec(`DROP TABLE ${table}`);
    return result;
  })();
}
function configuration(journal:Journal,digest:string,maximum:number):unknown {
  const size=journal.db.query("SELECT length(CAST(payload AS BLOB)) AS bytes FROM configurations WHERE hash=?").get(digest) as {bytes:number}|null;
  if(!size||size.bytes<1||size.bytes>maximum)fail("CONFIGURATION_MISSING_OR_OVERSIZED");
  const value=journal.configuration(digest);if(hash(value)!==digest)fail("CONFIGURATION_HASH_MISMATCH");return value;
}
/** Verify one signed-descriptor-bound state root. Historical roots do not restore authority. */
export function verifyArchivedPythState(journal:Journal,rootHash:string|undefined,cutoffMs:number,consume?:(table:Table,value:Row)=>void):PythRecoverySummary {
  if(rootHash===undefined)return empty();
  const parsed=rootSchema.safeParse(configuration(journal,rootHash,PYTH_RECOVERY_LIMITS.rootBytes));if(!parsed.success)fail("ROOT_INVALID");
  const seen=new Set<string>(),validator=new Validator(cutoffMs);let previousTable=0;
  for(const rowHash of parsed.data.rows) {
    if(seen.has(rowHash))fail("DUPLICATE_ROW");seen.add(rowHash);
    const parsedRow=rowSchema.safeParse(configuration(journal,rowHash,PYTH_RECOVERY_LIMITS.rowBytes+1024));if(!parsedRow.success)fail("ROW_INVALID");
    const {table,value}=parsedRow.data,index=PYTH_RUNTIME_TABLES.indexOf(table);
    if(index<previousTable)fail("TABLE_ORDER");previousTable=index;
    const validated=validator.row(table,value);consume?.(table,validated);
  }
  return validator.summary;
}
/** Signed inherited high-water marks are a floor, not proof that this is the latest backup. */
export function verifyPythStateContinuity(journal:Journal,rootHash:string|undefined,priorRootHash:string|undefined,cutoffMs:number):PythRecoverySummary {
  const current=new Map<string,State>();
  const summary=verifyArchivedPythState(journal,rootHash,cutoffMs,(table,value)=>{
    if(table==="pyth_submission_state") {const state=value as State;current.set(`${state.publisher}:${state.feed_id}`,state);}
  });
  if(priorRootHash!==undefined) {
    if(rootHash===undefined)fail("INHERITED_STATE_MISSING");
    verifyArchivedPythState(journal,priorRootHash,cutoffMs,(table,value)=>{
      if(table!=="pyth_submission_state")return;
      const prior=value as State,state=current.get(`${prior.publisher}:${prior.feed_id}`);
      if(!state||state.last_attempted_timestamp<prior.last_attempted_timestamp||state.last_queued_timestamp<prior.last_queued_timestamp||state.updated_at<prior.updated_at)fail("INHERITED_HIGHWATER_ROLLBACK");
    });
  }
  return summary;
}
/** Rebuild application-owned tables in a new verified staging DB; locks are audit-only. */
export function restoreArchivedPythState(journal:Journal,rootHash:string|undefined,cutoffMs:number):void {
  if(rootHash===undefined)return;
  if(validatePythRuntimeSchema(journal.db))fail("RESTORE_REQUIRES_EMPTY_TABLES");
  journal.db.transaction(()=>{
    journal.db.exec(PYTH_RUNTIME_SQL);
    verifyArchivedPythState(journal,rootHash,cutoffMs,(table,value)=>{
      if(table==="pyth_runtime_locks")return;
      const names=columns[table].map(column=>column[0]),row=value as Record<string,unknown>;
      journal.db.query(`INSERT INTO ${table}(${names.join(",")}) VALUES(${names.map(()=>"?").join(",")})`).run(...names.map(name=>row[name]));
    });
  })();
}
