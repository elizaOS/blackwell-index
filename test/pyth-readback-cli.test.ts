// Isolated synthetic journals, approvals, credentials and upstream responses only.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonical, hash, signBatch } from "../src/crypto";
import { calculate } from "../src/engine";
import { Store } from "../src/store";
import type { NodeConfig } from "../src/config";
import { PYTH_PROTOCOL, PYTH_SYMBOLS_URL, priceToPythMantissa, type PythManifest } from "../src/pyth";
import { PYTH_LATEST_PRICE_URL, type PythReadbackResult } from "../src/pyth/readback";
import { runPythReadbackCli } from "../src/pyth/readback-cli";
import { environment } from "./helpers";

const TOKEN="isolated-readback-cli-test-token",directories:string[]=[],stores:Store[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function save(path:string,value:unknown){writeFileSync(path,canonical(value),{mode:0o600});}
function fixture() {
  const root=mkdtempSync(join(tmpdir(),"sbx-readback-cli-"));directories.push(root);chmodSync(root,0o700);
  mkdirSync(join(root,"data"),{mode:0o700});mkdirSync(join(root,"config"),{mode:0o700});
  const now=Date.now(),e=environment(),registry=e.registry,methodology={...e.methodology,effectiveAt:now-10000};
  const batches=e.batches.map((batch,index)=>signBatch({...batch.payload,createdAt:now,observations:batch.payload.observations.map(observation=>({...observation,observedAt:now-2000,priceEffectiveAt:now-86400000}))},e.identities[index]!));
  const snapshot=calculate(batches,registry,methodology,now);expect(snapshot.publishable).toBe(true);
  const store=new Store(join(root,"data/node.sqlite"));stores.push(store);
  store.saveConfiguration(registry);store.saveConfiguration(methodology);for(const batch of batches)store.accept(batch,now,true);store.snapshot(snapshot);
  const config:NodeConfig={schemaVersion:1,network:registry.network,identityPath:"data/node-identity.json",databasePath:"data/node.sqlite",registryPath:"config/registry.local.json",methodologyPath:"config/methodology.local.json",
    host:"127.0.0.1",port:0,intervalMs:300000,collectors:[],peers:[],allowLoopbackPeers:false,pythManifestPath:"config/pyth-manifest.json"};
  const bindings=snapshot.feeds.filter(feed=>feed.kind!=="PROVIDER").map((feed,index)=>({indexFeedId:feed.id,pythFeedId:index+1,symbol:`TEST.${feed.id}/USD`,exponent:-9,minPublishers:3}));
  const manifest:PythManifest={schemaVersion:1,enabled:true,network:registry.network,methodologyHash:hash(methodology),registryHash:hash(registry),agentUrl:"ws://127.0.0.1:8910/v1/jrpc",maxAgeMs:30000,futureToleranceMs:1000,
    approval:{status:"APPROVED",publisherPublicKey:"11111111111111111111111111111111",evidence:"Isolated wrapper test approval",verifiedAt:now-1000,expiresAt:now+3600000,protocol:PYTH_PROTOCOL,relayerUrls:["wss://isolated.example.test/v1/transaction"]},bindings};
  const configuration={schemaVersion:1,enabled:true,pollIntervalMs:1000,requestTimeoutMs:1000,maxAgeMs:30000,maxConfidenceBps:100,maxPriceDeviationBps:100};
  save(join(root,"config/node.local.json"),config);save(join(root,config.registryPath),registry);save(join(root,config.methodologyPath),methodology);save(join(root,config.pythManifestPath!),manifest);save(join(root,"config/pyth-readback.json"),configuration);
  const statePath=join(root,"data/pyth-readback.sqlite"),lockPath=statePath+".lock",reports:Omit<PythReadbackResult,"state">[]=[],requests:string[]=[];
  const catalog=bindings.map(binding=>({pyth_lazer_id:binding.pythFeedId,symbol:binding.symbol,exponent:binding.exponent,min_publishers:binding.minPublishers,state:"stable",quote_currency:"USD",min_channel:"fixed_rate@1000ms"}));
  const payload={parsed:{timestampUs:String(now*1000),priceFeeds:bindings.map(binding=>({priceFeedId:binding.pythFeedId,exponent:binding.exponent,price:String(priceToPythMantissa(snapshot.feeds.find(feed=>feed.id===binding.indexFeedId)!.price!,binding.exponent)),confidence:"1",publisherCount:3,feedUpdateTimestamp:String((now-1000)*1000),marketSession:"regular"}))}};
  const dependencies={now:()=>now,env:{PYTH_PRO_API_KEY:TOKEN},onReport:(report:Omit<PythReadbackResult,"state">)=>{reports.push(report);},fetch:(async(input:Parameters<typeof fetch>[0])=>{
    const url=String(input);requests.push(url);if(url!==PYTH_SYMBOLS_URL&&url!==PYTH_LATEST_PRICE_URL)throw new Error("Unexpected isolated request");
    return new Response(JSON.stringify(url===PYTH_SYMBOLS_URL?catalog:payload),{headers:{"content-type":"application/json"}});
  }) as typeof fetch};
  const args=["--dir",root,"--node-config","config/node.local.json","--config","config/pyth-readback.json","--state","data/pyth-readback.sqlite","--once"];
  return {root,store,now,batches,snapshot,manifest,configuration,config,statePath,lockPath,reports,requests,dependencies,args,payload,catalog};
}
function persisted(path:string) {
  const db=new Database(path,{readonly:true,strict:true});
  try{return db.query("SELECT format,payload,payload_hash FROM pyth_readback_state WHERE id=1").get() as {format:string;payload:string;payload_hash:string}|null;}finally{db.close();}
}
async function child(f:ReturnType<typeof fixture>,extra:string[]=[],preload?:string,env:Record<string,string>={}) {
  const process=Bun.spawn([globalThis.process.execPath,...(preload?["--preload",preload]:[]),resolve(import.meta.dir,"../src/pyth/readback-cli.ts"),...f.args,...extra],{env,stdout:"pipe",stderr:"pipe"});
  const timer=setTimeout(()=>process.kill("SIGKILL"),15_000);
  try {const [stdout,stderr,code]=await Promise.all([new Response(process.stdout).text(),new Response(process.stderr).text(),process.exited]);return {stdout,stderr,code};}finally{clearTimeout(timer);}
}

test("operator wrapper reproduces actual retained five-feed expectations and durably saves before reporting",async()=>{
  const f=fixture(),before=f.store.counts();let durable=false;
  const code=await runPythReadbackCli([...f.args,"--init-state"],{...f.dependencies,onReport:report=>{
    const state=persisted(f.statePath);expect(state).not.toBeNull();expect(state!.payload_hash).toBe(hash(JSON.parse(state!.payload)));
    expect(JSON.parse(state!.payload).feeds).toHaveLength(5);durable=true;f.reports.push(report);
  }});
  expect(code).toBe(0);expect(durable).toBe(true);expect(f.reports[0]!.status).toBe("UPSTREAM_OBSERVED");expect(f.reports[0]!.feeds).toHaveLength(5);
  expect(f.requests).toEqual([PYTH_SYMBOLS_URL,PYTH_LATEST_PRICE_URL]);expect(f.store.counts()).toEqual(before);
  expect(f.store.db.query("SELECT name FROM sqlite_master WHERE name='pyth_readback_state'").get()).toBeNull();
  expect(statSync(f.statePath).mode&0o777).toBe(0o600);expect(existsSync(f.lockPath)).toBe(false);
  expect(JSON.stringify(f.reports)+readFileSync(f.statePath).toString()).not.toContain(TOKEN);expect(f.reports[0]).not.toHaveProperty("state");
  const saved=readFileSync(f.statePath);
  expect(await runPythReadbackCli(f.args,f.dependencies)).toBe(1);expect(f.reports.at(-1)!.status).toBe("BACKOFF");expect(f.requests).toHaveLength(2);
  expect(readFileSync(f.statePath)).toEqual(saved);
});

test("missing or existing state requires explicit bootstrap intent and never silently resets",async()=>{
  const f=fixture();expect(await runPythReadbackCli(f.args,f.dependencies)).toBe(1);
  expect(f.reports.at(-1)!.code).toBe("STATE_INITIALIZATION_REQUIRED");expect(f.requests).toHaveLength(0);expect(existsSync(f.statePath)).toBe(false);
  expect(await runPythReadbackCli([...f.args,"--init-state"],f.dependencies)).toBe(0);const before=readFileSync(f.statePath);
  expect(await runPythReadbackCli([...f.args,"--init-state"],f.dependencies)).toBe(1);expect(f.reports.at(-1)!.code).toBe("STATE_ALREADY_EXISTS");expect(readFileSync(f.statePath)).toEqual(before);
});

test("an existing empty state database requires review instead of a silent bootstrap",async()=>{
  const f=fixture();expect(await runPythReadbackCli([...f.args,"--init-state"],f.dependencies)).toBe(0);
  const db=new Database(f.statePath);try{db.exec("DELETE FROM pyth_readback_state");}finally{db.close();}
  const before=readFileSync(f.statePath),requests=f.requests.length;
  expect(await runPythReadbackCli(f.args,f.dependencies)).toBe(1);expect(f.reports.at(-1)!.code).toBe("STATE_EMPTY_REVIEW_REQUIRED");
  expect(f.requests).toHaveLength(requests);expect(readFileSync(f.statePath)).toEqual(before);
});

test("real CLI with no consumer token returns NOT_CONFIGURED without requests or new state",async()=>{
  const f=fixture(),preload=join(f.root,"no-network.ts"),marker=join(f.root,"unexpected-request");
  writeFileSync(preload,`import {writeFileSync} from "node:fs"; globalThis.fetch=async()=>{writeFileSync(${JSON.stringify(marker)},"request");throw new Error("unexpected request");};`,{mode:0o600});
  const result=await child(f,[],preload);
  expect(result.code).toBe(1);expect(JSON.parse(result.stdout).status).toBe("NOT_CONFIGURED");expect(result.stderr).toBe("");
  expect(existsSync(marker)).toBe(false);expect(existsSync(f.statePath)).toBe(false);expect(existsSync(f.lockPath)).toBe(false);
},20_000);

test("missing approval also returns NOT_CONFIGURED and never starts the monitor",async()=>{
  const f=fixture();save(join(f.root,f.config.pythManifestPath!),{...f.manifest,approval:{...f.manifest.approval,status:"PENDING"}});
  expect(await runPythReadbackCli([...f.args,"--init-state"],f.dependencies)).toBe(1);expect(f.reports[0]!.status).toBe("NOT_CONFIGURED");expect(f.requests).toHaveLength(0);expect(existsSync(f.statePath)).toBe(false);
});

for(const change of ["hash","signature","scope","configuration-record","unavailable","stale"] as const)test(`wrapper rejects ${change} in retained expectations before any external request`,async()=>{
  const f=fixture();let now=f.now;
  if(change==="hash")f.store.db.query("UPDATE snapshots SET hash=?").run("f".repeat(64));
  if(change==="signature")f.store.db.query("UPDATE reports SET payload=? WHERE hash=?").run(canonical({...f.batches[0]!,signature:"invalid"}),hash(f.batches[0]));
  if(change==="scope")save(join(f.root,f.config.registryPath),{...environment().registry,version:"changed-after-approval"});
  if(change==="configuration-record")f.store.db.query("DELETE FROM configurations WHERE hash=?").run(f.snapshot.methodologyHash);
  if(change==="unavailable")f.store.snapshot({...f.snapshot,publishable:false});
  if(change==="stale")now+=30001;
  expect(await runPythReadbackCli([...f.args,"--init-state"],{...f.dependencies,now:()=>now})).toBe(1);
  expect(f.reports[0]!.status).toBe("BLOCKED");expect(f.requests).toHaveLength(0);expect(existsSync(f.statePath)).toBe(false);
});

for(const change of ["bytes","extra-table","reserved-lookalike","trigger","payload","permissions"] as const)test(`corrupt monitor ${change} remains unchanged and fails closed`,async()=>{
  const f=fixture();
  if(change==="bytes")writeFileSync(f.statePath,"isolated corrupt database",{mode:0o600});
  else {
    expect(await runPythReadbackCli([...f.args,"--init-state"],f.dependencies)).toBe(0);
    const db=new Database(f.statePath);
    try {
      if(change==="extra-table")db.exec("CREATE TABLE unexpected(value TEXT)");
      if(change==="reserved-lookalike")db.exec("CREATE TABLE sqlitex_unreviewed(value TEXT)");
      if(change==="trigger")db.exec("CREATE TRIGGER unexpected AFTER UPDATE ON pyth_readback_state BEGIN DELETE FROM pyth_readback_state; END");
      if(change==="payload")db.query("UPDATE pyth_readback_state SET payload=?").run(canonical({private:TOKEN}));
    }finally{db.close();}
    if(change==="permissions")chmodSync(f.statePath,0o644);
  }
  const before=readFileSync(f.statePath),requests=f.requests.length;
  expect(await runPythReadbackCli(f.args,f.dependencies)).toBe(1);expect(f.reports.at(-1)!.status).toBe("BLOCKED");expect(f.requests).toHaveLength(requests);
  expect(readFileSync(f.statePath)).toEqual(before);expect(existsSync(f.lockPath)).toBe(false);expect(JSON.stringify(f.reports)).not.toContain(TOKEN);
});

test("a competing owner is never stolen and protected paths cannot overlap the source",async()=>{
  const f=fixture();writeFileSync(f.lockPath,"existing isolated owner",{mode:0o600});
  expect(await runPythReadbackCli([...f.args,"--init-state"],f.dependencies)).toBe(1);expect(f.reports.at(-1)!.code).toBe("STATE_ALREADY_OWNED");expect(readFileSync(f.lockPath,"utf8")).toBe("existing isolated owner");expect(f.requests).toHaveLength(0);
  const args=["--dir",f.root,"--state",f.config.databasePath,"--once","--init-state"];
  expect(await runPythReadbackCli(args,f.dependencies)).toBe(1);expect(f.reports.at(-1)!.code).toBe("STATE_PATH_OVERLAP");
});

test("nofollow rejects linked state and linked parent directories without touching targets",async()=>{
  const f=fixture(),target=join(f.root,"do-not-touch");writeFileSync(target,"retained target",{mode:0o600});symlinkSync(target,f.statePath);
  expect(await runPythReadbackCli([...f.args,"--init-state"],f.dependencies)).toBe(1);expect(readFileSync(target,"utf8")).toBe("retained target");expect(f.requests).toHaveLength(0);
  symlinkSync(join(f.root,"data"),join(f.root,"linked-data"));
  expect(await runPythReadbackCli(["--dir",f.root,"--state","linked-data/new.sqlite","--once","--init-state"],f.dependencies)).toBe(1);expect(existsSync(join(f.root,"data/new.sqlite"))).toBe(false);
});

test("FIFO state input is rejected without waiting for a writer",async()=>{
  const f=fixture(),created=Bun.spawnSync(["mkfifo","-m","600",f.statePath],{stdout:"pipe",stderr:"pipe"});expect(created.exitCode).toBe(0);
  expect(await runPythReadbackCli(f.args,f.dependencies)).toBe(1);expect(f.reports.at(-1)!.code).toBe("INPUT_NOT_BOUNDED_REGULAR_FILE");expect(f.requests).toHaveLength(0);
});

test("configuration changes during a request block durable success and preserve the private state",async()=>{
  const f=fixture(),original=f.dependencies.fetch;
  const code=await runPythReadbackCli([...f.args,"--init-state"],{...f.dependencies,fetch:(async(...args:Parameters<typeof fetch>)=>{
    const response=await original(...args);if(String(args[0])===PYTH_LATEST_PRICE_URL)save(join(f.root,"config/pyth-readback.json"),{...f.configuration,maxConfidenceBps:99});return response;
  }) as typeof fetch});
  expect(code).toBe(1);expect(f.reports.at(-1)!.status).toBe("PERSISTENCE_FAILED");expect(persisted(f.statePath)).toBeNull();expect(existsSync(f.lockPath)).toBe(false);
});

test("durable state compare-and-swap refuses an unexpected in-place watermark edit",async()=>{
  const f=fixture();expect(await runPythReadbackCli([...f.args,"--init-state"],f.dependencies)).toBe(0);
  const original=f.dependencies.fetch;let changed:string|undefined;
  const code=await runPythReadbackCli(f.args,{...f.dependencies,now:()=>f.now+1000,fetch:(async(...args:Parameters<typeof fetch>)=>{
    const response=await original(...args);
    if(String(args[0])===PYTH_LATEST_PRICE_URL) {
      const prior=JSON.parse(persisted(f.statePath)!.payload);prior.nextAttemptAt++;
      const db=new Database(f.statePath);try{db.query("UPDATE pyth_readback_state SET payload=?,payload_hash=?").run(canonical(prior),hash(prior));}finally{db.close();}
      changed=readFileSync(f.statePath).toString("hex");
    }
    return response;
  }) as typeof fetch});
  expect(code).toBe(1);expect(f.reports.at(-1)!.status).toBe("PERSISTENCE_FAILED");expect(changed).toBeDefined();expect(readFileSync(f.statePath).toString("hex")).toBe(changed!);
});

test("continuous monitor emits a terminal blocked report when its next retained expectation fails",async()=>{
  const f=fixture();
  const code=await runPythReadbackCli([...f.args.filter(arg=>arg!=="--once"),"--init-state"],{...f.dependencies,onReport:report=>{
    f.reports.push(report);if(report.status==="UPSTREAM_OBSERVED")save(join(f.root,"config/pyth-readback.json"),{...f.configuration,maxConfidenceBps:99});
  }});
  expect(code).toBe(1);expect(f.reports.map(report=>report.status)).toEqual(["UPSTREAM_OBSERVED","BLOCKED"]);expect(f.reports.at(-1)!.code).toBe("MONITOR_STOPPED");expect(existsSync(f.lockPath)).toBe(false);
},10_000);

test("dangling state sidecars and writable policy files fail closed",async()=>{
  const f=fixture();expect(await runPythReadbackCli([...f.args,"--init-state"],f.dependencies)).toBe(0);
  symlinkSync(join(f.root,"missing-sidecar-target"),f.statePath+"-wal");const before=readFileSync(f.statePath);
  expect(await runPythReadbackCli(f.args,f.dependencies)).toBe(1);expect(f.reports.at(-1)!.code).toBe("STATE_SIDECAR_REVIEW_REQUIRED");expect(readFileSync(f.statePath)).toEqual(before);
  const other=fixture();chmodSync(join(other.root,other.config.pythManifestPath!),0o666);
  expect(await runPythReadbackCli([...other.args,"--init-state"],other.dependencies)).toBe(1);expect(other.reports.at(-1)!.code).toBe("INPUT_OWNER_UNSAFE");expect(other.requests).toHaveLength(0);
});

test("lock cleanup never deletes a replacement owner's file",async()=>{
  const f=fixture();
  const code=await runPythReadbackCli([...f.args,"--init-state"],{...f.dependencies,onReport:report=>{
    f.reports.push(report);rmSync(f.lockPath);writeFileSync(f.lockPath,"replacement isolated owner",{mode:0o600});
  }});
  expect(code).toBe(0);expect(readFileSync(f.lockPath,"utf8")).toBe("replacement isolated owner");
});

test("real CLI handles SIGTERM during a noncooperative fetch and releases only its own lock",async()=>{
  const f=fixture(),preload=join(f.root,"abort-fetch.ts"),marker=join(f.root,"fetch-entered");
  writeFileSync(preload,`import {writeFileSync} from "node:fs"; globalThis.fetch=()=>{writeFileSync(${JSON.stringify(marker)},"entered");setTimeout(()=>process.kill(process.pid,"SIGTERM"),25);return new Promise(()=>{});};`,{mode:0o600});
  const result=await child(f,["--init-state"],preload,{PYTH_PRO_API_KEY:TOKEN});
  expect(existsSync(marker)).toBe(true);expect(result.code).toBe(130);expect(JSON.parse(result.stdout).status).toBe("ABORTED");expect(result.stderr).toBe("");
  expect(existsSync(f.lockPath)).toBe(false);expect(persisted(f.statePath)).toBeNull();expect(result.stdout+result.stderr+readFileSync(f.statePath).toString()).not.toContain(TOKEN);
},20_000);

test("CLI rejects token arguments without echoing their values",async()=>{
  const f=fixture(),result=await child(f,["--token",TOKEN]);
  expect(result.code).toBe(1);expect(JSON.parse(result.stdout).code).toBe("ARGUMENTS_INVALID");expect(result.stdout+result.stderr).not.toContain(TOKEN);
},20_000);
