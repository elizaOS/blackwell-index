import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COLLECTION_CONTROL_LIMITS as LIMITS, collectorSchedule, controlledCollectorContext } from "../src/collection-control";
import { Journal } from "../src/journal";
import { Store } from "../src/store";
import { createCollectors } from "../src/collectors";
import type { CollectorContext } from "../src/types";

// All clocks, URLs, responses and credential strings below are isolated synthetic fixtures.
// No real provider, account, browser or timer-driven retry is used by these tests.
const NOW=Date.parse("2026-09-06T12:00:00Z"),URL_FIXTURE="https://provider.example.test/prices";
function fixture(handler:CollectorContext["fetch"]) {
  let at=NOW,calls=0;
  const context:CollectorContext={now:()=>at,env:{API_KEY:"private-test-only-value"},fetch:async(input,init)=>{calls++;return handler(input,init);},archive:async()=>{throw new Error("The scheduler must not archive responses");}};
  return {context,at:(value:number)=>{at=value;},calls:()=>calls};
}
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

describe("durable collector scheduling",()=>{
  test("429 delay-seconds prevents mid-cycle requests and preserves response and credential bytes",async()=>{
    const store=new Store(":memory:");let result=429;
    const f=fixture(async(_input,init)=>{
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-test-only-value");
      return new Response("private-test-response-body",{status:result,headers:{"Retry-After":"600"}});
    });
    const context=controlledCollectorContext(store,"provider-a",f.context),request={headers:{Authorization:"Bearer private-test-only-value"}};
    try {
      expect(context.env).toBe(f.context.env);expect(context.archive).toBe(f.context.archive);
      expect(await (await context.fetch(URL_FIXTURE,request)).text()).toBe("private-test-response-body");
      expect(collectorSchedule(store,"provider-a",NOW)).toEqual({collectorId:"provider-a",eligible:false,code:"HTTP_429_BACKOFF",nextAttemptAt:NOW+600_000,failures:1});
      await expect(context.fetch(`${URL_FIXTURE}?page=2`,request)).rejects.toThrow("RATE_LIMITED: provider-a HTTP_429_BACKOFF");
      f.at(NOW+599_999);await expect(context.fetch(URL_FIXTURE,request)).rejects.toThrow("nextAttemptAt=");
      expect(f.calls()).toBe(1);
      const stored=JSON.stringify(store.db.query("SELECT * FROM collector_schedules").all());
      for(const secret of ["private-test-only-value","private-test-response-body",URL_FIXTURE,"Authorization","Retry-After"])expect(stored).not.toContain(secret);
      result=200;f.at(NOW+600_000);expect((await context.fetch(URL_FIXTURE,request)).status).toBe(200);
      expect(collectorSchedule(store,"provider-a",NOW+600_000)).toEqual({collectorId:"provider-a",eligible:true,code:"READY",nextAttemptAt:null,failures:0});
    }finally{store.close();}
  });

  test("503 accepts all HTTP date forms without shortening a valid delay",async()=>{
    for(const header of ["Sun, 06 Sep 2026 13:00:00 GMT","Sunday, 06-Sep-26 13:00:00 GMT","Sun Sep  6 13:00:00 2026"]) {
      const store=new Store(":memory:"),f=fixture(async()=>new Response(null,{status:503,headers:{"Retry-After":header}}));
      try {
        await controlledCollectorContext(store,"provider-a",f.context).fetch(URL_FIXTURE);
        expect(collectorSchedule(store,"provider-a",NOW)).toEqual({collectorId:"provider-a",eligible:false,code:"HTTP_503_BACKOFF",nextAttemptAt:NOW+3_600_000,failures:1});
      }finally{store.close();}
    }
  });

  test("server-relative dates tolerate a fast local clock conservatively",async()=>{
    const store=new Store(":memory:"),f=fixture(async()=>new Response(null,{status:503,headers:{"Date":"Sun, 06 Sep 2026 11:00:00 GMT","Retry-After":"Sun, 06 Sep 2026 11:10:00 GMT"}}));
    try {
      await controlledCollectorContext(store,"provider-a",f.context).fetch(URL_FIXTURE);
      expect(collectorSchedule(store,"provider-a",NOW).nextAttemptAt).toBe(NOW+600_000);
    }finally{store.close();}
  });

  test("missing, malformed and stale retry dates use bounded fallback backoff",async()=>{
    for(const header of [undefined,"","nonsense","-1","1.5","1e3","Infinity","Sun, 31 Feb 2026 13:00:00 GMT","Sun, 06 Sep 2026 11:00:00 GMT","x".repeat(129)]) {
      const store=new Store(":memory:"),f=fixture(async()=>new Response(null,{status:429,headers:header===undefined?{}:{"Retry-After":header}}));
      try {
        await controlledCollectorContext(store,"provider-a",f.context).fetch(URL_FIXTURE);
        expect(collectorSchedule(store,"provider-a",NOW).nextAttemptAt).toBe(NOW+LIMITS.fallbackBaseMs);
      }finally{store.close();}
    }
  });

  test("fallback increases to its cap, does not reset on 4xx, and resets only after success",async()=>{
    const store=new Store(":memory:");let responseStatus=429,at=NOW;
    const f=fixture(async()=>new Response(null,{status:responseStatus})),context=controlledCollectorContext(store,"provider-a",f.context);
    try {
      for(let failure=1;failure<=20;failure++) {
        f.at(at);await context.fetch(URL_FIXTURE);
        const state=collectorSchedule(store,"provider-a",at);
        expect(state.failures).toBe(Math.min(failure,LIMITS.maximumFailures));
        expect(state.nextAttemptAt).toBe(at+Math.min(LIMITS.fallbackBaseMs*2**(failure-1),LIMITS.fallbackMaximumMs));
        at=state.nextAttemptAt!;
      }
      responseStatus=403;f.at(at);await context.fetch(URL_FIXTURE);
      expect(collectorSchedule(store,"provider-a",at).failures).toBe(LIMITS.maximumFailures);
      responseStatus=200;await context.fetch(URL_FIXTURE);
      expect(collectorSchedule(store,"provider-a",at).failures).toBe(0);
      responseStatus=503;await context.fetch(URL_FIXTURE);
      expect(collectorSchedule(store,"provider-a",at).nextAttemptAt).toBe(at+LIMITS.fallbackBaseMs);
    }finally{store.close();}
  });

  test("valid long Retry-After is honored beyond the fallback cap and unsafe magnitude saturates safely",async()=>{
    for(const [header,delay] of [["172800",172_800_000],["0",LIMITS.minimumRetryMs],["9".repeat(128),LIMITS.maximumTimestamp-NOW]] as const) {
      const store=new Store(":memory:"),f=fixture(async()=>new Response(null,{status:429,headers:{"Retry-After":header}}));
      try {
        await controlledCollectorContext(store,"provider-a",f.context).fetch(URL_FIXTURE);
        const next=collectorSchedule(store,"provider-a",NOW).nextAttemptAt!;
        expect(next).toBe(NOW+delay);expect(Number.isSafeInteger(next)).toBe(true);expect(next).toBeLessThanOrEqual(LIMITS.maximumTimestamp);
      }finally{store.close();}
    }
  });

  test("a fresh context and database restart preserve the deadline; unrelated providers proceed",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"sbx-collection-control-")),path=join(directory,"node.sqlite");
    let store=new Store(path);
    const f=fixture(async()=>new Response(null,{status:429,headers:{"Retry-After":"900"}}));
    try {
      await controlledCollectorContext(store,"provider-a",f.context).fetch(URL_FIXTURE);store.close();store=new Store(path);
      const fresh=fixture(async()=>new Response("OK"));
      await expect(controlledCollectorContext(store,"provider-a",fresh.context).fetch(URL_FIXTURE)).rejects.toThrow("RATE_LIMITED");
      expect(fresh.calls()).toBe(0);
      expect((await controlledCollectorContext(store,"provider-b",fresh.context).fetch(URL_FIXTURE)).status).toBe(200);
      expect(fresh.calls()).toBe(1);expect(collectorSchedule(store,"provider-a",NOW).nextAttemptAt).toBe(NOW+900_000);
    }finally{store.close();await rm(directory,{recursive:true,force:true});}
  });

  test("clock rollback never makes a previously deferred request eligible",async()=>{
    const store=new Store(":memory:"),f=fixture(async()=>new Response(null,{status:429,headers:{"Retry-After":"60"}})),context=controlledCollectorContext(store,"provider-a",f.context);
    try {
      await context.fetch(URL_FIXTURE);f.at(NOW-86_400_000);
      expect(collectorSchedule(store,"provider-a",NOW-86_400_000)).toEqual({collectorId:"provider-a",eligible:false,code:"CLOCK_ROLLBACK",nextAttemptAt:NOW+60_000,failures:1});
      await expect(context.fetch(URL_FIXTURE)).rejects.toThrow("CLOCK_ROLLBACK");expect(f.calls()).toBe(1);
      f.at(NOW+59_999);expect(collectorSchedule(store,"provider-a",NOW+59_999).eligible).toBe(false);
      expect(()=>collectorSchedule(store,"provider-a",NaN)).toThrow("INVALID_COLLECTOR_CLOCK");
      expect(()=>collectorSchedule(store,"provider-a",Number.MAX_SAFE_INTEGER)).toThrow("INVALID_COLLECTOR_CLOCK");
    }finally{store.close();}
  });

  test("concurrent contexts serialize same-collector requests but never wait or block other collectors",async()=>{
    const store=new Store(":memory:"),pending=deferred<Response>(),f=fixture(async()=>pending.promise);
    const first=controlledCollectorContext(store,"provider-a",f.context),second=controlledCollectorContext(store,"provider-a",f.context);
    try {
      const running=first.fetch(URL_FIXTURE);
      await expect(second.fetch(URL_FIXTURE)).rejects.toThrow("COLLECTOR_BUSY");expect(f.calls()).toBe(1);
      const independent=fixture(async()=>new Response(null,{status:200}));
      expect((await controlledCollectorContext(store,"provider-b",independent.context).fetch(URL_FIXTURE)).status).toBe(200);
      pending.resolve(new Response(null,{status:429,headers:{"Retry-After":"60"}}));await running;
      await expect(second.fetch(URL_FIXTURE)).rejects.toThrow("HTTP_429_BACKOFF");expect(f.calls()).toBe(1);
    }finally{store.close();}
  });

  test("a late success after lease expiry cannot erase a newer throttle",async()=>{
    const store=new Store(":memory:"),pending=deferred<Response>();let sequence=0;
    const f=fixture(async()=>sequence++===0?pending.promise:new Response(null,{status:503,headers:{"Retry-After":"600"}})),context=controlledCollectorContext(store,"provider-a",f.context);
    try {
      const old=context.fetch(URL_FIXTURE);f.at(NOW+LIMITS.requestLeaseMs+1);
      await context.fetch(URL_FIXTURE);
      const expected=collectorSchedule(store,"provider-a",f.context.now());
      pending.resolve(new Response(null,{status:200}));await old;
      expect(collectorSchedule(store,"provider-a",f.context.now())).toEqual(expected);
    }finally{store.close();}
  });

  test("a late throttle fences the newer in-flight success and retains its deadline",async()=>{
    const store=new Store(":memory:"),oldPending=deferred<Response>(),newPending=deferred<Response>();let sequence=0;
    const f=fixture(async()=>sequence++===0?oldPending.promise:newPending.promise),context=controlledCollectorContext(store,"provider-a",f.context);
    try {
      const old=context.fetch(URL_FIXTURE);f.at(NOW+LIMITS.requestLeaseMs+1);const newer=context.fetch(URL_FIXTURE);
      oldPending.resolve(new Response(null,{status:429,headers:{"Retry-After":"120"}}));await old;
      const expected=collectorSchedule(store,"provider-a",f.context.now());
      newPending.resolve(new Response(null,{status:200}));await newer;
      expect(collectorSchedule(store,"provider-a",f.context.now())).toEqual(expected);
      await expect(context.fetch(URL_FIXTURE)).rejects.toThrow("HTTP_429_BACKOFF");
    }finally{store.close();}
  });

  test("transport errors release the lease, preserve cancellation, and store no exception text",async()=>{
    const store=new Store(":memory:"),abort=new AbortController();abort.abort();
    const f=fixture(async(_input,init)=>{expect(init?.signal?.aborted).toBe(true);throw new Error("sensitive-test-exception");});
    try {
      await expect(controlledCollectorContext(store,"provider-a",f.context).fetch(new Request(URL_FIXTURE,{signal:abort.signal}))).rejects.toThrow("sensitive-test-exception");
      expect(collectorSchedule(store,"provider-a",NOW).eligible).toBe(true);
      expect(JSON.stringify(store.db.query("SELECT * FROM collector_schedules").all())).not.toContain("sensitive-test-exception");
    }finally{store.close();}
  });

  test("shared SQL-driver interface does not depend on Bun statement return values",async()=>{
    const backing=new Store(":memory:");
    const portable=new Journal({
      exec:sql=>{backing.db.exec(sql);return [];},
      query:sql=>{const statement=backing.db.query(sql);return {run:(...values)=>{statement.run(...values);return undefined;},get:(...values)=>statement.get(...values),all:(...values)=>statement.all(...values),iterate:(...values)=>statement.all(...values)};},
      transaction:callback=>()=>backing.db.transaction(callback)(),close:()=>{},
    });
    const f=fixture(async()=>new Response(null,{status:429,headers:{"Retry-After":"30"}}));
    try {
      await controlledCollectorContext(portable,"provider-a",f.context).fetch(URL_FIXTURE);
      expect(collectorSchedule(portable,"provider-a",NOW).nextAttemptAt).toBe(NOW+30_000);
    }finally{backing.close();}
  });

  test("AWS SDK requests use the same durable gate through the injected fetch handler",async()=>{
    const store=new Store(":memory:"),f=fixture(async()=>new Response("temporary-test-outage",{status:503,headers:{"Retry-After":"600"}}));
    f.context.env={AWS_ACCESS_KEY_ID:"test-access-only",AWS_SECRET_ACCESS_KEY:"test-secret-only"};
    const context=controlledCollectorContext(store,"aws-pricing",f.context),aws=createCollectors(["aws-pricing"])[0]!;
    try {
      expect((await aws.collect(context)).errors[0]).toContain("HTTP_ERROR");
      expect(collectorSchedule(store,"aws-pricing",NOW).nextAttemptAt).toBe(NOW+600_000);
      expect((await aws.collect(context)).errors[0]).toContain("RATE_LIMITED");
      expect(f.calls()).toBe(1);
      expect(JSON.stringify(store.db.query("SELECT * FROM collector_schedules").all())).not.toContain("test-secret-only");
    }finally{store.close();}
  });

  test("collector keys are bounded and arbitrary IDs cannot grow the schedule table indefinitely",async()=>{
    const store=new Store(":memory:"),f=fixture(async()=>new Response(null,{status:200}));
    try {
      expect(()=>controlledCollectorContext(store,"https://secret.example.test/?token=private",f.context)).toThrow("INVALID_COLLECTOR_ID");
      for(let i=0;i<LIMITS.maximumCollectors;i++)await controlledCollectorContext(store,`test-${i}`,f.context).fetch(URL_FIXTURE);
      await expect(controlledCollectorContext(store,"excess",f.context).fetch(URL_FIXTURE)).rejects.toThrow("scheduling capacity");
      expect(store.db.query("SELECT COUNT(*) AS count FROM collector_schedules").get()).toEqual({count:LIMITS.maximumCollectors});
    }finally{store.close();}
  });
});
