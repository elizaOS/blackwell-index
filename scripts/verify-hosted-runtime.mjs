/** Isolated workerd smoke test. Empty journal only; no provider calls or remote bindings. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const scratch=mkdtempSync(join(tmpdir(),"sbx-hosted-runtime-test-"));
const release="12".repeat(20), key=join(scratch,"recovery.key"), archive=join(scratch,"node.sbx-backup");
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
  const after=await (await worker.fetch("https://primary.blackwellindex.com/v1/status")).json();
  assert.equal(after.nodeId,before.nodeId);
  assert.equal((await worker.fetch("https://primary.blackwellindex.com/v1/ready")).status,503);
  for(const path of ["/exportRecovery","/v1/exportRecovery","/internal/exportRecovery","/v1/recovery","/node/primary/exportRecovery","/internal/export-recovery","/node/primary/internal/export-recovery"])
    for(const method of ["GET","POST"])assert([404,405].includes((await worker.fetch(`https://primary.blackwellindex.com${path}`,{method})).status));
  for(const [path,method] of [["/export/unknown","POST"],["/export/primary","GET"],["/export/primary?bypass=1","POST"]])
    assert.equal((await recovery.fetch(`https://recovery.internal${path}`,{method})).status,404);
  console.log(JSON.stringify({status:"PASS",runtime:"workerd",privateServiceBinding:true,verifiedEncryptedRestore:true,identityUnchanged:true,publicExportRequestsDenied:14,providerRequests:0}));
} finally {clearTimeout(timeout);await mf.dispose();rmSync(scratch,{recursive:true,force:true});}
