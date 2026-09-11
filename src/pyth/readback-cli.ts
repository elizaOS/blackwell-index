/** Read-only Pyth observation process with separate, single-owner durable state. */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { parseConfig, type NodeConfig } from "../config";
import { canonical, hash, verifyBatch } from "../crypto";
import { calculate } from "../engine";
import { assertSnapshotPublicationScope } from "../publication";
import type { SignedBatch } from "../types";
import { parseMethodology, parseRegistry, signedBatchSchema } from "../validation";
import { validatePythManifest, type PythManifest } from "./index";
import { pythReadbackConfigSchema, pythReadbackStateSchema, readbackTick, runReadbackMonitor,
  type PythExpectedPrint, type PythReadbackDependencies, type PythReadbackResult, type PythReadbackState } from "./readback";

const MAX_CONFIG=1_000_000,MAX_STATE=1024*1024,MAX_PAYLOAD=128*1024,MAX_SNAPSHOT=2*1024*1024,MAX_INPUTS=1000,MAX_INPUT_BYTES=32*1024*1024;
const FORMAT="SBX_PYTH_READBACK_STATE_V1";
const STATE_SQL="CREATE TABLE pyth_readback_state (id INTEGER PRIMARY KEY CHECK(id=1), format TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL)";
const digest=z.string().regex(/^[a-f0-9]{64}$/),positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const snapshotSchema=z.object({schemaVersion:z.literal(1),network:z.string(),publishable:z.literal(true),calculatedAt:positive,registryHash:digest,methodologyHash:digest,
  inputBatchHashes:z.array(digest).min(1).max(MAX_INPUTS),rejected:z.array(z.object({batchHash:digest,reason:z.string()}).strict()).max(MAX_INPUTS)}).passthrough();
type Pin={path:string;dev:number;ino:number};
type Document={pin:Pin;value:unknown;digest:string};
export interface ReadbackCliDependencies extends PythReadbackDependencies {
  env?:Record<string,string|undefined>;
  signal?:AbortSignal;
  onReport?:(report:Omit<PythReadbackResult,"state">)=>void|Promise<void>;
}
class CliFailure extends Error {constructor(readonly code:string){super(code);}}
function fail(code:string):never {throw new CliFailure(code);}
function pin(path:string,stat:Stats):Pin{return {path,dev:stat.dev,ino:stat.ino};}
function same(a:Pin,b:Pin):boolean{return a.dev===b.dev&&a.ino===b.ino;}
function exists(path:string):boolean {try{lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}}
function trustedOwner(stat:Stats):boolean{return (stat.mode&0o022)===0&&(!process.getuid||stat.uid===process.getuid());}
function checkPin(value:Pin):void {
  let stat:Stats;try{stat=lstatSync(value.path);}catch{fail("INPUT_REPLACED");}
  if(!stat.isFile()||stat.isSymbolicLink()||!same(value,pin(value.path,stat)))fail("INPUT_REPLACED");
}
function pathIn(root:string,value:string):string {
  const path=resolve(root,value),part=relative(root,path);
  if(!part||part.startsWith(`..${sep}`)||part===".."||isAbsolute(part))fail("PATH_OUTSIDE_ROOT");
  return path;
}
function parents(root:string,path:string,create=false):void {
  let current=root;
  if(!trustedOwner(lstatSync(root)))fail("DIRECTORY_UNSAFE");
  for(const part of relative(root,dirname(path)).split(sep).filter(Boolean)) {
    current=join(current,part);
    if(create&&!exists(current))mkdirSync(current,{mode:0o700});
    const stat=lstatSync(current);
    if(!stat.isDirectory()||stat.isSymbolicLink()||!trustedOwner(stat))fail("DIRECTORY_UNSAFE");
  }
}
function privateDirectory(path:string):void {
  const stat=lstatSync(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid()))fail("STATE_DIRECTORY_NOT_PRIVATE");
}
function file(root:string,path:string,maximum:number,privateFile=false):{bytes:Buffer;pin:Pin} {
  parents(root,path);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.size>maximum||stat.nlink!==1)fail("INPUT_NOT_BOUNDED_REGULAR_FILE");
    if(!trustedOwner(stat))fail("INPUT_OWNER_UNSAFE");
    if(privateFile&&((stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid())))fail("STATE_FILE_NOT_PRIVATE");
    const value=pin(path,stat),buffer=Buffer.alloc(maximum+1);let used=0;
    while(used<buffer.length) {const size=readSync(fd,buffer,used,buffer.length-used,null);if(!size)break;used+=size;}
    const after=fstatSync(fd);checkPin(value);
    if(used>maximum)fail("INPUT_TOO_LARGE");
    if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs||used!==stat.size)fail("INPUT_CHANGED");
    return {bytes:buffer.subarray(0,used),pin:value};
  }finally{closeSync(fd);}
}
function regularPin(root:string,path:string,maximum:number,privateFile=false):Pin {
  parents(root,path);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.size>maximum||stat.nlink!==1)fail("INPUT_NOT_BOUNDED_REGULAR_FILE");
    if(!trustedOwner(stat))fail("INPUT_OWNER_UNSAFE");
    if(privateFile&&((stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid())))fail("STATE_FILE_NOT_PRIVATE");
    const value=pin(path,stat);checkPin(value);return value;
  }finally{closeSync(fd);}
}
function document(root:string,path:string):Document {
  const input=file(root,path,MAX_CONFIG);let value:unknown;
  try{value=JSON.parse(input.bytes.toString("utf8"));}catch{fail("CONFIGURATION_INVALID");}
  return {pin:input.pin,value,digest:hash(input.bytes.toString("base64"))};
}
function unchanged(root:string,documents:Document[]):void {
  for(const original of documents) {
    const current=file(root,original.pin.path,MAX_CONFIG);
    if(!same(current.pin,original.pin)||hash(current.bytes.toString("base64"))!==original.digest)fail("CONFIGURATION_CHANGED");
  }
}
function syncDirectory(path:string):void {const fd=openSync(path,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}}
function normalize(sql:string):string{return sql.replace(/\bIF\s+NOT\s+EXISTS\s+/gi,"").replace(/[\s;]+/g,"").toUpperCase();}
function stateValue(db:Database):PythReadbackState|undefined {
  const objects=db.query("SELECT type,name,sql FROM sqlite_master LIMIT 4").all() as {type:string;name:string;sql:string|null}[];
  if(objects.length!==1||objects[0]!.type!=="table"||objects[0]!.name!=="pyth_readback_state"||normalize(objects[0]!.sql??"")!==normalize(STATE_SQL))fail("STATE_SCHEMA_INVALID");
  if((db.query("PRAGMA integrity_check").get() as {integrity_check:string}).integrity_check!=="ok")fail("STATE_CORRUPT");
  if((db.query("PRAGMA journal_mode").get() as {journal_mode:string}).journal_mode!=="delete")fail("STATE_SCHEMA_INVALID");
  const rows=db.query("SELECT id,format,length(CAST(payload AS BLOB)) AS bytes,length(CAST(payload_hash AS BLOB)) AS hash_bytes FROM pyth_readback_state LIMIT 2").all() as {id:number;format:string;bytes:number;hash_bytes:number}[];
  if(rows.length>1)fail("STATE_INVALID");if(!rows.length)return undefined;
  const first=rows[0]!;if(first.id!==1||first.format!==FORMAT||first.bytes<1||first.bytes>MAX_PAYLOAD||first.hash_bytes!==64)fail("STATE_INVALID");
  const row=db.query("SELECT payload,payload_hash FROM pyth_readback_state WHERE id=1").get() as {payload:string;payload_hash:string};
  let value:unknown;try{value=JSON.parse(row.payload);}catch{fail("STATE_INVALID");}
  const parsed=pythReadbackStateSchema.safeParse(value);
  if(!parsed.success||hash(value)!==row.payload_hash||canonical(value)!==row.payload)fail("STATE_INVALID");
  return parsed.data;
}
function noSidecars(root:string,path:string):void {
  for(const suffix of ["-wal","-shm","-journal"])if(exists(path+suffix))fail("STATE_SIDECAR_REVIEW_REQUIRED");
  parents(root,path);
}
function stateInspection(root:string,path:string):{pin:Pin;state:PythReadbackState|undefined}|undefined {
  if(!exists(path))return undefined;
  privateDirectory(dirname(path));noSidecars(root,path);
  const original=file(root,path,MAX_STATE,true);
  checkPin(original.pin);
  const db=new Database(path,{readonly:true,strict:true});
  try{const state=stateValue(db);checkPin(original.pin);if(state===undefined)fail("STATE_EMPTY_REVIEW_REQUIRED");return {pin:original.pin,state};}finally{db.close();}
}
function acquire(root:string,path:string) {
  parents(root,path,true);privateDirectory(dirname(path));
  const lockPath=path+".lock";let fd:number;
  try{fd=openSync(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch{fail("STATE_ALREADY_OWNED");}
  const owned=pin(lockPath,fstatSync(fd));
  try{writeFileSync(fd,canonical({format:"SBX_PYTH_READBACK_LOCK_V1",owner:randomUUID(),pid:process.pid,createdAt:Date.now()}));fsyncSync(fd);syncDirectory(dirname(path));}
  catch{closeSync(fd);if(same(owned,pin(lockPath,lstatSync(lockPath))))unlinkSync(lockPath);throw new CliFailure("LOCK_PERSISTENCE_FAILED");}
  return {check:()=>checkPin(owned),release:()=>{
    closeSync(fd);
    try{if(same(owned,pin(lockPath,lstatSync(lockPath)))){unlinkSync(lockPath);syncDirectory(dirname(path));}}catch{/* Never remove an unknown or replacement lock. */}
  }};
}
function argumentsFor(args:string[]) {
  const values=new Map<string,string>();let once=false,initialize=false;
  for(let index=0;index<args.length;index++) {
    const flag=args[index]!;
    if(flag==="--once"&&!once){once=true;continue;}
    if(flag==="--init-state"&&!initialize){initialize=true;continue;}
    if(!["--dir","--node-config","--config","--state"].includes(flag)||values.has(flag)||!args[index+1]||args[index+1]!.startsWith("--"))fail("ARGUMENTS_INVALID");
    values.set(flag,args[++index]!);
  }
  const selected=resolve(values.get("--dir")??process.cwd()),stat=lstatSync(selected);
  if(!stat.isDirectory()||stat.isSymbolicLink()||!trustedOwner(stat))fail("ROOT_INVALID");
  const root=realpathSync(selected);
  return {root,once,initialize,nodePath:pathIn(root,values.get("--node-config")??"config/node.local.json"),
    configPath:pathIn(root,values.get("--config")??"config/pyth-readback.json"),statePath:pathIn(root,values.get("--state")??"data/pyth-readback.sqlite")};
}
function latestPrints(root:string,path:string,sourcePin:Pin,node:NodeConfig,manifest:PythManifest,registry:ReturnType<typeof parseRegistry>,methodology:ReturnType<typeof parseMethodology>,now:number,maxAgeMs:number):PythExpectedPrint[] {
  checkPin(sourcePin);parents(root,path);
  for(const suffix of ["-wal","-shm"])if(exists(path+suffix))regularPin(root,path+suffix,20*1024*1024*1024,true);
  if(exists(path+"-journal"))fail("JOURNAL_RECOVERY_REVIEW_REQUIRED");
  // Only read the existing journal. Store/Journal constructors would mutate schema.
  const db=new Database(path,{readonly:true,strict:true});
  try {
    db.exec("PRAGMA busy_timeout=1000; PRAGMA query_only=ON");
    return db.transaction(()=>{
      for(const table of ["snapshots","reports","equivocations","configurations"]) {
        const row=db.query("SELECT type FROM sqlite_master WHERE name=?").get(table) as {type:string}|null;
        if(row?.type!=="table")fail("JOURNAL_SCHEMA_INVALID");
      }
      const head=db.query("SELECT id,calculated_at,hash,previous_hash,length(CAST(payload AS BLOB)) AS bytes FROM snapshots ORDER BY id DESC LIMIT 1").get() as {id:number;calculated_at:number;hash:string;previous_hash:string|null;bytes:number}|null;
      if(!head||head.bytes<1||head.bytes>MAX_SNAPSHOT)fail("SNAPSHOT_REQUIRED");
      const raw=JSON.parse((db.query("SELECT payload FROM snapshots WHERE id=?").get(head.id) as {payload:string}).payload) as unknown;
      const parsed=snapshotSchema.safeParse(raw);if(!parsed.success)fail("SNAPSHOT_NOT_PUBLISHABLE");const snapshot=parsed.data;
      if(!Number.isSafeInteger(now)||snapshot.calculatedAt>now||now-snapshot.calculatedAt>maxAgeMs)fail("SNAPSHOT_STALE");
      if(snapshot.calculatedAt!==head.calculated_at||hash({previousHash:head.previous_hash,snapshot:raw})!==head.hash)fail("SNAPSHOT_HASH_INVALID");
      if(snapshot.network!==node.network||snapshot.network!==manifest.network||snapshot.registryHash!==manifest.registryHash||snapshot.methodologyHash!==manifest.methodologyHash||
        hash(registry)!==snapshot.registryHash||hash(methodology)!==snapshot.methodologyHash||methodology.status!=="APPROVED")fail("SNAPSHOT_SCOPE_MISMATCH");
      for(const id of [snapshot.registryHash,snapshot.methodologyHash]) {
        const size=db.query("SELECT length(CAST(payload AS BLOB)) AS bytes FROM configurations WHERE hash=?").get(id) as {bytes:number}|null;
        if(!size||size.bytes<1||size.bytes>MAX_CONFIG)fail("SNAPSHOT_CONFIGURATION_MISSING");
        const value=JSON.parse((db.query("SELECT payload FROM configurations WHERE hash=?").get(id) as {payload:string}).payload) as unknown;
        if(hash(value)!==id)fail("SNAPSHOT_CONFIGURATION_INVALID");
      }
      const ids=[...new Set([...snapshot.inputBatchHashes,...snapshot.rejected.map(item=>item.batchHash)])];
      if(ids.length>MAX_INPUTS)fail("SNAPSHOT_INPUT_BUDGET");let bytes=0,observations=0;const inputs:SignedBatch[]=[];
      for(const id of ids) {
        const size=db.query("SELECT length(CAST(payload AS BLOB)) AS bytes FROM reports WHERE hash=?").get(id) as {bytes:number}|null;
        if(!size||size.bytes<1||(bytes+=size.bytes)>MAX_INPUT_BYTES)fail("SNAPSHOT_INPUT_BUDGET");
        const report=signedBatchSchema.parse(JSON.parse((db.query("SELECT payload FROM reports WHERE hash=?").get(id) as {payload:string}).payload)) as SignedBatch;
        if(hash(report)!==id||!verifyBatch(report)||db.query("SELECT 1 FROM equivocations WHERE node_id=?").get(report.payload.nodeId))fail("SNAPSHOT_INPUT_INVALID");
        observations+=report.payload.observations.length;if(observations>50_000)fail("SNAPSHOT_INPUT_BUDGET");inputs.push(report);
      }
      // Reproduce only to verify the retained print; never fabricate a replacement.
      const reproduced=calculate(inputs,registry,methodology,snapshot.calculatedAt);
      if(hash(reproduced)!==hash(raw))fail("SNAPSHOT_REPRODUCTION_FAILED");
      try {assertSnapshotPublicationScope(reproduced,manifest.publicationScope);}catch {fail("SNAPSHOT_PUBLICATION_SCOPE_MISMATCH");}
      const feeds=new Map(reproduced.feeds.map(feed=>[feed.id,feed]));
      const prints=manifest.bindings.map(binding=>{
        const feed=feeds.get(binding.indexFeedId);
        if(!feed||feed.status!=="READY"||feed.price===null||feed.observedAt===null||!Number.isSafeInteger(feed.observedAt)||feed.observedAt<=0)fail("EXPECTED_PRINT_REQUIRED");
        if(feed.observedAt>now||now-feed.observedAt>maxAgeMs)fail("EXPECTED_PRINT_STALE");
        return {feedId:binding.pythFeedId,price:feed.price,sourceTimestampUs:String(BigInt(feed.observedAt)*1000n)};
      });
      checkPin(sourcePin);return prints;
    })();
  }finally{db.close();}
}
function wrapperReport(status:PythReadbackResult["status"],code:string):PythReadbackResult {
  return {status,code,checkedAt:Date.now(),feeds:[],bootstrap:false,publisherAttribution:"NOT_ESTABLISHED",signatureVerification:"NOT_PERFORMED",onchainVerification:"NOT_PERFORMED"};
}
async function stdout(line:string,signal:AbortSignal|undefined):Promise<void> {
  await new Promise<void>((resolve,reject)=>{
    let finished=false;const stop=()=>done(new CliFailure("REPORT_OUTPUT_FAILED"));
    const timer=setTimeout(stop,1000);
    function done(error?:Error|null) {if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener("abort",stop);if(error)reject(new CliFailure("REPORT_OUTPUT_FAILED"));else resolve();}
    if(!signal?.aborted)signal?.addEventListener("abort",stop,{once:true});
    try{process.stdout.write(line,error=>done(error));}catch{stop();}
  });
}

/** Injectable I/O dependencies are for isolated tests; production endpoints are fixed by readback.ts. */
export async function runPythReadbackCli(args:string[],dependencies:ReadbackCliDependencies={}):Promise<number> {
  let owner:ReturnType<typeof acquire>|undefined,db:Database|undefined,lastStatus:PythReadbackResult["status"]|undefined;
  const report=async(value:PythReadbackResult)=>{
    const {state:_privateState,...publicReport}=value;
    try{if(dependencies.onReport)await dependencies.onReport(publicReport);else await stdout(JSON.stringify(publicReport)+"\n",dependencies.signal);}
    catch{fail("REPORT_OUTPUT_FAILED");}lastStatus=value.status;
  };
  try {
    const selected=argumentsFor(args),{root,statePath}=selected;
    const nodeDoc=document(root,selected.nodePath),configDoc=document(root,selected.configPath),node=parseConfig(nodeDoc.value),configuration=pythReadbackConfigSchema.parse(configDoc.value);
    if(configuration.tokenEnv!=="PYTH_PRO_API_KEY")fail("TOKEN_ENV_INVALID");
    const documents=[nodeDoc,configDoc],manifestPath=node.pythManifestPath===undefined?undefined:pathIn(root,node.pythManifestPath);
    let manifestValue:unknown;
    if(manifestPath&&exists(manifestPath)){const doc=document(root,manifestPath);documents.push(doc);manifestValue=doc.value;}
    const sourcePath=pathIn(root,node.databasePath),protectedPaths=[selected.nodePath,selected.configPath,sourcePath,pathIn(root,node.identityPath),pathIn(root,node.registryPath),pathIn(root,node.methodologyPath),...(manifestPath?[manifestPath]:[])];
    if(protectedPaths.some(path=>[statePath,statePath+".lock",statePath+"-journal",statePath+"-wal",statePath+"-shm"].includes(path)||[path+"-wal",path+"-shm",path+"-journal"].includes(statePath)))fail("STATE_PATH_OVERLAP");
    const inspected=stateInspection(root,statePath);
    if(inspected&&documents.some(doc=>same(doc.pin,inspected.pin)))fail("STATE_PATH_OVERLAP");
    const env={PYTH_PRO_API_KEY:(dependencies.env??process.env).PYTH_PRO_API_KEY};
    let manifest:PythManifest|undefined;try{manifest=validatePythManifest(manifestValue,(dependencies.now??Date.now)());}catch{/* Missing or unapproved setup is not an operational feed. */}
    if(!configuration.enabled||!manifest?.enabled||manifest.approval.status!=="APPROVED"||manifest.approval.expiresAt<=(dependencies.now??Date.now)()||!env.PYTH_PRO_API_KEY||env.PYTH_PRO_API_KEY.length>8192||/[\r\n]/.test(env.PYTH_PRO_API_KEY)) {
      const result=await readbackTick({configuration,manifest:manifestValue,env,persistState:()=>fail("PERSISTENCE_UNEXPECTED")},dependencies);
      await report(result);return result.status==="DISABLED"?0:1;
    }
    if(selected.initialize&&inspected)fail("STATE_ALREADY_EXISTS");
    if(!selected.initialize&&!inspected)fail("STATE_INITIALIZATION_REQUIRED");
    const registryDoc=document(root,pathIn(root,node.registryPath)),methodologyDoc=document(root,pathIn(root,node.methodologyPath));documents.push(registryDoc,methodologyDoc);
    const registry=parseRegistry(registryDoc.value),methodology=parseMethodology(methodologyDoc.value);
    const source=regularPin(root,sourcePath,20*1024*1024*1024,true);
    if(inspected&&same(source,inspected.pin))fail("STATE_PATH_OVERLAP");
    // Reject missing/invalid source data before creating an operational state store.
    const expected=()=>{owner?.check();unchanged(root,documents);return latestPrints(root,sourcePath,source,node,manifest!,registry,methodology,(dependencies.now??Date.now)(),Math.min(configuration.maxAgeMs,manifest!.maxAgeMs));};
    const initialPrints=expected();
    owner=acquire(root,statePath);
    const current=stateInspection(root,statePath);
    if(inspected&&(!current||!same(inspected.pin,current.pin)))fail("STATE_REPLACED");
    if(!inspected&&current)fail("STATE_ALREADY_EXISTS");
    let statePin:Pin;
    if(current)statePin=current.pin;
    else {
      const fd=openSync(statePath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{statePin=pin(statePath,fstatSync(fd));fsyncSync(fd);}finally{closeSync(fd);}
    }
    owner.check();checkPin(statePin);checkPin(source);unchanged(root,documents);
    db=new Database(statePath,{strict:true});
    owner.check();checkPin(statePin);checkPin(source);
    if(!current)db.exec(STATE_SQL);
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; PRAGMA max_page_count=256");
    checkPin(statePin);syncDirectory(dirname(statePath));
    const signal=dependencies.signal??new AbortController().signal;
    let expectedStateHash=current?.state===undefined?undefined:hash(current.state);
    const persistState=(state:PythReadbackState)=>{
      signal.throwIfAborted();owner!.check();checkPin(statePin);unchanged(root,documents);checkPin(source);
      const value=pythReadbackStateSchema.parse(state),payload=canonical(value);if(Buffer.byteLength(payload)>MAX_PAYLOAD)fail("STATE_TOO_LARGE");
      db!.transaction(()=>{
        const previous=stateValue(db!);
        if((previous===undefined?undefined:hash(previous))!==expectedStateHash)fail("STATE_CHANGED");
        db!.query("INSERT INTO pyth_readback_state(id,format,payload,payload_hash) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET format=excluded.format,payload=excluded.payload,payload_hash=excluded.payload_hash").run(FORMAT,payload,hash(value));
      })();
      const fd=openSync(statePath,constants.O_RDONLY|constants.O_NOFOLLOW);try{if(!same(statePin,pin(statePath,fstatSync(fd))))fail("STATE_REPLACED");fsyncSync(fd);}finally{closeSync(fd);}
      syncDirectory(dirname(statePath));owner!.check();checkPin(statePin);
      if(canonical(stateValue(db!))!==payload)fail("STATE_PERSISTENCE_MISMATCH");
      expectedStateHash=hash(value);
    };
    const shared={configuration,manifest,env,persistState,signal,...(current?.state===undefined?{}:{state:current.state})};
    if(selected.once) {
      const result=await readbackTick({...shared,expectedPrints:initialPrints},dependencies);await report(result);
      return ["UPSTREAM_OBSERVED","UNCHANGED"].includes(result.status)?0:result.status==="ABORTED"?130:1;
    }
    const result=await runReadbackMonitor({...shared,getExpectedPrints:expected,onReport:report},dependencies);
    if(result.ticks===0||result.status==="ABORTED"||lastStatus!==result.status)await report(wrapperReport(result.status,"MONITOR_STOPPED"));
    return result.status==="ABORTED"?130:result.status==="DISABLED"?0:1;
  }catch(error) {
    try{await report(wrapperReport(dependencies.signal?.aborted?"ABORTED":"BLOCKED",error instanceof CliFailure?error.code:"READBACK_CLI_FAILED"));}catch{/* Output failure is terminal; never echo unsanitized diagnostics. */}
    return dependencies.signal?.aborted?130:1;
  }finally{try{db?.close();}finally{owner?.release();}}
}

if(import.meta.main) {
  const controller=new AbortController(),stop=()=>controller.abort();process.on("SIGTERM",stop);process.on("SIGINT",stop);
  try{process.exitCode=await runPythReadbackCli(process.argv.slice(2),{signal:controller.signal});}
  finally{process.off("SIGTERM",stop);process.off("SIGINT",stop);}
}
