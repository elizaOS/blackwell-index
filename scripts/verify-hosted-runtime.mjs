/** Isolated workerd smoke test. Empty journal only; no provider calls or remote bindings. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const scratch=mkdtempSync(join(tmpdir(),"sbx-hosted-runtime-test-"));
const release="12".repeat(20), key=join(scratch,"recovery.key"), archive=join(scratch,"node.sbx-backup"),streamArchive=join(scratch,"node-stream.sbx-backup");
const mf=new Miniflare(convertV4MiniflareOptions({workers:[{
  name:"isolated-sbx",modules:true,scriptPath:resolve(process.argv[2]??"data/hosted-recovery-build/index.js"),
  compatibilityDate:"2026-09-06",compatibilityFlags:["nodejs_compat"],
  bindings:{SBX_NETWORK:"sbx-runtime-test",SBX_OPERATOR_GROUP:"isolated-test",SBX_COLLECTORS:"",SBX_COLLECTION_INTERVAL_MS:"86400000",SBX_RELEASE:release},
  durableObjects:{SBX_NODES:{className:"SbxNode",useSQLite:true}},
  serviceBindings:{ASSETS:()=>new Response("Not found",{status:404})},
  outboundService:()=>{throw new Error("TEST_EXTERNAL_NETWORK_FORBIDDEN");},
},{name:"isolated-client",modules:true,script:"export default {fetch(){return new Response('Not found',{status:404})}}",
  compatibilityDate:"2026-09-06",serviceBindings:{RECOVERY:{name:"isolated-sbx",entrypoint:"RecoveryService"}},
}]}));
const timeout=setTimeout(()=>{console.error("HOSTED_RUNTIME_TEST_TIMEOUT");process.exitCode=1;void mf.dispose();},45000);
function cli(args,input) {
  const child=spawnSync("bun",["src/cli.ts",...args],{input,encoding:"utf8",timeout:15000,
    env:{PATH:process.env.PATH,TMPDIR:scratch},maxBuffer:4*1024*1024});
  assert.equal(child.status,0,child.stderr||"CLI failed");return JSON.parse(child.stdout);
}
try {
  const worker=await mf.getWorker("isolated-sbx");
  const before=await (await worker.fetch("https://primary.blackwellindex.com/v1/status")).json();
  const demoResponse=await worker.fetch("https://primary.blackwellindex.com/v1/demo");
  assert.equal(demoResponse.status,200);
  const demo=await demoResponse.json();
  assert.equal(demo.mode,"CENTRALIZED_DEMO");assert.equal(demo.publishable,false);assert.equal(demo.pythPublished,false);
  assert(demo.feeds.every(feed=>feed.price===null));
  const recovery=(await mf.getBindings("isolated-client")).RECOVERY;
  const response=await recovery.fetch("https://recovery.internal/export/primary",{method:"POST"});
  assert.equal(response.status,200);
  const encoded=await response.text();
  assert(!encoded.includes("PRIVATE KEY"));
  cli(["backup-keygen","--output",key]);
  const backed=cli(["import-hosted-backup","--expected-node-id",before.nodeId,"--expected-release",release,"--key-file",key,"--output",archive],encoded);
  assert.equal(backed.sourceNodeId,before.nodeId);
  assert.equal(backed.privateKeysIncluded,false);
  assert.equal(backed.origin,"CLOUDFLARE_SIGNED_LOGICAL_EXPORT");
  const inspected=cli(["backup-inspect","--key-file",key,"--input",archive]);
  assert.equal(inspected.history.valid,true);
  const restored=cli(["restore","--key-file",key,"--input",archive,"--target",join(scratch,"restored")]);
  assert.equal(restored.status,"RECOVERY_REVIEW_REQUIRED");
  const descriptor=await (await recovery.fetch("https://recovery.internal/archive/primary/begin",{method:"POST"})).json();
  assert.equal(descriptor.payload.source.nodeId,before.nodeId);
  const checkpoint=descriptor.payload.checkpointId,frames=[descriptor];
  for(let index=0;index<100;index++) {
    const path=`https://recovery.internal/archive/primary/${checkpoint}/block/${index}`;
    const response=await recovery.fetch(path,{method:"POST"});assert.equal(response.status,200);
    const block=await response.json();if(block===null)break;
    // A repeated native Fetcher call regenerates byte-identical content from durable state.
    assert.deepEqual(await (await recovery.fetch(path,{method:"POST"})).json(),block);frames.push(block);
  }
  const sealed=await recovery.fetch(`https://recovery.internal/archive/primary/${checkpoint}/seal`,{method:"POST"});
  assert.equal(sealed.status,200);frames.push(await sealed.json());
  const streamArgs=["--expected-node-id",before.nodeId,"--expected-release",release,"--key-file",key];
  const streamed=cli(["import-stream-backup",...streamArgs,"--output",streamArchive],frames.map(frame=>JSON.stringify(frame)).join("\n")+"\n");
  assert.equal(streamed.sourceVerified,true);assert.equal(streamed.contentInspection,"REQUIRED");
  const inspectedStream=cli(["backup-stream-inspect",...streamArgs,"--input",streamArchive]);
  assert.equal(inspectedStream.history.valid,true);
  const restoredStream=cli(["restore-stream",...streamArgs,"--input",streamArchive,"--target",join(scratch,"stream-restored")]);
  assert.equal(restoredStream.status,"RECOVERY_REVIEW_REQUIRED");
  assert.equal((await recovery.fetch(`https://recovery.internal/archive/primary/${checkpoint}/complete`,{method:"POST"})).status,200);
  const after=await (await worker.fetch("https://primary.blackwellindex.com/v1/status")).json();
  assert.equal(after.nodeId,before.nodeId);
  assert.equal((await worker.fetch("https://primary.blackwellindex.com/v1/ready")).status,503);
  const privatePaths=["/exportRecovery","/v1/exportRecovery","/internal/exportRecovery","/v1/recovery","/node/primary/exportRecovery","/internal/export-recovery","/node/primary/internal/export-recovery",
    "/internal/archive/begin","/node/primary/internal/archive/begin","/archive/primary/begin",`/internal/archive/${checkpoint}/block/0`,`/internal/archive/${checkpoint}/seal`,`/internal/archive/${checkpoint}/complete`];
  for(const path of privatePaths)
    for(const method of ["GET","POST"])assert([404,405].includes((await worker.fetch(`https://primary.blackwellindex.com${path}`,{method})).status));
  for(const [path,method] of [["/export/unknown","POST"],["/export/primary","GET"],["/export/primary?bypass=1","POST"],
    ["/archive/unknown/begin","POST"],["/archive/primary/begin","GET"],["/archive/primary/begin?bypass=1","POST"],["/archive/primary/not-a-checkpoint/seal","POST"]])
    assert.equal((await recovery.fetch(`https://recovery.internal${path}`,{method})).status,404);
  console.log(JSON.stringify({status:"PASS",runtime:"workerd",privateServiceBinding:true,verifiedEncryptedRestore:true,verifiedStreamingRestore:true,checkpointRetry:true,identityUnchanged:true,publicExportRequestsDenied:privatePaths.length*2,providerRequests:0}));
} finally {clearTimeout(timeout);await mf.dispose();rmSync(scratch,{recursive:true,force:true});}
