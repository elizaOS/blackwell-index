import { randomUUID } from "node:crypto";
import { hash } from "../crypto";
import type { Journal } from "../journal";
import type { Snapshot } from "../types";
import { preparePythPublication, PYTH_SYMBOLS_URL, submitToPythAgent, validatePythManifest, validatePythSymbols, type PythQueueReceipt } from "./index";

export interface PythRuntimeReport {
  status: "DISABLED" | "UNAVAILABLE" | "BUSY" | "NO_NEW_SOURCE_DATA" | "BLOCKED" | "QUEUED_LOCAL" | "DELIVERY_UNCONFIRMED";
  feeds: Array<{ feedId: number; sourceTimestamp: number }>;
  requestId?: string;
  snapshotHash?: string;
  queuedAt?: number;
  error?: string;
}

/** Optional injection supports isolated tests; deployed callers use the official catalog and local agent. */
export interface PythRuntimeDependencies {
  now?: () => number;
  fetchCatalog?: () => Promise<unknown>;
  submit?: typeof submitToPythAgent;
}

async function fetchOfficialCatalog(): Promise<unknown> {
  const response=await fetch(PYTH_SYMBOLS_URL,{redirect:"error",signal:AbortSignal.timeout(10_000)});
  if(!response.ok)throw new Error(`Pyth symbol catalog HTTP ${response.status}`);
  const maximum=8_000_000;
  if(Number(response.headers.get("content-length")??0)>maximum||!response.body)throw new Error("Invalid or oversized Pyth symbol catalog");
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];
  let size=0;
  try {
    while(true) {
      const part=await reader.read();if(part.done)break;
      size+=part.value.byteLength;if(size>maximum)throw new Error("Pyth symbol catalog exceeds size limit");
      chunks.push(part.value);
    }
  } catch(error) {await reader.cancel();throw error;}
  finally {reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/**
 * An operational tick, not publication proof. A source timestamp is durably reserved before
 * submission: after a crash or lost acknowledgement, only genuinely newer source data is retried.
 */
export async function publishSnapshot(snapshot:Snapshot,manifest:unknown,journal:Journal,dependencies:PythRuntimeDependencies={}):Promise<PythRuntimeReport> {
  const clock=dependencies.now??Date.now,db=journal.db;
  const initialTime=clock();
  let lockId:string|undefined,owner:string|undefined;
  let attempted:Array<{feedId:number;sourceTimestamp:number}>=[];
  let requestId:string|undefined,snapshotHash:string|undefined;
  try {
    const m=validatePythManifest(manifest,initialTime);
    if(!m.enabled)return {status:"DISABLED",feeds:[]};
    if(!snapshot.publishable)return {status:"UNAVAILABLE",feeds:[]};
    if(m.approval.status!=="APPROVED"||m.approval.expiresAt<=initialTime)throw new Error("Pyth publication needs current publisher and feed approval");
    db.exec(`
      CREATE TABLE IF NOT EXISTS pyth_runtime_locks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pyth_submission_state (publisher TEXT NOT NULL, feed_id INTEGER NOT NULL, last_attempted_timestamp INTEGER NOT NULL, last_queued_timestamp INTEGER NOT NULL, last_attempt_id TEXT NOT NULL, last_status TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(publisher,feed_id));
      CREATE TABLE IF NOT EXISTS pyth_queue_receipts (request_id TEXT PRIMARY KEY, snapshot_hash TEXT NOT NULL, queued_at INTEGER NOT NULL, feeds TEXT NOT NULL);
    `);
    const publisher=hash({network:m.network,publisherPublicKey:m.approval.publisherPublicKey});
    lockId=publisher;owner=randomUUID();
    const leaseOwner=owner,leaseId=lockId;
    const acquired=db.transaction(()=>{
      const current=db.query("SELECT expires_at FROM pyth_runtime_locks WHERE id=?").get(leaseId) as {expires_at:number}|null;
      if(current&&current.expires_at>initialTime)return false;
      db.query("INSERT INTO pyth_runtime_locks(id,owner,expires_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at").run(leaseId,leaseOwner,initialTime+30_000);
      return true;
    })();
    if(!acquired)return {status:"BUSY",feeds:[]};
    const catalog=validatePythSymbols(await (dependencies.fetchCatalog??fetchOfficialCatalog)());
    const prepared=preparePythPublication(snapshot,m,catalog,clock());
    snapshotHash=prepared.snapshotHash;requestId=`${prepared.request.id}-${owner}`;
    const attemptId=requestId;
    const params=db.transaction(()=>{
      const now=clock(),lease=db.query("SELECT owner,expires_at FROM pyth_runtime_locks WHERE id=?").get(leaseId) as {owner:string;expires_at:number}|null;
      if(!lease||lease.owner!==leaseOwner||lease.expires_at<=now)throw new Error("Pyth publisher lease expired before submission");
      const fresh=prepared.request.params.filter(update=>{
        const previous=db.query("SELECT last_attempted_timestamp FROM pyth_submission_state WHERE publisher=? AND feed_id=?").get(publisher,update.feed_id) as {last_attempted_timestamp:number}|null;
        return !previous||update.source_timestamp>previous.last_attempted_timestamp;
      });
      for(const update of fresh)db.query("INSERT INTO pyth_submission_state(publisher,feed_id,last_attempted_timestamp,last_queued_timestamp,last_attempt_id,last_status,updated_at) VALUES(?,?,?,0,?,'DELIVERY_UNCONFIRMED',?) ON CONFLICT(publisher,feed_id) DO UPDATE SET last_attempted_timestamp=excluded.last_attempted_timestamp,last_attempt_id=excluded.last_attempt_id,last_status=excluded.last_status,updated_at=excluded.updated_at").run(publisher,update.feed_id,update.source_timestamp,attemptId,now);
      return fresh;
    })();
    if(!params.length)return {status:"NO_NEW_SOURCE_DATA",feeds:[],snapshotHash};
    attempted=params.map(update=>({feedId:update.feed_id,sourceTimestamp:update.source_timestamp}));
    const receipt:PythQueueReceipt=await (dependencies.submit??submitToPythAgent)({...prepared,request:{...prepared.request,id:attemptId,params}},m.agentUrl,5000);
    if(receipt.status!=="QUEUED_LOCAL"||receipt.requestId!==attemptId||receipt.snapshotHash!==snapshotHash||!Number.isSafeInteger(receipt.queuedAt)||receipt.queuedAt<=0)throw new Error("Invalid local Pyth queue receipt");
    db.transaction(()=>{
      for(const update of attempted)db.query("UPDATE pyth_submission_state SET last_queued_timestamp=MAX(last_queued_timestamp,?),last_status=CASE WHEN last_attempt_id=? THEN 'QUEUED_LOCAL' ELSE last_status END,updated_at=MAX(updated_at,?) WHERE publisher=? AND feed_id=?").run(update.sourceTimestamp,attemptId,receipt.queuedAt,publisher,update.feedId);
      db.query("INSERT INTO pyth_queue_receipts(request_id,snapshot_hash,queued_at,feeds) VALUES(?,?,?,?)").run(attemptId,snapshotHash!,receipt.queuedAt,JSON.stringify(attempted));
      // Keep only bounded operational receipts; durable per-feed high-water marks are not pruned.
      db.query("DELETE FROM pyth_queue_receipts WHERE request_id NOT IN (SELECT request_id FROM pyth_queue_receipts ORDER BY queued_at DESC,request_id DESC LIMIT 1000)").run();
    })();
    return {status:"QUEUED_LOCAL",feeds:attempted,requestId:attemptId,snapshotHash,queuedAt:receipt.queuedAt};
  } catch(error) {
    const report:PythRuntimeReport={status:attempted.length?"DELIVERY_UNCONFIRMED":"BLOCKED",feeds:attempted,error:error instanceof Error?error.message:"Pyth runtime failure"};
    if(requestId!==undefined)report.requestId=requestId;
    if(snapshotHash!==undefined)report.snapshotHash=snapshotHash;
    return report;
  } finally {
    if(lockId!==undefined&&owner!==undefined)db.query("DELETE FROM pyth_runtime_locks WHERE id=? AND owner=?").run(lockId,owner);
  }
}
