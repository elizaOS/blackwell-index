import type { NodeIdentity, Registry, Methodology, SignedBatch, Snapshot } from "./types";
import { canonical, hash, verifyBatch } from "./crypto";
import { allowedObservation, calculate } from "./engine";
import { signedBatchSchema } from "./validation";
import type { Journal as Store } from "./journal";
import { JOURNAL_LIMITS, type EquivocationPage, type EquivocationProof, validateEquivocationProof } from "./journal";
import { resolve, sep, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { latestDemoResponse } from "./demo";

const MAX_BODY=2_000_000;
const MAX_PEER_BODY=8_000_000;
const proofSchema=z.strictObject({first:signedBatchSchema,second:signedBatchSchema});
const proofPageSchema=z.strictObject({proofs:z.array(proofSchema.extend({sequence:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),detectedAt:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)})).max(JOURNAL_LIMITS.proofPageRows),hasMore:z.boolean(),nextAfter:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable()});
export async function boundedJson(response: Response|Request, max=MAX_BODY): Promise<unknown> {
  if (Number(response.headers.get("content-length") ?? 0)>max) throw new Error("BODY_TOO_LARGE");
  if (!response.body) throw new Error("EMPTY_BODY");
  const reader=response.body.getReader(), chunks:Uint8Array[]=[];
  let size=0;
  try { while(true) { const part=await reader.read(); if(part.done) break; size+=part.value.length; if(size>max) throw new Error("BODY_TOO_LARGE"); chunks.push(part.value); } }
  catch(e) { await reader.cancel(); throw e; }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export function peerUrl(value:string, allowLoopback=false): URL {
  const url=new URL(value), loopback=["127.0.0.1","localhost","[::1]"].includes(url.hostname);
  if(url.username||url.password||url.search||url.hash) throw new Error("Invalid peer URL");
  if(url.protocol!=="https:" && !(allowLoopback&&loopback&&url.protocol==="http:")) throw new Error("Peer requires HTTPS (loopback HTTP requires explicit option)");
  if(!loopback && (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)||url.hostname.startsWith("["))) throw new Error("Use a public DNS name for peers");
  return url;
}
export interface NodeOptions { identity:NodeIdentity;registry:Registry;methodology:Methodology;store:Store;publicDir?:string;clock?:()=>number }
export class OracleNode {
  readonly options:NodeOptions;
  readonly clock:()=>number;
  readonly #rates=new Map<string,{time:number;count:number}>();
  constructor(options:NodeOptions) {this.options=options;this.clock=options.clock??Date.now;}
  snapshot():Snapshot { return calculate(this.options.store.latestReports(),this.options.registry,this.options.methodology,this.clock()); }
  receive(raw:unknown):{status:string;hash:string;trusted:boolean} {
    const batch=signedBatchSchema.parse(raw) as SignedBatch;
    if(!verifyBatch(batch)) throw new Error("INVALID_SIGNATURE");
    const {registry,methodology,store}=this.options,p=batch.payload,now=this.clock();
    if(p.network!==registry.network) throw new Error("WRONG_NETWORK");
    if(p.createdAt>now+methodology.futureToleranceMs||now-p.createdAt>methodology.maxAgeMs) throw new Error("BATCH_TIME_INVALID");
    if(p.observations.some(o=>!allowedObservation(o,registry,now,"share"))) throw new Error("SOURCE_OR_PUBLICATION_RIGHTS_NOT_APPROVED");
    const trusted=registry.operators.some(x=>x.enabled&&x.nodeId===p.nodeId&&x.publicKey===p.publicKey);
    const status=store.accept(batch,now,trusted);
    return {status:status==="ACCEPTED"&&!trusted?"QUARANTINED":status,hash:hash(batch),trusted};
  }
  publicReports():SignedBatch[] {
    const {registry,store}=this.options,now=this.clock();
    return store.latestReports().filter(b=>registry.operators.some(x=>x.enabled&&x.nodeId===b.payload.nodeId&&x.publicKey===b.payload.publicKey)&&b.payload.observations.every(o=>allowedObservation(o,registry,now,"share")));
  }
  receiveEquivocation(raw:unknown):{status:string;nodeId:string} {
    const proof=proofSchema.parse(raw) as EquivocationProof,p=proof.first.payload,{registry,store}=this.options;
    // Unknown identities cannot consume the durable proof archive or accuse approved operators.
    if(p.network!==registry.network || !registry.operators.some(o=>o.nodeId===p.nodeId&&o.publicKey===p.publicKey)) throw new Error("UNTRUSTED_EQUIVOCATION_IDENTITY");
    validateEquivocationProof(proof);
    return {status:store.recordEquivocation(proof,this.clock()),nodeId:p.nodeId};
  }
  publicEquivocations(after=0,limit:number=JOURNAL_LIMITS.proofPageRows):EquivocationPage {
    const {registry,store}=this.options,now=this.clock(),page=store.equivocationPage(after,limit);
    return {...page,proofs:page.proofs.filter(proof=>registry.operators.some(o=>o.nodeId===proof.first.payload.nodeId&&o.publicKey===proof.first.payload.publicKey)&&[proof.first,proof.second].every(batch=>batch.payload.observations.every(o=>allowedObservation(o,registry,now,"share"))))};
  }
  async #syncEquivocations(base:URL):Promise<void> {
    let after=0,bytes=0;
    const started=Date.now();
    // Fetch and validate accusations before accepting any ordinary report from this peer.
    for(let pageNumber=0;pageNumber<64;pageNumber++) {
      if(Date.now()-started>30_000)throw new Error("PROOF_SYNC_TIME_BUDGET");
      const url=new URL("/v1/equivocations",base);url.searchParams.set("after",String(after));
      const response=await fetch(url,{redirect:"manual",signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error(`Peer proof read HTTP ${response.status}`);
      const document=proofPageSchema.parse(await boundedJson(response,MAX_PEER_BODY));
      bytes+=Buffer.byteLength(canonical(document));
      if(bytes>32_000_000)throw new Error("PROOF_SYNC_BYTE_BUDGET");
      let last=after;
      for(const proof of document.proofs) {
        if(proof.sequence<=last)throw new Error("INVALID_PROOF_CURSOR");
        last=proof.sequence;
        this.receiveEquivocation({first:proof.first,second:proof.second});
      }
      if(document.nextAfter!==null && document.nextAfter<last)throw new Error("INVALID_PROOF_CURSOR");
      if(!document.hasMore)break;
      if(document.nextAfter===null||document.nextAfter<=after||pageNumber===63)throw new Error("INVALID_OR_EXCESSIVE_PROOF_PAGINATION");
      after=document.nextAfter;
    }
    // Send our retained signed evidence too: one initiating node can quarantine an equivocator on both peers.
    after=0;
    for(let pageNumber=0;pageNumber<64;pageNumber++) {
      if(Date.now()-started>30_000)throw new Error("PROOF_SYNC_TIME_BUDGET");
      const page=this.publicEquivocations(after),proofs=page.proofs.map(({first,second})=>({first,second}));
      if(proofs.length) {
        const body=canonical({proofs});bytes+=Buffer.byteLength(body);
        if(bytes>32_000_000)throw new Error("PROOF_SYNC_BYTE_BUDGET");
        const response=await fetch(new URL("/v1/equivocations",base),{method:"POST",headers:{"content-type":"application/json"},body,redirect:"manual",signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw new Error(`Peer proof submission HTTP ${response.status}`);
      }
      if(!page.hasMore)break;
      if(page.nextAfter===null||page.nextAfter<=after||pageNumber===63)throw new Error("INVALID_LOCAL_PROOF_PAGINATION");
      after=page.nextAfter;
    }
  }
  async sync(peers:string[],allowLoopback=false):Promise<Array<{peer:string;ok:boolean;error?:string}>> {
    return Promise.all(peers.map(async peer=> {
      try {
        const base=peerUrl(peer,allowLoopback);
        await this.#syncEquivocations(base);
        const now=this.clock();
        const own=this.options.store.latestReport(this.options.identity.nodeId);
        if(own && own.payload.observations.every(o=>allowedObservation(o,this.options.registry,now,"share")) && now-own.payload.createdAt<=this.options.methodology.maxAgeMs && own.payload.createdAt<=now+this.options.methodology.futureToleranceMs) {
          const push=await fetch(new URL("/v1/reports",base),{method:"POST",headers:{"content-type":"application/json"},body:canonical(own),redirect:"manual",signal:AbortSignal.timeout(10000)});
          if(!push.ok) throw new Error(`Peer submission HTTP ${push.status}`);
        }
        const response=await fetch(new URL("/v1/reports",base),{redirect:"manual",signal:AbortSignal.timeout(10000)});
        if(!response.ok) throw new Error(`Peer read HTTP ${response.status}`);
        const document=z.strictObject({reports:z.array(signedBatchSchema).max(1000)}).parse(await boundedJson(response,MAX_PEER_BODY));
        for(const batch of document.reports) this.receive(batch);
        return {peer,ok:true};
      } catch(e) {return {peer,ok:false,error:e instanceof Error?e.message:"Peer error"};}
    }));
  }
  async handle(request:Request,ip="local"):Promise<Response> {
    const headers={"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"};
    const json=(value:unknown,status=200)=>new Response(canonical(value),{status,headers});
    const url=new URL(request.url);
    if(request.method==="OPTIONS") return new Response(null,{status:405});
    if(request.method==="POST") {
      const now=this.clock();
      if(this.#rates.size>10000) for(const [key,rate] of this.#rates) if(now-rate.time>60000)this.#rates.delete(key);
      if(this.#rates.size>10000&&!this.#rates.has(ip)) return json({error:"RATE_CAPACITY"},429);
      const entry=this.#rates.get(ip);
      const rate=entry&&now-entry.time<60000?entry:{time:now,count:0}; rate.count++;this.#rates.set(ip,rate);
      if(rate.count>60)return json({error:"RATE_LIMIT"},429);
      if(url.pathname!=="/v1/reports"&&url.pathname!=="/v1/join"&&url.pathname!=="/v1/equivocations")return json({error:"NOT_FOUND"},404);
      if(!request.headers.get("content-type")?.startsWith("application/json"))return json({error:"JSON_REQUIRED"},415);
      try {
        if(url.pathname==="/v1/equivocations") {
          const document=z.strictObject({proofs:z.array(proofSchema).min(1).max(JOURNAL_LIMITS.proofPageRows)}).parse(await boundedJson(request,MAX_PEER_BODY));
          return json({receipts:document.proofs.map(proof=>this.receiveEquivocation(proof))},202);
        }
        return json(this.receive(await boundedJson(request)),202);
      }
      catch(e){return json({error:e instanceof z.ZodError?"INVALID_SCHEMA":e instanceof Error?e.message:"INVALID_REPORT"},400);}
    }
    if(request.method!=="GET")return json({error:"METHOD_NOT_ALLOWED"},405);
    if(url.pathname==="/v1/demo") {
      // Hosted demo approvals do not grant rights to independent local operators.
      const result=latestDemoResponse(this.options.store.db,this.options.registry,this.options.methodology,this.options.identity,this.clock());
      return json(result.body,result.status);
    }
    if(url.pathname==="/healthz")return json({status:"RUNNING"});
    if(url.pathname==="/v1/status")return json({nodeId:this.options.identity.nodeId,network:this.options.registry.network,registryHash:hash(this.options.registry),methodologyHash:hash(this.options.methodology),methodologyStatus:this.options.methodology.status,counts:this.options.store.counts(),pyth:"NOT_PUBLISHED"});
    if(url.pathname==="/v1/registry")return json(this.options.registry);
    if(url.pathname==="/v1/methodology")return json(this.options.methodology);
    if(url.pathname==="/v1/reports")return json({reports:this.publicReports()});
    if(url.pathname==="/v1/equivocations") {
      const after=Number(url.searchParams.get("after")??0),limit=Number(url.searchParams.get("limit")??JOURNAL_LIMITS.proofPageRows);
      if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>JOURNAL_LIMITS.proofPageRows)return json({error:"INVALID_PROOF_PAGINATION"},400);
      return json(this.publicEquivocations(after,limit));
    }
    if(url.pathname==="/v1/feeds"||url.pathname==="/v1/ready"||url.pathname.startsWith("/v1/feeds/")) {
      const snapshot=this.snapshot();
      if(url.pathname==="/v1/ready")return json({publishable:snapshot.publishable},snapshot.publishable?200:503);
      if(url.pathname.startsWith("/v1/feeds/")) {
        const id=decodeURIComponent(url.pathname.slice("/v1/feeds/".length)),feed=snapshot.feeds.find(f=>f.id===id);
        return feed?json({feed,methodologyVersion:snapshot.methodologyVersion,publishable:snapshot.publishable},feed.status==="READY"?200:503):json({error:"UNKNOWN_FEED"},404);
      }
      return json(snapshot);
    }
    if(url.pathname==="/v1/history") {
      const after=Number(url.searchParams.get("after")??0),limit=Number(url.searchParams.get("limit")??100);
      if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)return json({error:"INVALID_PAGINATION"},400);
      return json(this.options.store.history(after,limit));
    }
    if(this.options.publicDir) {
      const route=url.pathname==="/"?"index.html":url.pathname==="/altx"||url.pathname==="/altx/"?"altx/index.html":url.pathname.slice(1);
      if(isAbsolute(route)||! /^[a-zA-Z0-9][a-zA-Z0-9/_-]*\.(html|css|js|svg|png|ico)$/.test(route))return json({error:"NOT_FOUND"},404);
      const root=await realpath(this.options.publicDir);
      let path:string;
      try{path=await realpath(resolve(root,route));}catch{return json({error:"NOT_FOUND"},404);}
      if(!path.startsWith(root+sep))return json({error:"NOT_FOUND"},404);
      const file=Bun.file(path);
      if(await file.exists())return new Response(file,{headers:{"x-content-type-options":"nosniff","content-security-policy":"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'","referrer-policy":"no-referrer"}});
    }
    return json({error:"NOT_FOUND"},404);
  }
}
