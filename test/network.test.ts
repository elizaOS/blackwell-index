import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { OracleNode, peerUrl } from "../src/network";
import { signBatch, generateIdentity, hash } from "../src/crypto";
import { environment,NOW } from "./helpers";

test("three HTTP nodes exchange signed reports and independently converge",async()=>{
  const e=environment(),stores=e.identities.map(()=>new Store(":memory:"));
  const nodes=e.identities.map((identity,i)=>new OracleNode({identity,registry:e.registry,methodology:e.methodology,store:stores[i]!,clock:()=>NOW}));
  const servers=nodes.map(node=>Bun.serve({hostname:"127.0.0.1",port:0,fetch:r=>node.handle(r)}));
  try {
    for(let i=0;i<3;i++)nodes[i]!.receive(e.batches[i]);
    expect(nodes[0]!.snapshot().publishable).toBe(false);
    for(let i=0;i<3;i++)expect((await nodes[i]!.sync(servers.filter((_,j)=>j!==i).map(s=>s.url.toString()),true)).every(r=>r.ok)).toBe(true);
    const hashes=nodes.map(n=>hash(n.snapshot()));expect(new Set(hashes).size).toBe(1);
    expect(nodes[0]!.snapshot().publishable).toBe(true);
    const api=await fetch(new URL("/v1/feeds/SBX",servers[0]!.url));expect(api.status).toBe(200);
    expect(((await api.json()) as {feed:{price:string}}).feed.price).toBe("4.750000");
    const health=await fetch(new URL("/v1/ready",servers[0]!.url));expect(health.status).toBe(200);
  } finally{for(const s of servers)s.stop(true);for(const db of stores)db.close();}
});
test("unknown operators can join but do not earn voting power",async()=>{
  const e=environment(),store=new Store(":memory:"),identity=generateIdentity();
  const node=new OracleNode({identity:e.identities[0]!,registry:e.registry,methodology:e.methodology,store,clock:()=>NOW});
  try{
    const batch=signBatch({...e.batches[0]!.payload,nodeId:identity.nodeId,publicKey:identity.publicKey},identity);
    const response=await node.handle(new Request("http://node/v1/join",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(batch)}));
    expect(response.status).toBe(202);expect(((await response.json()) as {status:string}).status).toBe("QUARANTINED");
    expect(node.publicReports()).toHaveLength(0);expect(node.snapshot().publishable).toBe(false);
  }finally{store.close();}
});
test("replay protection and nonce continue after a database restart",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sbx-restart-")),path=join(dir,"node.sqlite"),e=environment();
  try{
    let store=new Store(path);expect(store.nextSequence(e.identities[0]!.nodeId)).toBe(1);
    const newer=signBatch({...e.batches[0]!.payload,sequence:2},e.identities[0]!);store.accept(newer,NOW,true);store.close();
    store=new Store(path);expect(store.nextSequence(e.identities[0]!.nodeId)).toBe(2);expect(()=>store.accept(e.batches[0]!,NOW,true)).toThrow("REPLAY");
    expect(store.accept(newer,NOW,true)).toBe("DUPLICATE");store.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("signed conflicting payload permanently excludes operator across restart",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sbx-conflict-")),path=join(dir,"node.sqlite"),e=environment();
  try{
    let store=new Store(path);store.accept(e.batches[0]!,NOW,true);
    const conflict=signBatch({...e.batches[0]!.payload,observations:[]},e.identities[0]!);
    expect(()=>store.accept(conflict,NOW,true)).toThrow("EQUIVOCATION");expect(store.latestReports()).toHaveLength(0);store.close();
    store=new Store(path);expect(store.latestReports()).toHaveLength(0);expect(()=>store.accept(signBatch({...e.batches[0]!.payload,sequence:2},e.identities[0]!),NOW,true)).toThrow("QUARANTINED");store.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("unavailable data is distinct from process liveness and errors are bounded",async()=>{
  const e=environment(),store=new Store(":memory:"),node=new OracleNode({identity:e.identities[0]!,registry:e.registry,methodology:e.methodology,store,clock:()=>NOW});
  try {
    expect((await node.handle(new Request("http://node/healthz"))).status).toBe(200);
    expect((await node.handle(new Request("http://node/v1/ready"))).status).toBe(503);
    expect((await node.handle(new Request("http://node/v1/history?limit=1001"))).status).toBe(400);
    expect((await node.handle(new Request("http://node/v1/reports",{method:"POST",headers:{"content-type":"application/json","content-length":"3000000"},body:"{}"}))).status).toBe(400);
    const copy=structuredClone(e.batches[0]!);copy.signature="A".repeat(86)+"==";expect(()=>node.receive(copy)).toThrow("INVALID_SIGNATURE");
  }finally{store.close();}
});
test("history chain detects corruption",()=>{
  const e=environment(),store=new Store(":memory:"),node=new OracleNode({identity:e.identities[0]!,registry:e.registry,methodology:e.methodology,store,clock:()=>NOW});
  try{store.snapshot(node.snapshot());store.snapshot({...node.snapshot(),calculatedAt:NOW+1});expect(store.verifyHistory()).toEqual({valid:true,count:2});
    store.db.query("UPDATE snapshots SET payload=? WHERE id=1").run("{}");expect(store.verifyHistory().valid).toBe(false);
  }finally{store.close();}
});
test("peer destinations reject insecure remote URLs and userinfo",()=>{
  expect(()=>peerUrl("http://example.com")).toThrow();expect(()=>peerUrl("https://user:secret@example.com")).toThrow();
  expect(()=>peerUrl("http://127.0.0.1:3410")).toThrow();expect(peerUrl("http://127.0.0.1:3410",true).hostname).toBe("127.0.0.1");
});
