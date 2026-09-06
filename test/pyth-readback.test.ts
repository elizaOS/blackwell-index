// Every ID, key, approval and market value in this file is an isolated test fixture.
import { expect, test } from "bun:test";
import { PYTH_PROTOCOL, PYTH_SYMBOLS_URL, type PythManifest } from "../src/pyth";
import { PYTH_LATEST_PRICE_URL, PYTH_READBACK_LIMITS, pythReadbackConfigSchema, readbackTick, runReadbackMonitor,
  type PythReadbackConfig, type PythReadbackState, type PythReadbackTickOptions, type PythReadbackDependencies } from "../src/pyth/readback";

const NOW=1788700000000,TOKEN="isolated-test-credential-never-public",FEED=41;
const binding={indexFeedId:"TEST.B200",pythFeedId:FEED,symbol:"TEST.B200/USD",exponent:-6,minPublishers:3};
function manifest():PythManifest {return {schemaVersion:1,enabled:true,network:"test",methodologyHash:"a".repeat(64),registryHash:"b".repeat(64),
  agentUrl:"ws://127.0.0.1:8910/v1/jrpc",maxAgeMs:30000,futureToleranceMs:1000,
  approval:{status:"APPROVED",publisherPublicKey:"11111111111111111111111111111111",evidence:"isolated test approval",verifiedAt:NOW-1000,expiresAt:NOW+7200000,protocol:PYTH_PROTOCOL,relayerUrls:["wss://isolated.example.test/v1/transaction"]},bindings:[{...binding}]};}
function config():PythReadbackConfig {return pythReadbackConfigSchema.parse({schemaVersion:1,enabled:true,pollIntervalMs:1000,maxAgeMs:30000,maxConfidenceBps:100,maxPriceDeviationBps:100});}
function catalog(){return [{pyth_lazer_id:FEED,symbol:binding.symbol,exponent:-6,min_publishers:3,state:"stable",min_channel:"fixed_rate@200ms",quote_currency:"USD"}];}
function payload(now=NOW,generated=now-1000):{parsed:{timestampUs:string;priceFeeds:Record<string,unknown>[]}} {return {parsed:{timestampUs:String(now*1000),priceFeeds:[{priceFeedId:FEED,price:"5125000",confidence:10000,exponent:-6,publisherCount:3,feedUpdateTimestamp:generated*1000,marketSession:"regular"}]}};}
function json(value:unknown,status=200,headers:Record<string,string>={}) {return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json",...headers}});}
function fixture() {
  let now=NOW,upstream:unknown=payload(),metadata:unknown=catalog();
  const writes:PythReadbackState[]=[],requests:Array<{url:string;init:RequestInit|undefined}>=[];
  const options:PythReadbackTickOptions={configuration:config(),manifest:manifest(),expectedPrints:[{feedId:FEED,price:"5.125",sourceTimestampUs:String((NOW-2000)*1000)}],
    env:{PYTH_PRO_API_KEY:TOKEN},persistState:state=>{writes.push(structuredClone(state));}};
  const deps:PythReadbackDependencies={now:()=>now,fetch:(async(input,init)=>{
    const url=String(input);requests.push({url,init});
    if(url===PYTH_SYMBOLS_URL)return json(metadata);
    if(url===PYTH_LATEST_PRICE_URL)return json(upstream);
    throw new Error("Unexpected test request");
  }) as typeof fetch};
  return {options,deps,writes,requests,setTime:(value:number)=>{now=value;},setPayload:(value:unknown)=>{upstream=value;},setCatalog:(value:unknown)=>{metadata=value;}};
}

// Isolated EVM wire and RPC responses. No real signatures or market values.
function signedFixture(failSecond=false) {
  const f=fixture(),m=manifest();m.bindings.push({...binding,pythFeedId:42,indexFeedId:'TEST.B300',symbol:'TEST.B300/USD'});
  f.options.manifest=m;
  f.options.configuration={...config(),maxFeedsPerRequest:1,signedEvm:{network:'base',simulationFrom:'0x'+'1'.repeat(40)}};
  f.options.expectedPrints=[...(f.options.expectedPrints??[]),{feedId:42,price:'5.125',sourceTimestampUs:String((NOW-2000)*1000)}];
  const word=(n:bigint)=>n.toString(16).padStart(64,'0'),rpcRequests:any[]=[];
  let feedId=41,body='';
  f.deps.fetch=(async(input,init)=>{
    const url=String(input);f.requests.push({url,init});
    if(url===PYTH_SYMBOLS_URL)return json(m.bindings.map(b=>({...catalog()[0],pyth_lazer_id:b.pythFeedId,symbol:b.symbol})));
    const q=JSON.parse(String(init?.body));
    if(url===PYTH_LATEST_PRICE_URL) {
      feedId=q.priceFeedIds[0];
      body='93c7d375'+word(BigInt(NOW)*1000n).slice(-16)+'0401'+feedId.toString(16).padStart(8,'0')+'05'+'00'+word(5125000n).slice(-16)+'03'+'0003'+'04'+'fffa'+'05'+word(10000n).slice(-16)+'0c01'+word(BigInt(NOW-1000)*1000n).slice(-16);
      return json({evm:{encoding:'hex',data:'2a22999a'+'01'.repeat(65)+(body.length/2).toString(16).padStart(4,'0')+body},parsed:{timestampUs:'0',priceFeeds:[]}});
    }
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    rpcRequests.push(q);let result:unknown;
    if(q.method==='eth_chainId')result='0x2105';
    else if(q.method==='eth_getBlockByNumber')result={number:'0x123',hash:'0x'+'a'.repeat(64),timestamp:'0x'+Math.floor(NOW/1000).toString(16)};
    else if(q.method==='eth_getCode')result='0x6000';
    else if(q.method==='eth_getBalance')result='0x10';
    else if(q.method==='eth_call') {
      if(q.params[0].data==='0x54fd4d50')result='0x'+word(32n)+word(5n)+Buffer.from('0.1.1').toString('hex').padEnd(64,'0');
      else if(q.params[0].data==='0xbac12f87')result='0x'+word(1n);
      else if(failSecond&&feedId===42)return json({jsonrpc:'2.0',id:q.id,error:{code:3,message:'isolated rejection'}});
      else result='0x'+word(64n)+'0'.repeat(24)+'01'.repeat(20)+word(BigInt(body.length/2))+body.padEnd(Math.ceil(body.length/64)*64,'0');
    } else throw Error('unexpected isolated request');
    return json({jsonrpc:'2.0',id:q.id,result});
  }) as typeof fetch;
  return {...f,rpcRequests};
}

test('signed readback verifies both batches and persists only contract-returned prices',async()=>{
  const f=signedFixture(),report=await readbackTick(f.options,f.deps);
  expect(report.status).toBe('UPSTREAM_OBSERVED');expect(report.signatureVerification).toBe('CONTRACT_ACCEPTED_SINGLE_RPC');
  expect(report.state?.feeds.map(feed=>feed.feedId)).toEqual([41,42]);expect(f.writes).toHaveLength(1);
  expect(f.rpcRequests).toHaveLength(22);expect(JSON.stringify(report)).not.toContain(TOKEN);
});

test('a rejected second signed batch cannot persist the first verified timestamp',async()=>{
  const f=signedFixture(true),report=await readbackTick(f.options,f.deps);
  expect(report.status).toBe('DEGRADED');expect(report.code).toBe('SIGNED_VERIFICATION_FAILED');
  expect(report.signatureVerification).toBe('NOT_PERFORMED');expect(report.state?.feeds).toEqual([]);
  expect(f.writes).toHaveLength(1);expect(f.writes[0]!.feeds).toEqual([]);
});

test('signed policy failure after restart retains all previously accepted timestamps',async()=>{
  const f=signedFixture(),first=await readbackTick(f.options,f.deps);
  expect(first.status).toBe('UPSTREAM_OBSERVED');
  const prior=structuredClone(first.state!);prior.nextAttemptAt=NOW;
  f.options.state=prior;
  f.options.expectedPrints=f.options.expectedPrints!.map(value=>value.feedId===42?{...value,price:'999'}:value);
  const second=await readbackTick(f.options,f.deps);
  expect(second.code).toBe('SIGNED_POLICY_FAILED');expect(second.signatureVerification).toBe('NOT_PERFORMED');
  expect(second.state!.feeds).toEqual(prior.feeds);expect(f.writes[1]!.feeds).toEqual(prior.feeds);
  expect(second.state!.consecutiveFailures).toBe(1);
});

test('signed verification never reports durable acceptance when persistence rejects',async()=>{
  const f=signedFixture();f.options.persistState=()=>{throw Error('private storage detail');};
  const report=await readbackTick(f.options,f.deps);
  expect(report.status).toBe('PERSISTENCE_FAILED');expect(report.signatureVerification).toBe('NOT_PERFORMED');
  expect(report.state).toBeUndefined();expect(JSON.stringify(report)).not.toContain('private storage detail');
});

test('switching an existing unsigned watermark database to signed mode requires explicit scope review',async()=>{
  const f=fixture(),first=await readbackTick(f.options,f.deps),count=f.requests.length;
  f.options.state=first.state;f.options.configuration={...config(),signedEvm:{network:'base',simulationFrom:'0x'+'1'.repeat(40)}};
  const report=await readbackTick(f.options,f.deps);
  expect(report.code).toBe('STATE_SCOPE_REVIEW_REQUIRED');expect(f.requests).toHaveLength(count);
});

test('signed verification rechecks approval after the RPC returns',async()=>{
  const f=signedFixture();(f.options.manifest as PythManifest).approval.expiresAt=NOW+1000;
  const request=f.deps.fetch!;
  f.deps.fetch=(async(input,init)=>{
    const response=await request(input,init);
    if(String(input)!==PYTH_LATEST_PRICE_URL&&init?.body&&JSON.parse(String(init.body)).id===102)f.setTime(NOW+1001);
    return response;
  }) as typeof fetch;
  const report=await readbackTick(f.options,f.deps);
  expect(report.code).toBe('APPROVAL_EXPIRED');expect(report.state?.feeds).toEqual([]);
  expect(report.signatureVerification).toBe('NOT_PERFORMED');
});

test('late signed verification cannot accept stale early batch timestamps',async()=>{
  const f=signedFixture(),request=f.deps.fetch!;let verified=0;
  f.deps.fetch=(async(input,init)=>{
    const response=await request(input,init);
    if(String(input)!==PYTH_LATEST_PRICE_URL&&init?.body&&JSON.parse(String(init.body)).id===102&&++verified===2)f.setTime(NOW+31000);
    return response;
  }) as typeof fetch;
  const report=await readbackTick(f.options,f.deps);
  expect(report.code).toBe('ENVELOPE_CLOCK_INVALID');expect(report.state?.feeds).toEqual([]);
  expect(report.signatureVerification).toBe('NOT_PERFORMED');
});

test('cumulative RPC bytes across signed batches exhaust the shared tick budget without partial acceptance',async()=>{
  const f=signedFixture(),request=f.deps.fetch!;
  f.deps.fetch=(async(input,init)=>{
    const response=await request(input,init);
    if(String(input)===PYTH_SYMBOLS_URL||String(input)===PYTH_LATEST_PRICE_URL)return response;
    // Valid JSON padded below the per-response limit; only the aggregate budget
    // can reject these otherwise valid preflight and verification responses.
    return new Response((await response.text()).padEnd(900000,' '),{headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  const report=await readbackTick(f.options,f.deps);
  expect(f.rpcRequests.length).toBeGreaterThan(11);
  expect(f.rpcRequests.length).toBeLessThan(22);
  expect(report.status).toBe('DEGRADED');expect(report.code).toBe('SIGNED_VERIFICATION_FAILED');
  expect(report.state?.feeds).toEqual([]);expect(f.writes).toHaveLength(1);expect(f.writes[0]!.feeds).toEqual([]);
});

test("disabled, missing approval, missing token and missing persistence perform no network requests",async()=>{
  const f=fixture();f.options.configuration={...config(),enabled:false};expect((await readbackTick(f.options,f.deps)).status).toBe("DISABLED");
  f.options.configuration=config();f.options.manifest=null;expect((await readbackTick(f.options,f.deps)).status).toBe("NOT_CONFIGURED");
  const pending=manifest();pending.approval.status="PENDING";f.options.manifest=pending;expect((await readbackTick(f.options,f.deps)).code).toBe("APPROVAL_REQUIRED");
  f.options.manifest=manifest();f.options.env={};expect((await readbackTick(f.options,f.deps)).code).toBe("CONSUMER_TOKEN_REQUIRED");
  f.options.env={PYTH_PRO_API_KEY:TOKEN};f.options.persistState=undefined as never;expect((await readbackTick(f.options,f.deps)).status).toBe("PERSISTENCE_FAILED");
  expect(f.requests).toHaveLength(0);expect(f.writes).toHaveLength(0);
});

test('signed mode never falls back to unsigned parsed data or advances timestamps without an EVM payload',async()=>{
  const f=fixture();f.options.configuration={...config(),signedEvm:{network:'base',simulationFrom:'0x'+'1'.repeat(40)}};
  const report=await readbackTick(f.options,f.deps);
  expect(report.code).toBe('SIGNED_PAYLOAD_MISSING');expect(report.status).toBe('DEGRADED');
  expect(report.signatureVerification).toBe('NOT_PERFORMED');expect(report.state?.feeds).toEqual([]);
  const body=JSON.parse(String(f.requests[1]!.init!.body));
  expect(body.formats).toEqual(['evm']);expect(body.parsed).toBe(false);expect(body.jsonBinaryEncoding).toBe('hex');
  expect(body.properties).not.toContain('marketSession');
});

test("uses the exact REST schema and backend bearer token, then persists before success",async()=>{
  const f=fixture();let durable=false;f.options.persistState=async state=>{await Promise.resolve();f.writes.push(state);durable=true;};
  const report=await readbackTick(f.options,f.deps);
  expect(report.status).toBe("UPSTREAM_OBSERVED");expect(durable).toBe(true);expect(report.bootstrap).toBe(true);
  expect(report.feeds[0]?.status).toBe("ADVANCED");expect(f.requests.map(item=>item.url)).toEqual([PYTH_SYMBOLS_URL,PYTH_LATEST_PRICE_URL]);
  const request=f.requests[1]!.init!;
  expect(request.method).toBe("POST");expect(request.redirect).toBe("error");expect(new Headers(request.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  expect(new Headers(f.requests[0]!.init?.headers).has("authorization")).toBe(false);
  expect(JSON.parse(request.body as string)).toEqual({priceFeedIds:[FEED],properties:["price","confidence","exponent","publisherCount","feedUpdateTimestamp","marketSession"],formats:[],parsed:true,channel:"fixed_rate@1000ms"});
  expect(report.publisherAttribution).toBe("NOT_ESTABLISHED");expect(report.signatureVerification).toBe("NOT_PERFORMED");expect(report.onchainVerification).toBe("NOT_PERFORMED");
  expect(JSON.stringify(report)+JSON.stringify(f.writes)).not.toContain(TOKEN);expect(JSON.stringify(f.writes)).not.toContain("5125000");
});

test("numeric and canonical-string integer representations normalize identically",async()=>{
  const a=fixture(),b=fixture(),body=payload();body.parsed.priceFeeds[0]!.confidence="10000";body.parsed.priceFeeds[0]!.feedUpdateTimestamp=String((NOW-1000)*1000);b.setPayload(body);
  const first=await readbackTick(a.options,a.deps),second=await readbackTick(b.options,b.deps);
  expect(first.state?.feeds).toEqual(second.state?.feeds);
});

test("fresh carried values are UNCHANGED, not a new publication; new generation time advances",async()=>{
  const f=fixture(),first=await readbackTick(f.options,f.deps);f.options.state=first.state;f.setTime(NOW+1000);
  const carried=payload(NOW+1000,NOW-1000);carried.parsed.priceFeeds[0]!.marketSession="closed";f.setPayload(carried);
  const second=await readbackTick(f.options,f.deps);expect(second.status).toBe("UNCHANGED");expect(second.bootstrap).toBe(false);
  f.options.state=second.state;f.setTime(NOW+2000);f.setPayload(payload(NOW+2000,NOW+1000));
  expect((await readbackTick(f.options,f.deps)).status).toBe("UPSTREAM_OBSERVED");
});

test("rollback and same-generation conflicts never replace the last verified watermark",async()=>{
  for(const conflict of [false,true]) {
    const f=fixture(),first=await readbackTick(f.options,f.deps);f.options.state=first.state;f.setTime(NOW+1000);
    const body=payload(NOW+1000,conflict?NOW-1000:NOW-1500);if(conflict)body.parsed.priceFeeds[0]!.price="5126000";f.setPayload(body);
    const next=await readbackTick(f.options,f.deps);expect(next.status).toBe("DEGRADED");expect(next.feeds[0]?.status).toBe(conflict?"SAME_TIMESTAMP_CONFLICT":"FEED_TIMESTAMP_ROLLBACK");
    expect(next.state?.feeds).toEqual(first.state?.feeds);
  }
});

test("fresh envelope timestamps cannot hide stale feed generation or stale expected source data",async()=>{
  const stale=fixture();stale.setPayload(payload(NOW,NOW-30001));expect((await readbackTick(stale.options,stale.deps)).feeds[0]?.status).toBe("PRICE_STALE");
  const expected=fixture();expected.options.expectedPrints=[{feedId:FEED,price:"5.125",sourceTimestampUs:String((NOW-30001)*1000)}];
  expect((await readbackTick(expected.options,expected.deps)).feeds[0]?.status).toBe("EXPECTED_PRINT_STALE");
  const pending=fixture();pending.options.expectedPrints=[{feedId:FEED,price:"5.125",sourceTimestampUs:String(NOW*1000)}];
  expect((await readbackTick(pending.options,pending.deps)).feeds[0]?.status).toBe("AWAITING_EXPECTED_PRINT");
});

test("missing and excessive-confidence prices, low publisher counts, units and expected prices fail closed",async()=>{
  for(const [field,value,status] of [["price",null,"PRICE_UNAVAILABLE"],["price","0","PRICE_INVALID"],["publisherCount",2,"INSUFFICIENT_PUBLISHERS"],["exponent",-8,"FEED_IDENTITY_MISMATCH"],["price","6125000","PRICE_MISMATCH"],["confidence",1000000,"CONFIDENCE_EXCEEDED"],["feedUpdateTimestamp",(NOW+1)*1000,"FEED_CLOCK_INVALID"]] as const) {
    const f=fixture(),body=payload();body.parsed.priceFeeds[0]![field]=value;f.setPayload(body);
    const report=await readbackTick(f.options,f.deps);expect(report.status).toBe("DEGRADED");expect(report.feeds[0]?.status).toBe(status);expect(report.state?.feeds).toHaveLength(0);
  }
  const f=fixture();f.options.expectedPrints=[];expect((await readbackTick(f.options,f.deps)).feeds[0]?.status).toBe("EXPECTED_PRINT_MISSING");
});

test("integer precision loss, noncanonical strings and malformed API envelopes are rejected",async()=>{
  for(const value of [Number.MAX_SAFE_INTEGER+1,"01","1e6","-1","18446744073709551616",{},NaN]) {
    const f=fixture(),body=payload();body.parsed.priceFeeds[0]!.feedUpdateTimestamp=value;f.setPayload(body);
    expect((await readbackTick(f.options,f.deps)).status).toBe("DEGRADED");expect(f.writes[0]?.feeds).toHaveLength(0);
  }
  for(const value of [{},{parsed:null},{parsed:{timestampUs:String((NOW+1)*1000),priceFeeds:[]}},{parsed:{timestampUs:String((NOW-30001)*1000),priceFeeds:[]}}]) {
    const f=fixture();f.setPayload(value);const report=await readbackTick(f.options,f.deps);expect(report.status).toBe("DEGRADED");expect(report.state?.feeds).toHaveLength(0);
  }
});

test("foreign and duplicate feed IDs reject the whole response; absent requested feeds remain unavailable",async()=>{
  for(const duplicate of [true,false]) {
    const f=fixture(),body=payload();if(duplicate)body.parsed.priceFeeds.push({...body.parsed.priceFeeds[0]});else body.parsed.priceFeeds[0]!.priceFeedId=99;f.setPayload(body);
    expect((await readbackTick(f.options,f.deps)).code).toBe("RESPONSE_FEED_SET_INVALID");
  }
  const f=fixture(),body=payload();body.parsed.priceFeeds=[];f.setPayload(body);
  expect((await readbackTick(f.options,f.deps)).feeds).toEqual([{feedId:FEED,status:"PRICE_UNAVAILABLE"}]);
});

test("current catalog metadata, currency and channel capability are checked before authenticated queries",async()=>{
  for(const [field,value] of [["exponent",-8],["min_publishers",2],["state","inactive"],["quote_currency","EUR"],["min_channel","fixed_rate@1ms"]] as const) {
    const f=fixture(),data=catalog();Object.assign(data[0]!,{[field]:value});f.setCatalog(data);
    expect((await readbackTick(f.options,f.deps)).status).toBe("DEGRADED");expect(f.requests).toHaveLength(1);
  }
  const f=fixture();f.options.configuration={...config(),channel:"real_time"};expect((await readbackTick(f.options,f.deps)).code).toBe("CHANNEL_UNSUPPORTED");
});

test("malformed state, changed policy, duplicate watermarks and clock rollback require review",async()=>{
  const base=fixture(),first=await readbackTick(base.options,base.deps);
  for(const change of ["scope","duplicates","future","invalid"] as const) {
    const f=fixture(),state=structuredClone(first.state!);f.options.state=state;
    if(change==="scope")f.options.configuration={...config(),maxConfidenceBps:99};
    if(change==="duplicates")state.feeds.push({...state.feeds[0]!});
    if(change==="future")state.updatedAt=NOW+1;
    if(change==="invalid")(state as unknown as {feeds:string}).feeds="invalid";
    expect((await readbackTick(f.options,f.deps)).status).toBe("BLOCKED");expect(f.requests).toHaveLength(0);
  }
  const f=fixture();f.options.configuration={...config(),maxAgeMs:30001};expect((await readbackTick(f.options,f.deps)).code).toBe("AGE_POLICY_EXCEEDS_APPROVAL");
});

test("durable Retry-After survives a restart and skips requests until the saved deadline",async()=>{
  const f=fixture();f.deps.fetch=(async()=>json({private:TOKEN},429,{"retry-after":"60"})) as unknown as typeof fetch;
  const failed=await readbackTick(f.options,f.deps);expect(failed.code).toBe("HTTP_429");expect(failed.state?.nextAttemptAt).toBe(NOW+60000);
  const resumed=fixture();resumed.options.state=failed.state;resumed.setTime(NOW+1000);
  const report=await readbackTick(resumed.options,resumed.deps);expect(report.status).toBe("BACKOFF");expect(resumed.requests).toHaveLength(0);
  expect(JSON.stringify(failed)).not.toContain(TOKEN);
});

test("credentials and arbitrary server, network and persistence diagnostics never appear in reports",async()=>{
  for(const status of [400,401,403,404,500,503]) {
    const f=fixture();f.deps.fetch=(async()=>json({error:TOKEN},status)) as unknown as typeof fetch;
    const report=await readbackTick(f.options,f.deps);expect(report.status).toBe("DEGRADED");expect(JSON.stringify(report)).not.toContain(TOKEN);
  }
  const network=fixture();network.deps.fetch=(async()=>{throw new Error(TOKEN);}) as unknown as typeof fetch;
  expect((await readbackTick(network.options,network.deps)).code).toBe("NETWORK_ERROR");
  const persistence=fixture();persistence.options.persistState=()=>{throw new Error(TOKEN);};
  const report=await readbackTick(persistence.options,persistence.deps);expect(report.status).toBe("PERSISTENCE_FAILED");expect(report.state).toBeUndefined();expect(JSON.stringify(report)).not.toContain(TOKEN);
});

test("oversized, malformed UTF-8/JSON and non-JSON responses fail before observation",async()=>{
  const responses=[()=>new Response("{}",{headers:{"content-type":"text/plain"}}),()=>new Response(new Uint8Array([255]),{headers:{"content-type":"application/json"}}),
    ()=>new Response("{"+TOKEN,{headers:{"content-type":"application/json"}}),()=>new Response("{}",{headers:{"content-type":"application/json","content-length":String(PYTH_READBACK_LIMITS.catalogBytes+1)}}),
    ()=>new Response(new Uint8Array(PYTH_READBACK_LIMITS.catalogBytes+1),{headers:{"content-type":"application/json"}})];
  for(const response of responses){const f=fixture();f.deps.fetch=(async()=>response()) as unknown as typeof fetch;const report=await readbackTick(f.options,f.deps);expect(report.status).toBe("DEGRADED");expect(report.state?.feeds).toHaveLength(0);expect(JSON.stringify(report)).not.toContain(TOKEN);}
});

test("one-byte response chunks retain the same bounded parser behavior",async()=>{
  const f=fixture();f.deps.fetch=(async url=>{
    const bytes=new TextEncoder().encode(JSON.stringify(String(url)===PYTH_SYMBOLS_URL?catalog():payload()));let index=0;
    return new Response(new ReadableStream({pull(controller){if(index===bytes.length)controller.close();else {const start=index++;controller.enqueue(bytes.subarray(start,start+1));}}}),{headers:{"content-type":"application/json"}});
  }) as typeof fetch;
  expect((await readbackTick(f.options,f.deps)).status).toBe("UPSTREAM_OBSERVED");
});

test("fetch and body deadlines terminate non-cooperating promises and external abort cancels",async()=>{
  for(const stalledBody of [false,true]) {
    const f=fixture();f.options.configuration={...config(),requestTimeoutMs:20};
    f.deps.fetch=(async()=>stalledBody?new Response(new ReadableStream({pull:()=>new Promise(()=>{})}),{headers:{"content-type":"application/json"}}):await new Promise(()=>{})) as unknown as typeof fetch;
    expect((await readbackTick(f.options,f.deps)).code).toBe("REQUEST_TIMEOUT");
  }
  const f=fixture(),controller=new AbortController();f.options.signal=controller.signal;
  f.deps.fetch=(async()=>{controller.abort();return await new Promise(()=>{});}) as unknown as typeof fetch;
  expect((await readbackTick(f.options,f.deps)).status).toBe("ABORTED");expect(f.writes).toHaveLength(0);
});

test("real local HTTP transport enforces redirect rejection without following or leaking auth",async()=>{
  let targetRequests=0;
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){const url=new URL(request.url);if(url.pathname==="/target"){targetRequests++;return json(payload());}return new Response(null,{status:302,headers:{location:"/target"}});}});
  try {
    const f=fixture();f.deps.fetch=((_url,init)=>fetch(`http://127.0.0.1:${server.port}/redirect`,init)) as typeof fetch;
    expect((await readbackTick(f.options,f.deps)).code).toBe("NETWORK_ERROR");expect(targetRequests).toBe(0);
  }finally{server.stop(true);}
});

test("the recurring loop persists sequential ticks, stops on persistence failure and honors abort",async()=>{
  const f=fixture(),controller=new AbortController();let reports=0;
  const summary=await runReadbackMonitor({...f.options,signal:controller.signal,getExpectedPrints:()=>f.options.expectedPrints!,onReport:report=>{
    reports++;expect(report.state).toBeDefined();controller.abort();
  }},f.deps);
  expect(summary.ticks).toBe(1);expect(summary.status).toBe("ABORTED");expect(reports).toBe(1);expect(f.writes).toHaveLength(1);
  const failed=fixture();failed.options.persistState=()=>{throw new Error("isolated failure");};
  const stopped=await runReadbackMonitor({...failed.options,signal:new AbortController().signal,getExpectedPrints:()=>failed.options.expectedPrints!},failed.deps);
  expect(stopped).toEqual({ticks:1,status:"PERSISTENCE_FAILED"});
});

test("the full 512-binding manifest uses bounded sequential batches and each batch's own envelope",async()=>{
  const f=fixture(),m=manifest();m.bindings=Array.from({length:512},(_,i)=>({...binding,indexFeedId:`TEST.${i+1}`,pythFeedId:i+1,symbol:`TEST.${i+1}/USD`}));
  f.options.manifest=m;f.options.expectedPrints=m.bindings.map(b=>({feedId:b.pythFeedId,price:"5.125",sourceTimestampUs:String((NOW-10000)*1000)}));
  const batches:number[][]=[];let active=0,maxActive=0;
  f.deps.fetch=(async(url,init)=>{
    active++;maxActive=Math.max(active,maxActive);await Promise.resolve();active--;
    if(String(url)===PYTH_SYMBOLS_URL)return json(m.bindings.map(b=>({...catalog()[0],pyth_lazer_id:b.pythFeedId,symbol:b.symbol})));
    const ids=(JSON.parse(init!.body as string) as {priceFeedIds:number[]}).priceFeedIds;batches.push(ids);
    // Different, individually valid envelopes ensure a single global envelope cannot replace them.
    const envelope=NOW-batches.length*1000;
    return json({parsed:{timestampUs:String(envelope*1000),priceFeeds:ids.map(id=>({...payload().parsed.priceFeeds[0],priceFeedId:id,feedUpdateTimestamp:(envelope-100)*1000}))}});
  }) as typeof fetch;
  const report=await readbackTick(f.options,f.deps);
  expect(report.status).toBe("UPSTREAM_OBSERVED");expect(report.feeds).toHaveLength(512);expect(report.state?.feeds).toHaveLength(512);expect(f.writes).toHaveLength(1);
  expect(batches.map(b=>b.length)).toEqual([100,100,100,100,100,12]);expect(maxActive).toBe(1);expect(new Set(batches.flat()).size).toBe(512);
});

test("mid-batch failure preserves all durable high-water marks and backs off the whole tick",async()=>{
  const f=fixture(),m=manifest();m.bindings.push({...binding,indexFeedId:"TEST.OTHER",pythFeedId:42,symbol:"TEST.OTHER/USD"});
  f.options.manifest=m;f.options.configuration={...config(),maxFeedsPerRequest:1};
  f.options.expectedPrints=[...f.options.expectedPrints!,{feedId:42,price:"5.125",sourceTimestampUs:String((NOW-2000)*1000)}];
  let calls=0;
  f.deps.fetch=(async(url)=>{
    if(String(url)===PYTH_SYMBOLS_URL)return json(m.bindings.map(b=>({...catalog()[0],pyth_lazer_id:b.pythFeedId,symbol:b.symbol})));
    calls++;return calls===1?json(payload()):json({error:TOKEN},429,{"retry-after":"60"});
  }) as typeof fetch;
  const report=await readbackTick(f.options,f.deps);
  expect(report.code).toBe("HTTP_429");expect(report.status).toBe("DEGRADED");expect(report.state?.feeds).toHaveLength(0);expect(report.state?.nextAttemptAt).toBe(NOW+60000);expect(f.writes).toHaveLength(1);
});

test("early batch data and approval are rechecked when later responses finish",async()=>{
  for(const expired of [false,true]) {
    const f=fixture(),m=manifest();m.bindings.push({...binding,indexFeedId:"TEST.OTHER",pythFeedId:42,symbol:"TEST.OTHER/USD"});
    if(expired)m.approval.expiresAt=NOW+1000;
    f.options.manifest=m;f.options.configuration={...config(),maxFeedsPerRequest:1};let calls=0;
    f.deps.fetch=(async(url)=>{
      if(String(url)===PYTH_SYMBOLS_URL)return json(m.bindings.map(b=>({...catalog()[0],pyth_lazer_id:b.pythFeedId,symbol:b.symbol})));
      if(++calls===1)return json(payload());
      f.setTime(NOW+30001);const value=payload(NOW+30001);value.parsed.priceFeeds[0]!.priceFeedId=42;return json(value);
    }) as typeof fetch;
    const report=await readbackTick(f.options,f.deps);expect(report.code).toBe(expired?"APPROVAL_EXPIRED":"ENVELOPE_CLOCK_INVALID");expect(report.state?.feeds).toHaveLength(0);
  }
});

test("same-generation confidence and publisher-count conflicts fail, while exact i64 price comparisons do not round",async()=>{
  for(const field of ["confidence","publisherCount"]) {
    const f=fixture(),first=await readbackTick(f.options,f.deps);f.options.state=first.state;f.setTime(NOW+1000);
    const value=payload(NOW+1000,NOW-1000);value.parsed.priceFeeds[0]![field]=field==="confidence"?10001:4;f.setPayload(value);
    expect((await readbackTick(f.options,f.deps)).feeds[0]?.status).toBe("SAME_TIMESTAMP_CONFLICT");
  }
  const f=fixture(),value=payload();value.parsed.priceFeeds[0]!.price="9223372036854000000";f.setPayload(value);
  f.options.expectedPrints=[{feedId:FEED,price:"9223372036854",sourceTimestampUs:String((NOW-2000)*1000)}];
  f.options.configuration={...config(),maxPriceDeviationBps:0};expect((await readbackTick(f.options,f.deps)).status).toBe("UPSTREAM_OBSERVED");
});

test("manifest mutation during a request cannot change the approved tick and report errors remain sanitized",async()=>{
  const f=fixture(),m=manifest();f.options.manifest=m;const request=f.deps.fetch!;
  f.deps.fetch=(async(url,init)=>{m.bindings[0]!.pythFeedId=99;return request(url,init);}) as typeof fetch;
  expect((await readbackTick(f.options,f.deps)).status).toBe("UPSTREAM_OBSERVED");
  const second=fixture();const report=await runReadbackMonitor({...second.options,signal:new AbortController().signal,getExpectedPrints:()=>second.options.expectedPrints!,onReport:()=>{throw new Error(TOKEN);}},second.deps);
  expect(report).toEqual({ticks:1,status:"BLOCKED"});expect(JSON.stringify(report)).not.toContain(TOKEN);
});

test("total response bytes stay bounded even when many individually valid batches are requested",async()=>{
  const f=fixture(),m=manifest();m.bindings=Array.from({length:21},(_,i)=>({...binding,indexFeedId:`TEST.${i+1}`,pythFeedId:i+1,symbol:`TEST.${i+1}/USD`}));
  f.options.manifest=m;f.options.configuration={...config(),maxFeedsPerRequest:1};
  f.options.expectedPrints=m.bindings.map(b=>({feedId:b.pythFeedId,price:"5.125",sourceTimestampUs:String((NOW-2000)*1000)}));
  let batches=0;
  f.deps.fetch=(async(url,init)=>{
    if(String(url)===PYTH_SYMBOLS_URL)return json(m.bindings.map(b=>({...catalog()[0],pyth_lazer_id:b.pythFeedId,symbol:b.symbol})));
    batches++;const id=(JSON.parse(init!.body as string) as {priceFeedIds:number[]}).priceFeedIds[0],value=payload();value.parsed.priceFeeds[0]!.priceFeedId=id;
    return json({...value,ignoredPadding:"x".repeat(900000)});
  }) as typeof fetch;
  const report=await readbackTick(f.options,f.deps);
  expect(report.code).toBe("TICK_RESPONSE_BUDGET_EXCEEDED");expect(report.state?.feeds).toHaveLength(0);expect(batches).toBeLessThan(21);expect(f.writes).toHaveLength(1);
});
