import { expect, test } from "bun:test";
import { centralizedDemo, type DemoSnapshot } from "../src/demo";
import { defaultMethodology, defaultRegistry } from "../src/config";
import { generateIdentity } from "../src/crypto";
import type { Observation, Snapshot } from "../src/types";
import { Store } from "../src/store";
import { OracleNode } from "../src/network";
const now=1788723000000, identity=generateIdentity();
const quote=(model:Observation["model"]):Observation=>({schemaVersion:1,provider:"oracle",source:"oracle-public",sku:model,model,region:"us",procurement:"ON_DEMAND",priceBasis:"LIST",tenancy:"EXCLUSIVE",currency:"USD",unit:"USD_PER_GPU_HOUR",price:"2.000000",instancePrice:"16.000000",gpuCount:8,includes:[],availableGpuCount:null,observedAt:now,priceEffectiveAt:null,expiresAt:null,sourceUrl:"https://apexapps.oracle.com/prices",evidenceHash:"a".repeat(64)});
const registry=()=>{const r=defaultRegistry("test");Object.assign(r.providers[0]!.rights,{redistribute:true,derive:true,evidence:"Test-only approval"});return r;};
const inputs=()=> (["B200","B300","GB200","GB300"] as const).map(quote);
test("single operator demo produces prices without oracle or Pyth publication",()=>{const result=centralizedDemo(inputs(),registry(),defaultMethodology(),identity,now);expect(result.feeds.at(-1)?.price).toBe("2.000000");expect(result.publishable).toBe(false);expect(result.pythPublished).toBe(false);expect(result.mode).toBe("CENTRALIZED_DEMO");});
test("collection-only data stays private",()=>{const r=defaultRegistry("test");for(const p of r.providers){p.rights.redistribute=false;p.rights.derive=false;}const result=centralizedDemo(inputs(),r,defaultMethodology(),identity,now);expect(result.feeds.every(f=>f.price===null)).toBe(true);});
test("stale, expired, private and malformed observations never produce prices",()=>{for(const change of [{observedAt:now-900001},{expiresAt:now},{priceScope:"ACCOUNT_SPECIFIC"},{price:"invalid"}]){const result=centralizedDemo(inputs().map(o=>({...o,...change})),registry(),defaultMethodology(),identity,now);expect(result.feeds.every(f=>f.price===null)).toBe(true);}});
test("missing model cannot create a composite",()=>{const result=centralizedDemo(inputs().slice(1),registry(),defaultMethodology(),identity,now);expect(result.feeds.at(-1)?.price).toBeNull();expect(result.feeds.some(f=>f.kind==="MODEL"&&f.price!==null)).toBe(true);});
test("duplicate offers do not increase influence",()=>{const original=inputs();const duplicate=[...original,...original];expect(centralizedDemo(duplicate,registry(),defaultMethodology(),identity,now).feeds).toEqual(centralizedDemo(original,registry(),defaultMethodology(),identity,now).feeds);});
test("expired source approval and unapproved origins are excluded",()=>{const r=registry();r.providers[0]!.rights.expiresAt=now;expect(centralizedDemo(inputs(),r,defaultMethodology(),identity,now).feeds.every(f=>f.price===null)).toBe(true);expect(centralizedDemo(inputs().map(o=>({...o,sourceUrl:"https://example.com"})),registry(),defaultMethodology(),identity,now).feeds.every(f=>f.price===null)).toBe(true);});

test("self-hosted demo serves the latest complete capture without enabling oracle publication",async()=>{
  const store=new Store(":memory:"), r=defaultRegistry("test");
  const node=new OracleNode({identity,registry:r,methodology:defaultMethodology(),store,clock:()=>now});
  const get=(path:string)=>node.handle(new Request(`http://localhost${path}`));
  try {
    const empty=await get("/v1/demo");expect(empty.status).toBe(200);
    expect((await empty.json() as DemoSnapshot).feeds.every(f=>f.price===null)).toBe(true);
    store.capture(inputs().map(o=>({...o,price:"9.000000",instancePrice:"72.000000"})),[],now-1);
    // Hosted and recovered journals split a single cycle across multiple rows.
    store.capture(inputs().slice(0,2),[],now);store.capture(inputs().slice(2),[],now);
    const response=await get("/v1/demo"), demo=await response.json() as DemoSnapshot;
    expect(response.status).toBe(200);expect(demo.feeds.at(-1)?.price).toBe("2.000000");
    expect(demo.mode).toBe("CENTRALIZED_DEMO");expect(demo.publishable).toBe(false);expect(demo.pythPublished).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(demo)).not.toContain("evidenceHash");
    expect(r.providers[0]!.rights.redistribute).toBe(false);
    expect((await get("/v1/ready")).status).toBe(503);
    expect((await (await get("/v1/feeds")).json() as Snapshot).publishable).toBe(false);
    // An empty new cycle must not fall back to historical prices.
    store.capture([],[],now+1);
    expect((await (await get("/v1/demo")).json() as DemoSnapshot).feeds.every(f=>f.price===null)).toBe(true);
  }finally{store.close();}
});

test("shared demo route refuses oversized cycles and excludes expired or disabled sources",async()=>{
  const store=new Store(":memory:"),r=registry();
  const node=new OracleNode({identity,registry:r,methodology:defaultMethodology(),store,clock:()=>now});
  const get=()=>node.handle(new Request("http://localhost/v1/demo"));
  try {
    store.capture(inputs(),[],now);
    r.providers[0]!.rights.expiresAt=now;
    expect((await (await get()).json() as DemoSnapshot).feeds.every(f=>f.price===null)).toBe(true);
    r.providers[0]!.rights.expiresAt=null;r.providers[0]!.rights.collect=false;
    expect((await (await get()).json() as DemoSnapshot).feeds.every(f=>f.price===null)).toBe(true);
    for(let i=0;i<65;i++)store.capture([],[],now+1);
    const response=await get();expect(response.status).toBe(503);
    expect(await response.json() as {error:string}).toEqual({error:"DEMO_CAPTURE_TOO_LARGE"});
  }finally{store.close();}
});
