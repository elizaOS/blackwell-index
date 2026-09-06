import { randomUUID } from "node:crypto";
import { CollectionError } from "./collectors/http";
import type { Journal } from "./journal";
import type { CollectorContext } from "./types";

// Protocol references: https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3
// and https://www.rfc-editor.org/rfc/rfc6585.html#section-4. Test fixtures are not production data.

export const COLLECTION_CONTROL_LIMITS = Object.freeze({
  fallbackBaseMs: 60_000, fallbackMaximumMs: 3_600_000, minimumRetryMs: 1000,
  fetchTimeoutMs: 30_000, requestLeaseMs: 60_000, maximumFailures: 16,
  maximumCollectors: 256, maximumTimestamp: 8_640_000_000_000_000,
});
export type CollectionScheduleCode = "READY" | "HTTP_429_BACKOFF" | "HTTP_503_BACKOFF" | "COLLECTOR_BUSY" | "CLOCK_ROLLBACK";
export interface CollectionSchedule {
  collectorId: string;
  eligible: boolean;
  code: CollectionScheduleCode;
  nextAttemptAt: number | null;
  failures: number;
}
interface State {
  collector_id: string; next_attempt_at: number; failures: number; reason: "HTTP_429_BACKOFF" | "HTTP_503_BACKOFF" | "READY";
  last_seen_at: number; version: number; lease_owner: string | null; lease_until: number;
}

function initialize(journal:Journal):void {
  journal.db.exec("CREATE TABLE IF NOT EXISTS collector_schedules (collector_id TEXT PRIMARY KEY, next_attempt_at INTEGER NOT NULL, failures INTEGER NOT NULL, reason TEXT NOT NULL, last_seen_at INTEGER NOT NULL, version INTEGER NOT NULL, lease_owner TEXT, lease_until INTEGER NOT NULL)");
}
function validate(collectorId:string,now:number):void {
  if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(collectorId))throw new Error("INVALID_COLLECTOR_ID");
  if(!Number.isSafeInteger(now)||now<=0||now>COLLECTION_CONTROL_LIMITS.maximumTimestamp-COLLECTION_CONTROL_LIMITS.requestLeaseMs)throw new Error("INVALID_COLLECTOR_CLOCK");
}
function read(journal:Journal,collectorId:string):State|null {
  return journal.db.query("SELECT collector_id,next_attempt_at,failures,reason,last_seen_at,version,lease_owner,lease_until FROM collector_schedules WHERE collector_id=?").get(collectorId) as State|null;
}
function schedule(collectorId:string,row:State|null,now:number):CollectionSchedule {
  const failures=row?.failures??0;
  if(row&&now<row.last_seen_at)return {collectorId,eligible:false,code:"CLOCK_ROLLBACK",nextAttemptAt:Math.max(row.last_seen_at,row.next_attempt_at,row.lease_until),failures};
  if(row&&row.next_attempt_at>now)return {collectorId,eligible:false,code:row.reason==="HTTP_503_BACKOFF"?"HTTP_503_BACKOFF":"HTTP_429_BACKOFF",nextAttemptAt:row.next_attempt_at,failures};
  if(row?.lease_owner&&row.lease_until>now)return {collectorId,eligible:false,code:"COLLECTOR_BUSY",nextAttemptAt:row.lease_until,failures};
  return {collectorId,eligible:true,code:"READY",nextAttemptAt:null,failures};
}

/** Safe for public diagnostics: contains only a configured source ID and scheduling metadata. */
export function collectorSchedule(journal:Journal,collectorId:string,now=Date.now()):CollectionSchedule {
  validate(collectorId,now);initialize(journal);
  return schedule(collectorId,read(journal,collectorId),now);
}

const MONTHS=["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
/** HTTP-date grammar, including the obsolete forms recipients must accept (RFC 9110 §5.6.7). */
function httpDate(raw:string,now:number):number|null {
  let parts=/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/i.exec(raw);
  let day:number,month:number,year:number,hour:number,minute:number,second:number;
  if(parts) {
    day=Number(parts[1]);month=MONTHS.indexOf(parts[2]!.toLowerCase());year=Number(parts[3]);hour=Number(parts[4]);minute=Number(parts[5]);second=Number(parts[6]);
  } else {
    parts=/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/i.exec(raw);
    if(parts) {
      day=Number(parts[1]);month=MONTHS.indexOf(parts[2]!.toLowerCase());hour=Number(parts[4]);minute=Number(parts[5]);second=Number(parts[6]);
      const currentYear=new Date(now).getUTCFullYear();year=Math.floor(currentYear/100)*100+Number(parts[3]);
      if(year>currentYear+50)year-=100;
    } else {
      parts=/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/i.exec(raw);
      if(!parts)return null;
      month=MONTHS.indexOf(parts[1]!.toLowerCase());day=Number(parts[2]);hour=Number(parts[3]);minute=Number(parts[4]);second=Number(parts[5]);year=Number(parts[6]);
    }
  }
  const date=new Date(0);date.setUTCFullYear(year,month,day);date.setUTCHours(hour,minute,second,0);
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month||date.getUTCDate()!==day||date.getUTCHours()!==hour||date.getUTCMinutes()!==minute||date.getUTCSeconds()!==second)return null;
  return date.getTime();
}
function plus(now:number,delay:number):number {
  return Math.min(COLLECTION_CONTROL_LIMITS.maximumTimestamp,now+delay);
}
/** Retry-After is a minimum delay, not a suggestion to truncate to the polling interval. */
function retryDeadline(response:Response,now:number,failures:number):number {
  const raw=response.headers.get("retry-after")?.trim();
  if(raw&&raw.length<=128) {
    if(/^\d+$/.test(raw)) {
      const milliseconds=BigInt(raw)*1000n;
      const room=BigInt(COLLECTION_CONTROL_LIMITS.maximumTimestamp-now);
      return milliseconds>room?COLLECTION_CONTROL_LIMITS.maximumTimestamp:plus(now,Math.max(COLLECTION_CONTROL_LIMITS.minimumRetryMs,Number(milliseconds)));
    }
    const target=httpDate(raw,now);
    if(target!==null) {
      const serverRaw=response.headers.get("date"),serverTime=serverRaw&&serverRaw.length<=128?httpDate(serverRaw.trim(),now):null;
      // Server-relative duration prevents a fast local wall clock from shortening its requested wait.
      const delay=Math.max(target-now,serverTime===null?0:target-serverTime);
      if(delay>0)return plus(now,Math.max(COLLECTION_CONTROL_LIMITS.minimumRetryMs,delay));
    }
  }
  const delay=Math.min(COLLECTION_CONTROL_LIMITS.fallbackMaximumMs,COLLECTION_CONTROL_LIMITS.fallbackBaseMs*2**Math.min(COLLECTION_CONTROL_LIMITS.maximumFailures-1,Math.max(0,failures-1)));
  return plus(now,delay);
}

/**
 * Wrap every request, including SDK requests made through the injected fetch. It never sleeps.
 * A cycle-level status check is optional; the transactional request check is authoritative.
 */
export function controlledCollectorContext(journal:Journal,collectorId:string,context:CollectorContext):CollectorContext {
  validate(collectorId,context.now());initialize(journal);
  return {...context,fetch:async(input,init)=>{
    const now=context.now();validate(collectorId,now);
    const owner=randomUUID();
    const acquired=journal.db.transaction(()=>{
      let row=read(journal,collectorId);
      const current=schedule(collectorId,row,now);
      if(!current.eligible)throw new CollectionError("RATE_LIMITED",`${collectorId} ${current.code}; nextAttemptAt=${current.nextAttemptAt}`);
      if(!row) {
        const count=journal.db.query("SELECT COUNT(*) AS count FROM collector_schedules").get() as {count:number};
        if(count.count>=COLLECTION_CONTROL_LIMITS.maximumCollectors)throw new CollectionError("RATE_LIMITED","Collector scheduling capacity requires review");
        journal.db.query("INSERT INTO collector_schedules(collector_id,next_attempt_at,failures,reason,last_seen_at,version,lease_owner,lease_until) VALUES(?,0,0,'READY',?,0,NULL,0)").run(collectorId,now);
        row=read(journal,collectorId)!;
      }
      journal.db.query("UPDATE collector_schedules SET last_seen_at=?,lease_owner=?,lease_until=? WHERE collector_id=?").run(now,owner,now+COLLECTION_CONTROL_LIMITS.requestLeaseMs,collectorId);
      return {version:row.version};
    })();
    try {
      const originalSignal=init?.signal??(input instanceof Request?input.signal:undefined);
      const timeout=AbortSignal.timeout(COLLECTION_CONTROL_LIMITS.fetchTimeoutMs);
      const signal=originalSignal?AbortSignal.any([originalSignal,timeout]):timeout;
      const response=await context.fetch(input,{...init,signal});
      const receivedAt=context.now();validate(collectorId,receivedAt);
      journal.db.transaction(()=>{
        const row=read(journal,collectorId)!;
        const time=Math.max(receivedAt,row.last_seen_at);
        if(response.status===429||response.status===503) {
          const failures=Math.min(COLLECTION_CONTROL_LIMITS.maximumFailures,row.failures+1),deadline=Math.max(row.next_attempt_at,retryDeadline(response,time,failures));
          journal.db.query("UPDATE collector_schedules SET next_attempt_at=?,failures=?,reason=?,last_seen_at=?,version=version+1 WHERE collector_id=?")
            .run(deadline,failures,response.status===429?"HTTP_429_BACKOFF":"HTTP_503_BACKOFF",time,collectorId);
        } else if(response.ok&&row.lease_owner===owner&&row.version===acquired.version) {
          // A late successful request cannot erase a newer throttle response or another request's lease.
          journal.db.query("UPDATE collector_schedules SET next_attempt_at=0,failures=0,reason='READY',last_seen_at=? WHERE collector_id=?").run(time,collectorId);
        } else if(row.lease_owner===owner)journal.db.query("UPDATE collector_schedules SET last_seen_at=? WHERE collector_id=?").run(time,collectorId);
      })();
      return response;
    } finally {
      journal.db.query("UPDATE collector_schedules SET lease_owner=NULL,lease_until=0 WHERE collector_id=? AND lease_owner=?").run(collectorId,owner);
    }
  }};
}
