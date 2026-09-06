/** Bounded synthetic workerd fixture. No deployed route, test flag, provider request or remote binding. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const started=Date.now(),scratch=mkdtempSync(join(tmpdir(),"sbx-workerd-capacity-test-")),release="34".repeat(20);
const production=readFileSync(resolve(process.argv[2]??"data/hosted-recovery-build/index.js"),"utf8");
// This wrapper exists only in Miniflare's in-memory module graph. It exercises the
// built production journal and checkpoint methods, without adding production hooks.
const fixtureModule=`
import {createHash as testHash,generateKeyPairSync as testKeyPair,sign as testSign} from 'node:crypto';
function testCanonical(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(testCanonical).join(',')+']';return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+testCanonical(value[key])).join(',')+'}';}
export class FixtureNode extends SbxNode {
  async alarm(){} // No synthetic fixture is allowed to trigger provider collection.
  async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/fixture/seed'&&request.method==='POST'){
      if(this.journal.counts().evidence)throw new Error('FIXTURE_ALREADY_SEEDED');
      const now=Date.now(),body=new Uint8Array(700031);for(let i=0;i<body.length;i++)body[i]=i%251;
      const evidenceHash=testHash('sha256').update(body).digest('hex');
      await this.journal.archive({hash:evidenceHash,source:'isolated-workerd-test',url:'https://oracle.example/isolated-test',receivedAt:now,contentType:'application/octet-stream',body});
      const base={schemaVersion:1,provider:'oracle',source:'oracle-public',sku:'isolated-sku',model:'B200',region:'isolated-test',procurement:'ON_DEMAND',priceBasis:'LIST',tenancy:'EXCLUSIVE',currency:'USD',unit:'USD_PER_GPU_HOUR',price:'1',instancePrice:'8',gpuCount:8,includes:['host'],availableGpuCount:null,observedAt:now,priceEffectiveAt:null,expiresAt:null,sourceUrl:'https://oracle.example/isolated-test',evidenceHash};
      this.journal.capture(Array.from({length:1100},(_,i)=>({...base,sku:'isolated-capture-'+i})),[],now);
      this.journal.nextSequence(this.identity.nodeId);
      this.journal.db.query("INSERT INTO collector_schedules VALUES('isolated-test',0,0,'READY',?,0,NULL,0)").run(now);
      const observations=Array.from({length:30},(_,i)=>({...base,sku:'isolated-candidate-'+i}));
      const template={payload:{schemaVersion:1,network:this.config.network,nodeId:'0'.repeat(64),publicKey:'A'.repeat(60),sequence:1,createdAt:now,observations},signature:'A'.repeat(88)};
      for(const observation of observations){const remaining=32768-Buffer.byteLength(testCanonical(template));if(remaining<=0)break;observation.sourceUrl+='x'.repeat(Math.min(remaining,2048-observation.sourceUrl.length));}
      if(Buffer.byteLength(testCanonical(template))!==32768)throw new Error('FIXTURE_CANDIDATE_TARGET_FAILED');
      for(let i=0;i<512;i++){
        const pair=testKeyPair('ed25519'),publicKey=pair.publicKey.export({type:'spki',format:'der'}).toString('base64');
        const nodeId=testHash('sha256').update(publicKey).digest('hex'),payload={...template.payload,nodeId,publicKey};
        const batch={payload,signature:testSign(null,Buffer.from(testCanonical(payload)),pair.privateKey).toString('base64')};
        this.journal.accept(batch,now,false);
      }
      this.journal.snapshot(this.node.snapshot());
      return Response.json({counts:this.journal.counts(),candidateUsage:this.journal.candidateUsage(),evidenceBytes:body.length,counter:1});
    }
    if(path==='/fixture/mutate'&&request.method==='POST'){
      const counter=this.journal.nextSequence(this.identity.nodeId);
      this.journal.db.query('DELETE FROM candidates WHERE node_id=(SELECT node_id FROM candidates ORDER BY node_id LIMIT 1)').run();
      this.journal.db.query("UPDATE collector_schedules SET next_attempt_at=?,failures=1,reason='HTTP_429_BACKOFF' WHERE collector_id='isolated-test'").run(Date.now()+60000);
      this.journal.capture([],[],Date.now());
      return Response.json({counter,counts:this.journal.counts()});
    }
    return super.fetch(request);
  }
}`;
let externalCalls=0;
const mf=new Miniflare(convertV4MiniflareOptions({unsafeInspectDurableObjects:true,workers:[{
  name:"isolated-capacity",modules:true,script:production+"\n"+fixtureModule,
  compatibilityDate:"2026-09-06",compatibilityFlags:["nodejs_compat"],
  bindings:{SBX_NETWORK:"sbx-runtime-test",SBX_OPERATOR_GROUP:"isolated-test",SBX_COLLECTORS:"",SBX_COLLECTION_INTERVAL_MS:"86400000",SBX_RELEASE:release},
  durableObjects:{SBX_NODES:{className:"FixtureNode",useSQLite:true}},serviceBindings:{ASSETS:()=>new Response("Not found",{status:404})},
  outboundService:()=>{externalCalls++;throw new Error("TEST_EXTERNAL_NETWORK_FORBIDDEN");},
},{name:"isolated-capacity-client",modules:true,script:"export default {fetch(){return new Response('Not found',{status:404})}}",compatibilityDate:"2026-09-06",
  serviceBindings:{RECOVERY:{name:"isolated-capacity",entrypoint:"RecoveryService"}},
}]}));
const timeout=setTimeout(()=>{console.error("HOSTED_CAPACITY_RUNTIME_TIMEOUT");process.exitCode=1;void mf.dispose();},55000);
function cli(args,input){
  const remaining=55000-(Date.now()-started);assert(remaining>0,"Runtime budget exhausted");
  const child=spawnSync("bun",["src/cli.ts",...args],{input,encoding:"utf8",timeout:Math.min(15000,remaining),env:{PATH:process.env.PATH,TMPDIR:scratch},maxBuffer:4*1024*1024});
  assert.equal(child.status,0,child.stderr||"CLI failed");return JSON.parse(child.stdout);
}
try{
  const worker=await mf.getWorker("isolated-capacity"),bindings=await mf.getBindings("isolated-capacity"),recovery=(await mf.getBindings("isolated-capacity-client")).RECOVERY;
  const object=bindings.SBX_NODES.getByName("primary");
  const seededResponse=await object.fetch("https://isolated.internal/fixture/seed",{method:"POST"});assert.equal(seededResponse.status,200);
  const seeded=await seededResponse.json();assert.equal(seeded.candidateUsage.identities,512);assert.equal(seeded.candidateUsage.bytes,16*1024*1024);assert(seeded.counts.captureBatches>1);
  const before=await (await worker.fetch("https://primary.blackwellindex.com/v1/status")).json();
  const beginResponse=await recovery.fetch("https://recovery.internal/archive/primary/begin",{method:"POST"});assert.equal(beginResponse.status,200);
  const descriptor=await beginResponse.json(),id=descriptor.payload.checkpointId;assert.equal(descriptor.payload.counts[2],512);assert.equal(descriptor.payload.counts[9],2);assert.equal(descriptor.payload.counts[11],1);
  const firstPath=`https://recovery.internal/archive/primary/${id}/block/0`;
  const first=await (await recovery.fetch(firstPath,{method:"POST"})).json();assert(first.hash);
  const changed=await (await object.fetch("https://isolated.internal/fixture/mutate",{method:"POST"})).json();assert.equal(changed.counter,2);assert.equal(changed.counts.candidates,511);
  await mf.unsafeEvictDurableObject("isolated-capacity","FixtureNode",{name:"primary"});
  assert.deepEqual(await (await recovery.fetch(firstPath,{method:"POST"})).json(),first);
  const frames=[descriptor,first];let fragmented=false,blockCount=1;
  for(let index=1;index<256;index++){
    const response=await recovery.fetch(`https://recovery.internal/archive/primary/${id}/block/${index}`,{method:"POST"});assert.equal(response.status,200);
    const block=await response.json();if(block===null)break;
    assert(Buffer.byteLength(JSON.stringify(block))<=512*1024);assert(block.fragments.reduce((sum,part)=>sum+Buffer.from(part.data,"base64").length,0)<=256*1024);
    fragmented ||= block.fragments.some(fragment=>fragment.offset>0);frames.push(block);blockCount++;
  }
  assert(fragmented);assert(blockCount>64);
  const sealResponse=await recovery.fetch(`https://recovery.internal/archive/primary/${id}/seal`,{method:"POST"});assert.equal(sealResponse.status,200);const seal=await sealResponse.json();frames.push(seal);assert.equal(seal.payload.blockCount,blockCount);
  const key=join(scratch,"recovery.key"),archive=join(scratch,"fixture.sbx-backup");cli(["backup-keygen","--output",key]);
  const args=["--expected-node-id",before.nodeId,"--expected-release",release,"--key-file",key];
  assert.equal(cli(["import-stream-backup",...args,"--output",archive],frames.map(frame=>JSON.stringify(frame)).join("\n")+"\n").sourceVerified,true);
  const inspected=cli(["backup-stream-inspect",...args,"--input",archive]);assert.equal(inspected.counts.candidates,512);assert.equal(inspected.counts.captures,1);assert.equal(inspected.observations,1100);assert.equal(inspected.evidenceBytes,700031);assert.equal(inspected.reproducedSnapshots,1);
  const restored=cli(["restore-stream",...args,"--input",archive,"--target",join(scratch,"restored")]);assert.equal(restored.status,"RECOVERY_REVIEW_REQUIRED");
  const storage=await mf.unsafeGetDurableObjectStorage("isolated-capacity","FixtureNode",{name:"primary"});
  assert.equal((await storage.exec("SELECT value FROM counters WHERE id=?",before.nodeId))[0].value,2);
  assert.equal((await recovery.fetch(`https://recovery.internal/archive/primary/${id}/complete`,{method:"POST"})).status,200);
  const after=await (await worker.fetch("https://primary.blackwellindex.com/v1/status")).json();assert.equal(after.nodeId,before.nodeId);assert.equal(after.counts.candidates,511);assert.equal(after.counts.captures,2);
  assert.equal((await worker.fetch("https://primary.blackwellindex.com/fixture/seed",{method:"POST"})).status,405);assert.equal(externalCalls,0);
  const milliseconds=Date.now()-started;assert(milliseconds<60000);
  console.log(JSON.stringify({status:"PASS",runtime:"workerd",syntheticFixture:true,candidates:512,frozenCandidateBytes:16*1024*1024,evidenceBytes:700031,evidenceChunks:2,captureBatches:seeded.counts.captureBatches,observations:1100,blockCount,fragmentedRecords:true,retryAfterEviction:true,mutableStateFrozen:true,verifiedEncryptedRestore:true,identityUnchanged:true,sourceCounter:2,sourceRecordsDeletedByArchive:0,externalCalls,milliseconds}));
}finally{clearTimeout(timeout);await mf.dispose();rmSync(scratch,{recursive:true,force:true});}
