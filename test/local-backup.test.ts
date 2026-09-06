// Isolated synthetic recovery fixtures only. No provider, Pyth or deployed-node traffic.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ARCHIVE_TABLES, parseArchiveDescriptor, type ArchiveDescriptor } from "../src/archive-protocol";
import { beginCheckpoint, initializeCheckpointStorage, readCheckpointBlock, sealCheckpoint } from "../src/checkpoint";
import { ChunkedJournal, CHUNKED_JOURNAL_VERSION, EVIDENCE_CHUNK_BYTES } from "../src/chunked-journal";
import type { NodeConfig } from "../src/config";
import { canonical, generateIdentity, hash, signBatch } from "../src/crypto";
import { calculate } from "../src/engine";
import { backupLocalStreamNode } from "../src/local-backup";
import { createRecoveryKey, RECOVERY_MARKER } from "../src/recovery";
import { readStreamContainer } from "../src/stream-container";
import { backupStreamFrames, inspectStreamBackup, restoreStreamNode, type StreamRecoveryOptions } from "../src/stream-recovery";
import { Store } from "../src/store";
import { publishSnapshot } from "../src/pyth/runtime";
import { PYTH_PROTOCOL, type PythManifest, type PythPublication } from "../src/pyth";
import { verifyPythRuntimeState } from "../src/pyth/recovery-state";
import type { NodeIdentity, Registry } from "../src/types";
import { environment, NOW } from "./helpers";

const HOSTED_RELEASE="aa".repeat(20),LOCAL_RELEASE="bb".repeat(20),OPERATOR_GROUP="isolated-local-recovery-test";
const directories:string[]=[],stores=new Set<Store>();
afterEach(()=>{for(const store of stores)store.close();stores.clear();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function privateJson(path:string,value:unknown) {mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,canonical(value),{mode:0o600});}
function readJson<T>(path:string):T {return JSON.parse(readFileSync(path,"utf8")) as T;}
const digest=(body:Uint8Array)=>createHash("sha256").update(body).digest("hex");
function logicalState(store:Store) {
  return ARCHIVE_TABLES.map(table=>store.db.query(`SELECT ${table.columns.join(",")} FROM ${table.name} ORDER BY ${table.order}`).all());
}
function fileState(paths:string[]) {return paths.map(path=>({path,bytes:existsSync(path)?digest(readFileSync(path)):null}));}

async function fixture() {
  const directory=mkdtempSync(join(tmpdir(),"sbx-local-backup-test-"));directories.push(directory);
  const hostedStore=new Store(join(directory,"hosted.sqlite"));stores.add(hostedStore);
  const journal=new ChunkedJournal(hostedStore.db),e=environment(),hostedIdentity=e.identities[0]!;
  initializeCheckpointStorage(journal);journal.saveConfiguration(e.registry);journal.saveConfiguration(e.methodology);
  const body=Buffer.alloc(EVIDENCE_CHUNK_BYTES+31,53),evidenceHash=digest(body);
  await journal.archive({hash:evidenceHash,source:"alpha-api",url:"https://alpha.example/prices",receivedAt:NOW-1000,contentType:"application/octet-stream",body});
  const observations=e.observations.map(observation=>({...observation,evidenceHash}));
  journal.capture(observations,[],NOW);journal.nextSequence(hostedIdentity.nodeId);
  const batches=e.identities.map(identity=>signBatch({schemaVersion:1,network:e.registry.network,nodeId:identity.nodeId,publicKey:identity.publicKey,sequence:1,createdAt:NOW,observations},identity));
  for(const batch of batches)journal.accept(batch,NOW,true);
  journal.snapshot(calculate(batches,e.registry,e.methodology,NOW));
  const metadata={nodeName:"primary" as const,operatorGroup:"isolated-hosted-test",release:HOSTED_RELEASE,network:e.registry.network,intervalMs:300000,registry:e.registry,methodology:e.methodology};
  const descriptor=beginCheckpoint(journal,hostedIdentity,metadata,{now:NOW+1000});
  async function* frames() {
    yield Buffer.from(canonical(descriptor));
    for(let index=0;;index++) {
      const block=readCheckpointBlock(journal,hostedIdentity,metadata,descriptor.payload.checkpointId,index,NOW+1000);
      if(!block)break;yield Buffer.from(canonical(block));
    }
    yield Buffer.from(canonical(sealCheckpoint(journal,hostedIdentity,metadata,descriptor.payload.checkpointId,NOW+1000)));
  }
  const keyPath=join(directory,"recovery.key"),hostedArchive=join(directory,"hosted.sbx-stream");createRecoveryKey(keyPath);
  const hostedOptions:StreamRecoveryOptions={expectedNodeId:hostedIdentity.nodeId,expectedRelease:HOSTED_RELEASE};
  const hostedBackup=await backupStreamFrames(frames(),hostedArchive,keyPath,hostedOptions);
  const root=join(directory,"local");await restoreStreamNode(hostedArchive,keyPath,root,hostedOptions);
  const configPath=join(root,"config/node.local.json"),config=readJson<NodeConfig>(configPath);
  const identity=readJson<NodeIdentity>(join(root,config.identityPath));
  const store=new Store(join(root,config.databasePath));stores.add(store);
  const output=join(directory,"local.sbx-stream"),options={expectedNodeId:identity.nodeId,expectedRelease:LOCAL_RELEASE,operatorGroup:OPERATOR_GROUP};
  return {directory,root,configPath,config,identity,store,keyPath,output,options,e,batches,body,evidenceHash,observations,hostedIdentity,hostedBackup};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
test("actual four-model ChunkedJournal publication state survives encrypted V2 restore and prevents replay",async()=>{
  const f=await fixture(),post=recordPostReviewFixture(f),snapshot=post.snapshot,now=snapshot.calculatedAt;
  expect(snapshot.publishable).toBe(true);
  const bindings=snapshot.feeds.filter(feed=>feed.kind!=="PROVIDER").map((feed,index)=>({indexFeedId:feed.id,pythFeedId:index+1,symbol:`TEST.${feed.id}/USD`,exponent:-9,minPublishers:3}));
  expect(bindings.length).toBe(5);
  const manifest:PythManifest={schemaVersion:1,enabled:true,network:snapshot.network,methodologyHash:snapshot.methodologyHash,registryHash:snapshot.registryHash,
    agentUrl:"ws://127.0.0.1:8910/v1/jrpc",maxAgeMs:30000,futureToleranceMs:1000,
    approval:{status:"APPROVED",publisherPublicKey:"11111111111111111111111111111111",evidence:"Isolated test only",verifiedAt:NOW-1000,expiresAt:NOW+100000,
      protocol:PYTH_PROTOCOL,relayerUrls:["wss://publisher.example.test/v1/transaction"]},bindings};
  let calls=0;
  const dependencies={now:()=>now,fetchCatalog:async()=>bindings.map(binding=>({pyth_lazer_id:binding.pythFeedId,symbol:binding.symbol,exponent:binding.exponent,min_publishers:3,state:"stable"})),
    submit:async(publication:PythPublication)=>{
      calls++;return {status:"QUEUED_LOCAL" as const,requestId:publication.request.id,snapshotHash:publication.snapshotHash,queuedAt:now};
    }};
  const journal=new ChunkedJournal(f.store.db);
  expect((await publishSnapshot(snapshot,manifest,journal,dependencies)).status).toBe("QUEUED_LOCAL");
  const states=f.store.db.query("SELECT * FROM pyth_submission_state ORDER BY feed_id").all(),receipts=f.store.db.query("SELECT * FROM pyth_queue_receipts").all();
  const result=await backup(f);expect(result.pythRecovery).toEqual({present:true,states:5,receipts:1,locks:0,upstreamPublication:"NOT_PROVEN"});
  expect(f.store.db.query("SELECT * FROM pyth_submission_state ORDER BY feed_id").all()).toEqual(states);
  const destination=join(f.directory,"pyth-restored");await restoreStreamNode(f.output,f.keyPath,destination,f.options);
  const config=readJson<NodeConfig>(join(destination,"config/node.local.json"));expect(config.pythManifestPath).toBeUndefined();
  expect(existsSync(join(destination,RECOVERY_MARKER))).toBe(true);
  const restored=new Store(join(destination,config.databasePath));stores.add(restored);
  expect(restored.db.query("SELECT * FROM pyth_submission_state ORDER BY feed_id").all()).toEqual(states);
  expect(restored.db.query("SELECT * FROM pyth_queue_receipts").all()).toEqual(receipts);
  expect(verifyPythRuntimeState(restored.db,Date.now()).states).toBe(5);
  // Deliberately call the isolated runtime directly; production CLI remains blocked by its marker.
  expect((await publishSnapshot(snapshot,manifest,restored,dependencies)).status).toBe("NO_NEW_SOURCE_DATA");expect(calls).toBe(1);
  const newIdentity=readJson<NodeIdentity>(join(destination,config.identityPath)),next=join(f.directory,"pyth-next.sbx-stream");
  expect((await backupLocalStreamNode(destination,join(destination,"config/node.local.json"),next,f.keyPath,{...f.options,expectedNodeId:newIdentity.nodeId})).pythRecovery.states).toBe(5);
},30000);
function backup(f:Fixture,options:Partial<Parameters<typeof backupLocalStreamNode>[4]>={}) {
  return backupLocalStreamNode(f.root,f.configPath,f.output,f.keyPath,{...f.options,...options});
}
function recordPostReviewFixture(f:Fixture) {
  // Direct journal writes represent an isolated post-review operator fixture. Never remove the CLI marker.
  const registry:Registry={...readJson<Registry>(join(f.root,f.config.registryPath)),version:"local-fixture-reviewed",
    operators:[...f.e.registry.operators.filter(operator=>operator.nodeId!==f.hostedIdentity.nodeId),
      {nodeId:f.identity.nodeId,publicKey:f.identity.publicKey,operatorGroup:OPERATOR_GROUP,enabled:true}]};
  privateJson(join(f.root,f.config.registryPath),registry);f.store.saveConfiguration(registry);
  const observations=f.observations.map(observation=>({...observation,observedAt:NOW+2000}));
  f.store.capture(observations,[],NOW+2000);
  const report=signBatch({schemaVersion:1,network:registry.network,nodeId:f.identity.nodeId,publicKey:f.identity.publicKey,
    sequence:f.store.nextSequence(f.identity.nodeId),createdAt:NOW+2000,observations},f.identity);
  f.store.accept(report,NOW+2000,true);
  const snapshot=calculate([f.batches[1]!,f.batches[2]!,report],registry,f.e.methodology,NOW+2000);f.store.snapshot(snapshot);
  return {registry,report,snapshot};
}
async function archiveDescriptor(path:string,key:string,options:StreamRecoveryOptions) {
  let descriptor:ArchiveDescriptor|undefined;
  for await(const frame of readStreamContainer(path,key))if(!descriptor)descriptor=parseArchiveDescriptor(Buffer.from(frame).toString("utf8"),options.expectedNodeId,options.expectedRelease);
  if(!descriptor)throw new Error("Test archive descriptor missing");return descriptor;
}
function provenance(store:Store) {
  return store.db.query("SELECT descriptor,seal,archive_sha256,archive_bytes FROM archive_recovery_provenance WHERE id=1").get() as {descriptor:string;seal:string;archive_sha256:string;archive_bytes:number};
}
async function cli(f:Fixture,args:string[]=[],preload?:string,scratch?:string) {
  const child=Bun.spawn([process.execPath,...(preload?["--preload",preload]:[]),resolve("src/cli.ts"),"backup-stream","--dir",f.root,
    "--operator-group",OPERATOR_GROUP,"--expected-node-id",f.identity.nodeId,"--expected-release",LOCAL_RELEASE,
    "--key-file",f.keyPath,"--output",f.output,...args],{cwd:resolve("."),stdout:"pipe",stderr:"pipe",
      ...(scratch?{env:{...process.env,TMPDIR:scratch,TMP:scratch,TEMP:scratch}}:{})});
  const timeout=setTimeout(()=>child.kill("SIGKILL"),15000);
  try {
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    return {code,stdout,stderr};
  } finally {clearTimeout(timeout);}
}

test("local V2 re-backup preserves two generations of evidence, history, counters and provenance without restoring authority",async()=>{
  const f=await fixture(),post=recordPostReviewFixture(f),originalProvenance=provenance(f.store);
  privateJson(join(f.root,"data/credentials.json"),{LAMBDA_API_KEY:"test-private-provider-key-not-copied"});
  privateJson(join(f.root,"data/private-pyth.json"),{privateKey:"test-private-pyth-key-not-copied"});
  privateJson(f.configPath,{...f.config,collectors:["lambda-cloud"],peers:["https://never-contacted.invalid"],pythManifestPath:"data/private-pyth.json"});
  const sourceState=logicalState(f.store),sourceFiles=fileState([f.configPath,join(f.root,f.config.identityPath),join(f.root,f.config.registryPath),join(f.root,RECOVERY_MARKER)]);
  const result=await backup(f);
  expect(result.sourceName).toBe("local");expect(result.contentInspection).toBe("VERIFIED");
  expect(result.privateKeysIncluded).toBe(false);expect(result.providerCredentialsIncluded).toBe(false);
  expect(logicalState(f.store)).toEqual(sourceState);expect(fileState(sourceFiles.map(file=>file.path))).toEqual(sourceFiles);
  expect(provenance(f.store)).toEqual(originalProvenance);
  const inspected=await inspectStreamBackup(f.output,f.keyPath,f.options);
  expect(inspected.history).toEqual({valid:true,count:2});expect(inspected.reproducedSnapshots).toBe(2);
  expect(inspected.observations).toBe(24);expect(inspected.evidenceBytes).toBe(f.body.length);
  const descriptor=await archiveDescriptor(f.output,f.keyPath,f.options);
  expect(descriptor.payload.source.nodeName).toBe("local");expect(descriptor.payload.source.nodeId).toBe(f.identity.nodeId);
  expect(descriptor.payload.source.operatorGroup).toBe(OPERATOR_GROUP);expect(descriptor.payload.source.release).toBe(LOCAL_RELEASE);
  expect(descriptor.payload.configuration.registryHash).toBe(hash(post.registry));
  expect(descriptor.payload.recoveryProvenanceHash).toMatch(/^[a-f0-9]{64}$/);
  const destination=join(f.directory,"second-generation"),restored=await restoreStreamNode(f.output,f.keyPath,destination,f.options);
  expect(restored.newNodeId).not.toBe(f.identity.nodeId);expect(restored.newNodeId).not.toBe(f.hostedIdentity.nodeId);
  const config=readJson<NodeConfig>(join(destination,"config/node.local.json"));
  expect(config.collectors).toEqual([]);expect(config.peers).toEqual([]);expect(config.pythManifestPath).toBeUndefined();expect(config.host).toBe("127.0.0.1");
  expect(existsSync(join(destination,"data/credentials.json"))).toBe(false);expect(existsSync(join(destination,"data/private-pyth.json"))).toBe(false);
  const restoredStore=new Store(join(destination,config.databasePath));stores.add(restoredStore);
  expect(restoredStore.verifyHistory()).toEqual(f.store.verifyHistory());expect(restoredStore.configuration(hash(post.registry))).toEqual(post.registry);
  expect(restoredStore.db.query("SELECT id,value FROM counters ORDER BY id").all()).toEqual(f.store.db.query("SELECT id,value FROM counters ORDER BY id").all());
  expect(restoredStore.db.query("SELECT version FROM local_journal_storage WHERE id=1").get()).toEqual({version:CHUNKED_JOURNAL_VERSION});
  const preserved=restoredStore.configuration(descriptor.payload.recoveryProvenanceHash!) as Record<string,unknown>;
  expect(preserved).toEqual({format:"SBX_RECOVERY_PROVENANCE_V1",descriptor:JSON.parse(originalProvenance.descriptor),seal:JSON.parse(originalProvenance.seal),
    archiveSha256:f.hostedBackup.sha256,archiveBytes:f.hostedBackup.archiveBytes});
  expect(provenance(restoredStore).archive_sha256).toBe(inspected.archiveSha256);
  expect(readFileSync(join(destination,"data/node-identity.json"),"utf8")).not.toContain(f.identity.privateKeyPem);
  expect(readFileSync(f.output).includes(Buffer.from("test-private-provider-key-not-copied"))).toBe(false);
  expect(statSync(f.output).mode&0o777).toBe(0o600);expect(statSync(join(destination,config.databasePath)).mode&0o777).toBe(0o600);
  for(const command of ["run","collect"]) {
    const child=Bun.spawn([process.execPath,resolve("src/cli.ts"),command,"--dir",destination],{cwd:resolve("."),stdout:"pipe",stderr:"pipe"});
    const stderr=await new Response(child.stderr).text();expect(await child.exited).toBe(1);expect(stderr).toContain("RECOVERY_REVIEW_REQUIRED");
  }
},30000);

test("an untouched disabled restore can be re-backed up without mutating its new registry or source journal",async()=>{
  const f=await fixture(),registry=readJson<Registry>(join(f.root,f.config.registryPath)),state=logicalState(f.store);
  expect(f.store.configuration(hash(registry))).toBeNull();
  await backup(f);
  expect(logicalState(f.store)).toEqual(state);expect(f.store.configuration(hash(registry))).toBeNull();expect(existsSync(join(f.root,RECOVERY_MARKER))).toBe(true);
  const descriptor=await archiveDescriptor(f.output,f.keyPath,f.options);expect(descriptor.payload.configuration.registryHash).toBe(hash(registry));
  expect((await inspectStreamBackup(f.output,f.keyPath,f.options)).reproducedSnapshots).toBe(1);
},30000);

test("a live WAL checkpoint excludes writes after the local snapshot boundary and never initializes archive tables on the source",async()=>{
  const f=await fixture();recordPostReviewFixture(f);
  expect(f.store.db.query("PRAGMA journal_mode").get()).toEqual({journal_mode:"wal"});
  expect(existsSync(join(f.root,`${f.config.databasePath}-wal`))).toBe(true);
  const configFiles=fileState([f.configPath,join(f.root,f.config.identityPath),join(f.root,f.config.registryPath)]);
  const pending=backup(f);
  // The synchronous consistent copy precedes the first await; this is an ordinary committed concurrent writer.
  f.store.capture(f.observations,[],NOW+3000);expect(f.store.nextSequence(f.identity.nodeId)).toBe(2);
  await pending;
  expect(f.store.captureCounts().count).toBe(3);expect(fileState(configFiles.map(file=>file.path))).toEqual(configFiles);
  expect(f.store.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='archive_entries'").get()).toBeNull();
  const destination=join(f.directory,"frozen-wal"),result=await restoreStreamNode(f.output,f.keyPath,destination,f.options);
  expect(result.observations).toBe(24);expect(result.reproducedSnapshots).toBe(2);
  const restored=new Store(join(destination,"data/node.sqlite"));stores.add(restored);
  expect(restored.captureCounts().count).toBe(2);expect(restored.db.query("SELECT value FROM counters WHERE id=?").get(f.identity.nodeId)).toEqual({value:1});
},30000);

test("successful local export leaves the original SQLite and committed WAL bytes unchanged",async()=>{
  const f=await fixture();recordPostReviewFixture(f);
  const database=join(f.root,f.config.databasePath),before=fileState([database,`${database}-wal`]);
  await backup(f);expect(fileState(before.map(file=>file.path))).toEqual(before);
},30000);

test("a third-generation local archive retains the original provenance link and all historical configurations",async()=>{
  const f=await fixture();recordPostReviewFixture(f);await backup(f);
  const previousDescriptor=await archiveDescriptor(f.output,f.keyPath,f.options),nextRoot=join(f.directory,"next-source");
  await restoreStreamNode(f.output,f.keyPath,nextRoot,f.options);
  const nextConfigPath=join(nextRoot,"config/node.local.json"),nextConfig=readJson<NodeConfig>(nextConfigPath);
  const nextIdentity=readJson<NodeIdentity>(join(nextRoot,nextConfig.identityPath)),nextOutput=join(f.directory,"third.sbx-stream");
  const nextOptions={expectedNodeId:nextIdentity.nodeId,expectedRelease:LOCAL_RELEASE,operatorGroup:OPERATOR_GROUP};
  await backupLocalStreamNode(nextRoot,nextConfigPath,nextOutput,f.keyPath,nextOptions);
  const descriptor=await archiveDescriptor(nextOutput,f.keyPath,nextOptions),destination=join(f.directory,"third-generation");
  await restoreStreamNode(nextOutput,f.keyPath,destination,nextOptions);
  const restored=new Store(join(destination,"data/node.sqlite"));stores.add(restored);
  expect(restored.verifyHistory()).toEqual(f.store.verifyHistory());
  const direct=restored.configuration(descriptor.payload.recoveryProvenanceHash!) as {descriptor:ArchiveDescriptor};
  expect(direct.descriptor).toEqual(previousDescriptor);
  expect(restored.configuration(previousDescriptor.payload.recoveryProvenanceHash!)).toBeTruthy();
  expect(restored.configuration(hash(f.e.registry))).toEqual(f.e.registry);
  expect(existsSync(join(nextRoot,RECOVERY_MARKER))).toBe(true);expect(existsSync(join(destination,RECOVERY_MARKER))).toBe(true);
},30000);

test("a configuration change during export cannot produce a successful backup acknowledgement",async()=>{
  const f=await fixture(),before=canonical(logicalState(f.store));
  const pending=backup(f);privateJson(f.configPath,{...f.config,intervalMs:600000});
  await expect(pending).rejects.toThrow("CONFIGURATION_CHANGED");
  expect(canonical(logicalState(f.store))).toBe(before);expect(existsSync(join(f.root,RECOVERY_MARKER))).toBe(true);
},30000);

test("source inode replacement after the consistent copy is rejected even when replacement bytes are identical",async()=>{
  const f=await fixture(),database=join(f.root,f.config.databasePath),retired=join(f.directory,"retired-source.sqlite");
  const pending=backup(f);
  // The backup has made its synchronous copy; close this fixture's writer before replacing its inode.
  f.store.close();stores.delete(f.store);const originalInode=statSync(database).ino;
  renameSync(database,retired);copyFileSync(retired,database);const replacement=fileState([database]);
  expect(statSync(database).ino).not.toBe(originalInode);expect(readFileSync(database)).toEqual(readFileSync(retired));
  await expect(pending).rejects.toThrow("SOURCE_DATABASE_REPLACED");
  expect(fileState([database])).toEqual(replacement);expect(existsSync(join(f.root,RECOVERY_MARKER))).toBe(true);
},30000);

for(const [name,mutate] of [
  ["unknown table",(f:Fixture)=>f.store.db.exec("CREATE TABLE unexpected_private_table (secret TEXT)")],
  ["source view",(f:Fixture)=>f.store.db.exec("CREATE VIEW unexpected_view AS SELECT payload FROM configurations")],
  ["source trigger",(f:Fixture)=>f.store.db.exec("CREATE TRIGGER unexpected_trigger AFTER INSERT ON configurations BEGIN UPDATE counters SET value=value+1; END")],
  ["changed core schema",(f:Fixture)=>f.store.db.exec("ALTER TABLE captures ADD COLUMN unexpected TEXT")],
  ["unknown storage version",(f:Fixture)=>f.store.db.query("UPDATE local_journal_storage SET version=?").run("unsupported-test-version")],
  ["missing evidence chunk",(f:Fixture)=>f.store.db.query("DELETE FROM evidence_chunks WHERE part=1").run()],
  ["malformed recovery provenance",(f:Fixture)=>f.store.db.query("UPDATE archive_recovery_provenance SET descriptor=?").run("not-json-test-only")],
  ["malformed local configuration",(f:Fixture)=>privateJson(f.configPath,{...f.config,unknownConfigurationField:true})],
  ["symlink database",(f:Fixture)=>{symlinkSync(join(f.root,f.config.databasePath),join(f.root,"data/alias.sqlite"));privateJson(f.configPath,{...f.config,databasePath:"data/alias.sqlite"});}],
  ["mismatched private signer",(f:Fixture)=>privateJson(join(f.root,f.config.identityPath),{...f.identity,privateKeyPem:generateIdentity().privateKeyPem})],
] as const) test(`local backup rejects ${name} without modifying source rows or publishing a completed archive`,async()=>{
  const f=await fixture();mutate(f);const before=canonical(logicalState(f.store));
  await expect(backup(f)).rejects.toThrow();expect(canonical(logicalState(f.store))).toBe(before);expect(existsSync(f.output)).toBe(false);
},30000);

test("local backup requires the expected current identity and an explicit well-formed release pin",async()=>{
  const f=await fixture();
  await expect(backup(f,{expectedNodeId:f.hostedIdentity.nodeId})).rejects.toThrow();
  await expect(backup(f,{expectedRelease:"not-a-release"})).rejects.toThrow();
  await expect(backup(f,{operatorGroup:""})).rejects.toThrow();expect(existsSync(f.output)).toBe(false);
},30000);

test("local backup refuses weak key permissions, symlink sources and existing output without overwriting data",async()=>{
  const f=await fixture();chmodSync(f.keyPath,0o644);
  await expect(backup(f)).rejects.toThrow();expect(existsSync(f.output)).toBe(false);chmodSync(f.keyPath,0o600);
  const alias=join(f.directory,"config-symlink.json");symlinkSync(f.configPath,alias);
  await expect(backupLocalStreamNode(f.root,alias,f.output,f.keyPath,f.options)).rejects.toThrow();expect(existsSync(f.output)).toBe(false);
  writeFileSync(f.output,"existing-private-output",{mode:0o600});await expect(backup(f)).rejects.toThrow();
  expect(readFileSync(f.output,"utf8")).toBe("existing-private-output");
},30000);

test("explicit disk, database and archive budgets fail closed and leave the source recoverable",async()=>{
  const f=await fixture(),before=canonical(logicalState(f.store));
  await expect(backup(f,{minFreeDiskBytes:Number.MAX_SAFE_INTEGER})).rejects.toThrow();expect(existsSync(f.output)).toBe(false);
  await expect(backup(f,{maxDatabaseBytes:1})).rejects.toThrow();expect(existsSync(f.output)).toBe(false);
  await expect(backup(f,{maxArchiveBytes:1024})).rejects.toThrow();expect(existsSync(f.output)).toBe(false);
  expect(canonical(logicalState(f.store))).toBe(before);expect(existsSync(join(f.root,RECOVERY_MARKER))).toBe(true);
},30000);

test("pre-aborted local backups do not produce a completed archive or alter recovery state",async()=>{
  const f=await fixture(),controller=new AbortController(),before=canonical(logicalState(f.store));controller.abort();
  await expect(backup(f,{signal:controller.signal})).rejects.toThrow();expect(existsSync(f.output)).toBe(false);expect(canonical(logicalState(f.store))).toBe(before);
},30000);

test("the local backup CLI independently verifies its archive without loading provider credentials or changing the review marker",async()=>{
  const f=await fixture(),marker=readFileSync(join(f.root,RECOVERY_MARKER),"utf8");
  writeFileSync(join(f.root,"data/credentials.json"),'{"test-private-malformed-credential":',{mode:0o600});
  const result=await cli(f);expect(result.code).toBe(0);expect(result.stderr).toBe("");
  const summary=JSON.parse(result.stdout);expect(summary.sourceName).toBe("local");expect(summary.contentInspection).toBe("VERIFIED");
  expect(summary.sourceBuildVerification).toBe("OPERATOR_ASSERTED");expect(summary.reproducedSnapshots).toBe(1);
  expect(result.stdout).not.toContain("test-private-malformed-credential");expect(result.stdout).not.toContain(f.identity.privateKeyPem);
  expect(readFileSync(join(f.root,RECOVERY_MARKER),"utf8")).toBe(marker);
  expect((await inspectStreamBackup(f.output,f.keyPath,f.options)).reproducedSnapshots).toBe(1);
},30000);

test("the local backup CLI keeps unknown flags, malformed configuration and invalid budget details confidential",async()=>{
  const f=await fixture(),secret="test-only-private-input-do-not-echo";
  for(const args of [[`--${secret}`],["--max-archive-bytes",secret]]) {
    expect(await cli(f,args)).toEqual({code:1,stdout:"",stderr:"HOSTED_BACKUP_IMPORT_FAILED\n"});expect(existsSync(f.output)).toBe(false);
  }
  writeFileSync(f.configPath,`{"${secret}":`,{mode:0o600});
  expect(await cli(f)).toEqual({code:1,stdout:"",stderr:"HOSTED_BACKUP_IMPORT_FAILED\n"});expect(existsSync(f.output)).toBe(false);
},30000);

test("SIGTERM during local archive encryption leaves only private incomplete ciphertext and no successful CLI summary",async()=>{
  const f=await fixture(),before=canonical(logicalState(f.store)),preload=join(f.directory,"signal-test-preload.mjs");
  const hookSeen=join(f.directory,"encrypted-header-hook-seen"),signalSeen=join(f.directory,"sigterm-handler-seen");
  // Observe the real partial header at a bounded exporter yield, then deliver an actual signal.
  // Bun does not replace existing named fs exports through syncBuiltinESMExports; observing the
  // artifact avoids a silently inactive monkey patch. Both observation and signal handling are proved.
  writeFileSync(preload,`import fs from 'node:fs';
    const header=Buffer.from(${JSON.stringify("SBX_NODE_RECOVERY_V2\n")}),partial=${JSON.stringify(`${f.output}.partial`)};
    process.once('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(signalSeen)},'observed',{mode:0o600}));
    function observeHeader() {
      if(fs.existsSync(partial)) {
        const fd=fs.openSync(partial,'r'),bytes=Buffer.alloc(header.length);let count=0;
        try{count=fs.readSync(fd,bytes,0,bytes.length,0);}finally{fs.closeSync(fd);}
        if(count===header.length && bytes.equals(header)) {
          fs.writeFileSync(${JSON.stringify(hookSeen)},'observed',{mode:0o600});process.kill(process.pid,'SIGTERM');return;
        }
      }
      setImmediate(observeHeader);
    } setImmediate(observeHeader);`,{mode:0o600});
  const result=await cli(f,[],preload);
  expect(existsSync(hookSeen)).toBe(true);expect(existsSync(signalSeen)).toBe(true);
  expect(result).toEqual({code:1,stdout:"",stderr:"HOSTED_BACKUP_IMPORT_FAILED\n"});
  expect(existsSync(f.output)).toBe(false);expect(existsSync(`${f.output}.partial`)).toBe(true);
  expect(statSync(`${f.output}.partial`).mode&0o777).toBe(0o600);expect(canonical(logicalState(f.store))).toBe(before);
},30000);

test("FIFO database and key inputs fail without hanging the CLI or creating a completed archive",async()=>{
  const f=await fixture(),fifo=join(f.directory,"source-test.fifo");
  const created=Bun.spawnSync(["mkfifo",fifo],{stdout:"pipe",stderr:"pipe"});expect(created.exitCode).toBe(0);
  privateJson(f.configPath,{...f.config,databasePath:fifo});
  expect(await cli(f)).toEqual({code:1,stdout:"",stderr:"HOSTED_BACKUP_IMPORT_FAILED\n"});expect(existsSync(f.output)).toBe(false);
  privateJson(f.configPath,f.config);
  expect(await cli(f,["--key-file",fifo])).toEqual({code:1,stdout:"",stderr:"HOSTED_BACKUP_IMPORT_FAILED\n"});expect(existsSync(f.output)).toBe(false);
},30000);

test("local copy and inspection scratch directories are removed after success and content-verification failure",async()=>{
  const f=await fixture(),scratch=join(f.directory,"private-child-scratch");mkdirSync(scratch,{mode:0o700});
  expect((await cli(f,[],undefined,scratch)).code).toBe(0);expect(readdirSync(scratch)).toEqual([]);
  f.store.db.query("DELETE FROM evidence_chunks WHERE part=1").run();
  const failedOutput=join(f.directory,"failed-local.sbx-stream");
  expect(await cli(f,["--output",failedOutput],undefined,scratch)).toEqual({code:1,stdout:"",stderr:"HOSTED_BACKUP_IMPORT_FAILED\n"});
  expect(readdirSync(scratch)).toEqual([]);expect(existsSync(failedOutput)).toBe(false);
},30000);
