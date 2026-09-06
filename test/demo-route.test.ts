// Isolated capture fixtures only; no provider requests or production prices.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { centralizedDemo, DEMO_CAPTURE_LIMITS, demoRegistry, latestDemoObservations, latestDemoResponse } from "../src/demo";
import { defaultMethodology, defaultRegistry } from "../src/config";
import { generateIdentity } from "../src/crypto";
import { Store } from "../src/store";
import { ChunkedJournal } from "../src/chunked-journal";
import { OracleNode } from "../src/network";
import type { SqlDriver } from "../src/journal";
import type { Observation } from "../src/types";

const NOW=1788723000000, identity=generateIdentity(), methodology=defaultMethodology();
const quote=(model:Observation["model"]):Observation=>({schemaVersion:1,provider:"oracle",source:"oracle-public",sku:model,model,region:"us",procurement:"ON_DEMAND",priceBasis:"LIST",tenancy:"EXCLUSIVE",currency:"USD",unit:"USD_PER_GPU_HOUR",price:"2.000000",instancePrice:"16.000000",gpuCount:8,includes:[],availableGpuCount:null,observedAt:NOW,priceEffectiveAt:null,expiresAt:null,sourceUrl:"https://apexapps.oracle.com/prices",evidenceHash:"a".repeat(64)});
const inputs=()=> (["B200","B300","GB200","GB300"] as const).map(quote);
const approved=()=>{const registry=defaultRegistry("test");Object.assign(registry.providers[0]!.rights,{redistribute:true,derive:true,evidence:"Isolated operator approval"});return registry;};
function tracked(db:SqlDriver) {
  const payloadReads:number[]=[],metadataRows:number[]=[];
  const driver:SqlDriver={...db,query(sql){const statement=db.query(sql);return {...statement,
    all(...args){const rows=statement.all(...args);if(sql.startsWith("SELECT id,collected_at"))metadataRows.push(rows.length);return rows;},
    get(...args){if(sql.startsWith("SELECT observations"))payloadReads.push(Number(args[0]));return statement.get(...args);},
  };}};
  return {driver,payloadReads,metadataRows};
}

test("local demo route works with explicit rights while oracle/Pyth gates stay closed",async()=>{
  const store=new Store(":memory:");try {
    store.capture(inputs(),["private capture diagnostic"],NOW);
    const node=new OracleNode({identity,registry:approved(),methodology,store,clock:()=>NOW});
    const before=store.counts(),response=await node.handle(new Request("https://node.invalid/v1/demo")),text=await response.text(),body=JSON.parse(text);
    expect(response.status).toBe(200);expect(body.mode).toBe("CENTRALIZED_DEMO");expect(body.publishable).toBe(false);expect(body.pythPublished).toBe(false);expect(body.feeds.at(-1).price).toBe("2.000000");
    for(const secret of [identity.privateKeyPem,"private capture diagnostic","evidenceHash","sourceUrl","instancePrice"])expect(text).not.toContain(secret);
    expect(store.counts()).toEqual(before);expect((await node.handle(new Request("https://node.invalid/v1/ready"))).status).toBe(503);
    const oracle=await(await node.handle(new Request("https://node.invalid/v1/feeds"))).json() as {publishable:boolean;feeds:Array<{price:string|null}>};expect(oracle.publishable).toBe(false);expect(oracle.feeds.every(feed=>feed.price===null)).toBe(true);
    expect((await(await node.handle(new Request("https://node.invalid/v1/status"))).json() as {pyth:string}).pyth).toBe("NOT_PUBLISHED");
    expect((await node.handle(new Request("https://node.invalid/v1/demo",{method:"POST"}))).status).toBe(404);
    expect((await node.handle(new Request("https://node.invalid/v1/demo",{method:"HEAD"}))).status).toBe(405);
  }finally{store.close();}
});

test("independent local operators do not inherit hosted demo approvals",async()=>{
  const store=new Store(":memory:");try {
    store.capture(inputs(),[],NOW);const registry=defaultRegistry("test"),node=new OracleNode({identity,registry,methodology,store,clock:()=>NOW});
    const response=await node.handle(new Request("https://node.invalid/v1/demo")),body=await response.json() as {feeds:Array<{price:string|null}>};
    expect(response.status).toBe(200);expect(body.feeds.every(feed=>feed.price===null)).toBe(true);
    const hosted=latestDemoResponse(store.db,demoRegistry(registry),methodology,identity,NOW);expect(hosted.status).toBe(200);expect("feeds" in hosted.body&&hosted.body.feeds.at(-1)?.price).toBe("2.000000");
    expect(registry.providers[0]!.rights.redistribute).toBe(false);
  }finally{store.close();}
});

test("local and chunked journals reproduce the same complete latest cycle",()=>{
  const local=new Store(":memory:"),chunked=new ChunkedJournal(new Database(":memory:") as unknown as SqlDriver);
  try {
    const observations=Array.from({length:200},(_,index)=>({...quote(inputs()[index%4]!.model),sku:"isolated-"+index,includes:Array.from({length:30},(_,part)=>String(part).padEnd(100,"x"))}));
    local.capture(observations,[],NOW);chunked.capture(observations,[],NOW);
    expect(chunked.db.query("SELECT COUNT(*) AS count FROM captures").get()).not.toEqual({count:1});
    expect(latestDemoObservations(chunked.db)).toEqual(observations);expect(latestDemoObservations(local.db)).toEqual(observations);
    expect(latestDemoResponse(chunked.db,approved(),methodology,identity,NOW)).toEqual(latestDemoResponse(local.db,approved(),methodology,identity,NOW));
  }finally{local.close();chunked.close();}
});

test("only the latest contiguous cycle is read, including reused noncontiguous timestamps",()=>{
  const store=new Store(":memory:");try {
    store.capture(inputs(),[],NOW-10);store.capture(inputs(),[],NOW-5);
    const latest=[{...quote("B200"),price:"4.000000",instancePrice:"32.000000"}];store.capture(latest,[],NOW-10);
    expect(latestDemoObservations(store.db)).toEqual(latest);
    expect(latestDemoResponse(store.db,approved(),methodology,identity,NOW).body).toEqual(centralizedDemo(latest,approved(),methodology,identity,NOW));
    const response=latestDemoResponse(store.db,approved(),methodology,identity,NOW);expect("feeds" in response.body&&response.body.feeds.at(-1)?.price).toBeNull();
  }finally{store.close();}
});

test("metadata page and payload reads stay bounded regardless of older malformed history",()=>{
  const store=new Store(":memory:");try {
    const insert=store.db.query("INSERT INTO captures(collected_at,observations,errors) VALUES(?,?,?)");
    store.db.transaction(()=>{for(let index=0;index<1000;index++)insert.run(NOW-1,"old malformed row","[]");})();
    store.capture(inputs().slice(0,2),[],NOW);store.capture(inputs().slice(2),[],NOW);
    const access=tracked(store.db);expect(latestDemoObservations(access.driver)).toEqual(inputs());expect(access.metadataRows).toEqual([65]);expect(access.payloadReads).toEqual([1001,1002]);
  }finally{store.close();}
});

test("64 split rows are complete; a 65th fails before reading any payload",()=>{
  const store=new Store(":memory:");try {
    for(let index=0;index<DEMO_CAPTURE_LIMITS.rows;index++)store.capture([],[],NOW);
    expect(latestDemoObservations(store.db)).toEqual([]);store.capture([],[],NOW);
    const access=tracked(store.db),response=latestDemoResponse(access.driver,approved(),methodology,identity,NOW);
    expect(response).toEqual({status:503,body:{error:"DEMO_CAPTURE_TOO_LARGE"}});expect(access.payloadReads).toEqual([]);
  }finally{store.close();}
});

test("byte and observation budgets reject whole cycles without returning partial prices",()=>{
  for(const kind of ["bytes","observations"] as const) {
    const store=new Store(":memory:");try {
      store.capture(inputs(),[],NOW-1);
      const payload=kind==="bytes"?"["+" ".repeat(DEMO_CAPTURE_LIMITS.bytes)+"]":JSON.stringify(Array(DEMO_CAPTURE_LIMITS.observations+1).fill(null));
      store.db.query("INSERT INTO captures(collected_at,observations,errors) VALUES(?,?,?)").run(NOW,payload,"[]");
      const access=tracked(store.db);expect(latestDemoResponse(access.driver,approved(),methodology,identity,NOW)).toEqual({status:503,body:{error:"DEMO_CAPTURE_TOO_LARGE"}});
      if(kind==="bytes")expect(access.payloadReads).toEqual([]);
    }finally{store.close();}
  }
});

test("malformed latest cycle fails closed with sanitized errors and no history fallback",async()=>{
  for(const payload of ["private-invalid-json","{}","null"]) {
    const store=new Store(":memory:");try {
      store.capture(inputs(),[],NOW-1);store.db.query("INSERT INTO captures(collected_at,observations,errors) VALUES(?,?,?)").run(NOW,payload,"[]");
      const node=new OracleNode({identity,registry:approved(),methodology,store,clock:()=>NOW}),response=await node.handle(new Request("https://node.invalid/v1/demo"));
      expect(response.status).toBe(503);expect(await response.json() as {error:string}).toEqual({error:"DEMO_CAPTURE_INVALID"});
    }finally{store.close();}
  }
});

test("empty latest cycle never backfills older prices",()=>{
  const store=new Store(":memory:");try {
    expect(latestDemoResponse(store.db,approved(),methodology,identity,NOW).status).toBe(200);store.capture(inputs(),[],NOW-1);store.capture([],[],NOW);
    const result=latestDemoResponse(store.db,approved(),methodology,identity,NOW);expect("feeds" in result.body&&result.body.feeds.every(feed=>feed.price===null)).toBe(true);
  }finally{store.close();}
});
