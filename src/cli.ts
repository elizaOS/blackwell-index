import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { generateIdentity, canonical, signBatch, hash, nodeIdFor } from "./crypto";
import { defaultMethodology, defaultRegistry, parseConfig, type NodeConfig } from "./config";
import { parseMethodology, parseRegistry, observationSchema } from "./validation";
import { Store } from "./store";
import { OracleNode } from "./network";
import { allowedObservation, calculate } from "./engine";
import { collectorCatalog, createCollectors } from "./collectors";
import { publishSnapshot } from "./pyth/runtime";
import { backupNode, createRecoveryKey, inspectBackup, RECOVERY_MARKER, restoreNode } from "./recovery";
import { collectorSchedule, controlledCollectorContext } from "./collection-control";
import type { NodeIdentity, Observation, SignedBatch } from "./types";

const {values,positionals}=parseArgs({args:process.argv.slice(2),allowPositionals:true,options:{
  config:{type:"string",default:"config/node.local.json"},dir:{type:"string",default:"."},providers:{type:"string"},
  peers:{type:"string"},port:{type:"string"},host:{type:"string"},"allow-loopback":{type:"boolean",default:false},at:{type:"string"},sequence:{type:"string"},
  output:{type:"string"},input:{type:"string"},"key-file":{type:"string"},target:{type:"string"},
}});
const command=positionals[0]??"help";
const root=resolve(values.dir!), configPath=resolve(root,values.config!);
const output=(value:unknown)=>process.stdout.write(`${JSON.stringify(value,null,2)}\n`);
function readJson(path:string):unknown {return JSON.parse(readFileSync(path,"utf8")) as unknown;}
function writeNew(path:string,value:string):void {mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,value,{encoding:"utf8",mode:0o600,flag:"wx"});}
function load():{config:NodeConfig;node:OracleNode;store:Store} {
  const config=parseConfig(readJson(configPath)), identity=readJson(resolve(root,config.identityPath)) as NodeIdentity;
  if(!identity||identity.nodeId!==nodeIdFor(identity.publicKey)||!identity.privateKeyPem)throw new Error("Invalid local identity");
  const registry=parseRegistry(readJson(resolve(root,config.registryPath))),methodology=parseMethodology(readJson(resolve(root,config.methodologyPath)));
  if(config.network!==registry.network)throw new Error("Config and registry network mismatch");
  const store=new Store(resolve(root,config.databasePath));
  store.saveConfiguration(registry);store.saveConfiguration(methodology);
  return {config,store,node:new OracleNode({identity,registry,methodology,store,publicDir:resolve(import.meta.dir,"../public")})};
}
async function collect(config:NodeConfig,node:OracleNode,store:Store):Promise<void> {
  const observations:Observation[]=[],errors:string[]=[];
  for(const collector of createCollectors(config.collectors)) {
    const provider=node.options.registry.providers.find(p=>p.id===collector.provider);
    if(!provider?.rights.collect||(provider.rights.expiresAt!==null&&provider.rights.expiresAt<Date.now())) {errors.push(`${collector.id}: collection permission not configured`);continue;}
    const schedule=collectorSchedule(store,collector.id);
    if(!schedule.eligible){errors.push(`${collector.id}: ${schedule.code}; nextAttemptAt=${schedule.nextAttemptAt}`);continue;}
    try {
      const result=await collector.collect(controlledCollectorContext(store,collector.id,{now:Date.now,env:process.env,fetch,archive:r=>store.archive(r)}));
      for(const observation of result.observations) {
        const parsed=observationSchema.safeParse(observation);
        if(parsed.success)observations.push(observation);else errors.push(`${collector.id}: observation schema rejected`);
      }
      errors.push(...result.errors);
    }catch {errors.push(`${collector.id}: collector failed`);}
  }
  const now=Date.now();store.capture(observations,errors,now);
  const identity=node.options.identity;
  const batch=signBatch({schemaVersion:1,network:config.network,nodeId:identity.nodeId,publicKey:identity.publicKey,
    sequence:store.nextSequence(identity.nodeId),createdAt:now,observations:observations.filter(o=>allowedObservation(o,node.options.registry,now,"share"))},identity);
  node.receive(batch);
  const peers=await node.sync(config.peers,config.allowLoopbackPeers);
  const snapshot=node.snapshot();store.snapshot(snapshot);
  const pyth=config.pythManifestPath?await publishSnapshot(snapshot,readJson(resolve(root,config.pythManifestPath)),store):{status:"DISABLED"};
  output({collectedAt:now,realObservationCount:observations.length,sharedObservationCount:batch.payload.observations.length,
    models:[...new Set(observations.map(o=>o.model))].sort(),errors,schedules:config.collectors.map(id=>collectorSchedule(store,id)),peers,snapshotHash:hash(snapshot),publishable:snapshot.publishable,pyth});
}
async function readSecret():Promise<string> {
  if(!process.stdin.isTTY||!process.stdin.setRawMode)throw new Error("Credentials require a terminal; alternatively set the documented environment variable in a secret manager");
  process.stdout.write("API key (hidden): ");process.stdin.setRawMode(true);process.stdin.resume();
  return new Promise((resolveSecret,reject)=>{
    let secret="";
    const finish=(cancel=false)=>{process.stdin.off("data",onData);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write("\n");cancel?reject(new Error("Cancelled")):resolveSecret(secret);};
    const onData=(chunk:Buffer)=>{for(const char of chunk.toString()){if(char==="\u0003")return finish(true);if(char==="\r"||char==="\n")return finish();if(char==="\u007f"){secret=secret.slice(0,-1);continue;}if(char>=" "&&secret.length<8192)secret+=char;}};
    process.stdin.on("data",onData);
  });
}
async function main():Promise<void> {
  if(command==="backup-keygen") {
    if(!values.output)throw new Error("backup-keygen requires --output KEY_FILE");
    output(createRecoveryKey(resolve(root,values.output)));return;
  }
  if(["backup","backup-inspect","restore"].includes(command)) {
    if(!values["key-file"])throw new Error("Recovery commands require --key-file KEY_FILE");
    const key=resolve(root,values["key-file"]);
    if(command==="backup") {
      if(!values.output)throw new Error("backup requires --output BUNDLE_FILE");
      output(backupNode(root,configPath,resolve(root,values.output),key));return;
    }
    if(!values.input)throw new Error("Recovery requires --input BUNDLE_FILE");
    if(command==="backup-inspect"){output(inspectBackup(resolve(root,values.input),key));return;}
    if(!values.target)throw new Error("restore requires --target NEW_DIRECTORY");
    output(restoreNode(resolve(root,values.input),key,resolve(root,values.target)));return;
  }
  if(["run","collect"].includes(command)&&existsSync(resolve(root,RECOVERY_MARKER)))throw new Error("RECOVERY_REVIEW_REQUIRED: review the recovery record before enabling this node");
  // Explicit process/secret-manager values take precedence over this node's local file.
  const localEnv=resolve(root,".env");
  const credentialsPath=resolve(root,"data/credentials.json");
  const allowedEnvs=new Set(collectorCatalog.flatMap(c=>[...(c.credentialEnvs??(c.credentialEnv?[c.credentialEnv]:[])),...(c.configurationEnvs??[])]));
  if(command!=="credentials") {
    if(existsSync(credentialsPath)) {
      const credentials=readJson(credentialsPath);
      if(!credentials||typeof credentials!=="object"||Array.isArray(credentials))throw new Error("Invalid local credential file");
      for(const [name,value] of Object.entries(credentials))if(allowedEnvs.has(name)&&typeof value==="string"&&process.env[name]===undefined)process.env[name]=value;
    }
    if(existsSync(localEnv))for(const [name,value] of Object.entries(parseEnv(readFileSync(localEnv,"utf8"))))if(allowedEnvs.has(name)&&process.env[name]===undefined)process.env[name]=value;
  }
  if(command==="setup") {
    if(existsSync(configPath))throw new Error("Configuration already exists; use the existing configuration or a different --dir");
    const identity=generateIdentity();
    const config:NodeConfig={schemaVersion:1,network:"sbx-mainnet",identityPath:"data/node-identity.json",databasePath:"data/node.sqlite",
      registryPath:"config/registry.local.json",methodologyPath:"config/methodology.local.json",host:values.host??"127.0.0.1",port:Number(values.port??3410),intervalMs:300000,
      collectors:values.providers?.split(",").filter(Boolean)??collectorCatalog.filter(c=>c.defaultEnabled).map(c=>c.id),peers:values.peers?.split(",").filter(Boolean)??[],allowLoopbackPeers:values["allow-loopback"]!};
    parseConfig(config);
    writeNew(resolve(root,config.identityPath),canonical(identity));
    writeNew(resolve(root,config.registryPath),JSON.stringify(defaultRegistry(config.network),null,2)+"\n");
    writeNew(resolve(root,config.methodologyPath),JSON.stringify(defaultMethodology(),null,2)+"\n");
    writeNew(configPath,JSON.stringify(config,null,2)+"\n");
    output({nodeId:identity.nodeId,publicKey:identity.publicKey,config:configPath,collectors:config.collectors,
      credentials:collectorCatalog.filter(c=>config.collectors.includes(c.id)&&c.credentialEnv).map(c=>({collector:c.id,variables:(c.credentialEnvs??[c.credentialEnv!]).map(name=>({name,configured:Boolean(process.env[name])})),documentation:c.documentation})),
      next:"Run collect for local real-source diagnostics. Configure approved source rights, trusted independent operators, methodology and bootstrap peers before benchmark publication."});
    return;
  }
  if(command==="credentials") {
    const descriptor=collectorCatalog.find(c=>c.id===positionals[1]);
    if(!descriptor?.credentialEnv)throw new Error("Choose a collector with an API key; see providers command");
    const variable=positionals[2]??descriptor.credentialEnv;
    if(!(descriptor.credentialEnvs??[descriptor.credentialEnv]).includes(variable))throw new Error("Environment variable does not belong to the selected collector");
    const secret=await readSecret();if(!secret)throw new Error("Empty credential");
    const existing=existsSync(credentialsPath)?readJson(credentialsPath):{};
    if(!existing||typeof existing!=="object"||Array.isArray(existing)||Object.values(existing).some(v=>typeof v!=="string"))throw new Error("Invalid local credential file");
    if(Object.hasOwn(existing,variable))throw new Error("Credential already exists; update it through your secret manager or edit the protected credential file");
    mkdirSync(dirname(credentialsPath),{recursive:true,mode:0o700});
    writeFileSync(credentialsPath,JSON.stringify({...existing,[variable]:secret})+"\n",{mode:0o600});chmodSync(credentialsPath,0o600);
    output({credential:variable,saved:"data/credentials.json",note:"Local only; enable the collector and its collection rights in configuration."});return;
  }
  if(command==="providers"){output(collectorCatalog);return;}
  if(!["run","collect","status","replay","reproduce"].includes(command)) {
    process.stdout.write("Blackwell Index node\n\nsetup [--dir PATH] [--providers oracle-public,azure-retail] [--peers https://NODE]\ncredentials COLLECTOR [ENV_NAME]   save one API key locally using hidden terminal input\nproviders              list supported adapters and key requirements\ncollect                collect real data once and sync peers\nrun                    serve API and collect continuously\nstatus                 inspect local counts, identity and readiness\nreplay --at EPOCH_MS    explore observations known at a historical time\nreproduce --sequence N reproduce an archived snapshot with its exact inputs and configuration\nbackup-keygen --output KEY_FILE\nbackup --key-file KEY_FILE --output BUNDLE_FILE\nbackup-inspect --key-file KEY_FILE --input BUNDLE_FILE\nrestore --key-file KEY_FILE --input BUNDLE_FILE --target NEW_DIRECTORY\n\nAll commands accept --dir and --config. No keys or synthetic prices are bundled. Recovery creates a new identity and blocks run/collect pending review.\n");return;
  }
  const {config,node,store}=load();
  if(command==="status") {output({nodeId:node.options.identity.nodeId,counts:store.counts(),coverage:store.captureCounts(),snapshot:node.snapshot(),history:store.verifyHistory()});store.close();return;}
  if(command==="reproduce") {
    const sequence=Number(values.sequence),history=store.verifyHistory();if(!history.valid)throw new Error("Historical journal verification failed");
    const original=store.getSnapshot(sequence);if(!original)throw new Error("Snapshot does not exist");
    const registry=parseRegistry(store.configuration(original.registryHash)),methodology=parseMethodology(store.configuration(original.methodologyHash));
    const hashes=[...new Set([...original.inputBatchHashes,...original.rejected.map(x=>x.batchHash)])];
    const inputs=hashes.map(digest=>{
      const row=store.db.query("SELECT payload FROM reports WHERE hash=?").get(digest) as {payload:string}|null;
      if(!row)throw new Error("Archived input unavailable");const batch=JSON.parse(row.payload) as SignedBatch;if(hash(batch)!==digest)throw new Error("Archived input digest mismatch");return batch;
    });
    const reproduced=calculate(inputs,registry,methodology,original.calculatedAt),matches=hash(reproduced)===hash(original);
    output({sequence,matches,originalHash:hash(original),reproducedHash:hash(reproduced),history,coverage:store.captureCounts()});store.close();if(!matches)process.exitCode=1;return;
  }
  if(command==="replay") {
    const at=Number(values.at);if(!Number.isSafeInteger(at)||at<1)throw new Error("replay requires --at epoch milliseconds");
    output({mode:"REPLAY_WITH_CURRENT_CONFIG",warning:"Use archived registry and methodology files effective at this time; current config is not evidence of historical membership.",
      history:store.verifyHistory(),snapshot:calculate(store.reportsAt(at),node.options.registry,node.options.methodology,at)});store.close();return;
  }
  if(command==="collect"){try{await collect(config,node,store);}finally{store.close();}return;}
  const server=Bun.serve({hostname:config.host,port:config.port,maxRequestBodySize:8_000_000,idleTimeout:15,
    fetch:(request,server)=>node.handle(request,server.requestIP(request)?.address??"unknown")});
  output({status:"RUNNING",address:server.url.toString(),nodeId:node.options.identity.nodeId});
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
  const cycle=async()=>{try{await collect(config,node,store);}catch(e){output({error:e instanceof Error?e.message:"Collection cycle failed"});}if(!stopped)timer=setTimeout(cycle,config.intervalMs);};
  const stop=()=>{stopped=true;if(timer)clearTimeout(timer);server.stop(true);process.exit(0);};
  process.on("SIGTERM",stop);process.on("SIGINT",stop);
  await cycle();
}
main().catch(e=>{process.stderr.write(`${e instanceof Error?e.message:"Command failed"}\n`);process.exitCode=1;});
