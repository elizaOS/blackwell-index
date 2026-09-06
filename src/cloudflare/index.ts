import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { generateIdentity } from "../crypto";
import { OracleNode } from "../network";
import type { NodeIdentity } from "../types";
import { collectCycle } from "./collect";
import { runtimeConfig, type WorkerEnvironment } from "./config";
import { CloudflareJournal, DurableSqlDriver } from "./sql";
import { createHostedExport } from "../hosted-export";

const NODE_NAMES = ["primary", "secondary"] as const;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
type Cycle = Awaited<ReturnType<typeof collectCycle>>;
type CollectionState = {status:"IDLE"|"RUNNING"|"COMPLETE"|"FAILED";startedAt?:number;completedAt?:number;lastCycle?:Cycle};

function secured(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", CSP);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("strict-transport-security", "max-age=31536000");
  return new Response(response.body, {status:response.status, statusText:response.statusText, headers});
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});

export class SbxNode extends DurableObject<WorkerEnvironment> {
  private identity!: NodeIdentity;
  private journal!: CloudflareJournal;
  private node!: OracleNode;
  private config!: ReturnType<typeof runtimeConfig>;
  private release: string | null = null;

  constructor(ctx: DurableObjectState, env: WorkerEnvironment) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.config = runtimeConfig(env);
      this.release = env.SBX_RELEASE && /^[a-f0-9]{40}$/.test(env.SBX_RELEASE) ? env.SBX_RELEASE : null;
      const existing = await ctx.storage.get<NodeIdentity>("identity:v1");
      this.identity = existing ?? generateIdentity();
      if (!existing) await ctx.storage.put("identity:v1", this.identity);
      const admission = this.config.registry.operators.find(o => o.nodeId === this.identity.nodeId);
      if (admission && admission.operatorGroup !== this.config.operatorGroup) throw new Error("HOSTED_NODES_MUST_SHARE_OPERATOR_GROUP");
      this.journal = new CloudflareJournal(new DurableSqlDriver(ctx.storage));
      this.journal.saveConfiguration(this.config.registry);
      this.journal.saveConfiguration(this.config.methodology);
      this.node = new OracleNode({identity:this.identity,registry:this.config.registry,methodology:this.config.methodology,store:this.journal});
      if (await ctx.storage.getAlarm() === null) await ctx.storage.setAlarm(Date.now() + 1000);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if(path==="/internal/export-recovery"&&request.method==="POST") {
      const name=request.headers.get("x-sbx-recovery-node");
      if(name!=="primary"&&name!=="secondary")return json({error:"UNKNOWN_NODE"},404);
      return this.#exportRecovery(name);
    }
    if (path === "/internal/wake" && request.method === "POST") {
      if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
      return json({scheduled:true});
    }
    if (path === "/v1/status" && request.method === "GET") {
      const base = await this.node.handle(request, request.headers.get("x-sbx-client-ip") ?? "unknown");
      const value = await base.json() as Record<string, unknown>;
      return json({...value,publicKey:this.identity.publicKey,hosting:{runtime:"cloudflare-durable-object",operatorGroup:this.config.operatorGroup,
        operatorGroupCount:1,release:this.release,storageBytes:this.ctx.storage.sql.databaseSize},collection:await this.ctx.storage.get<CollectionState>("collection:v1") ?? {status:"IDLE"},
        nextCollectionAt:await this.ctx.storage.getAlarm()});
    }
    return this.node.handle(request, request.headers.get("x-sbx-client-ip") ?? "unknown");
  }

  async alarm(): Promise<void> {
    const previous = await this.ctx.storage.get<CollectionState>("collection:v1");
    if (previous?.completedAt && Date.now() - previous.completedAt < this.config.intervalMs) {
      await this.ctx.storage.setAlarm(previous.completedAt + this.config.intervalMs);
      return;
    }
    const startedAt = Date.now();
    try {
      await this.ctx.storage.put("collection:v1", {status:"RUNNING",startedAt,...(previous?.lastCycle ? {lastCycle:previous.lastCycle} : {})});
      const lastCycle = await collectCycle(this.config, this.node, this.journal);
      await this.ctx.storage.put("collection:v1", {status:"COMPLETE",startedAt,completedAt:Date.now(),lastCycle});
    } catch {
      await this.ctx.storage.put("collection:v1", {status:"FAILED",startedAt,completedAt:Date.now(),...(previous?.lastCycle ? {lastCycle:previous.lastCycle} : {})});
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + this.config.intervalMs);
    }
  }

  /** Only the private internal binding route reaches this method; key/KV are never exported. */
  #exportRecovery(nodeName: "primary" | "secondary"): Response {
    if(!NODE_NAMES.includes(nodeName))throw new Error("UNKNOWN_NODE");
    const collection=this.ctx.storage.kv.get<CollectionState>("collection:v1");
    if(collection?.status==="RUNNING")throw new Error("COLLECTION_RUNNING_RETRY_EXPORT");
    const body=createHostedExport(this.journal,this.identity,{nodeName,operatorGroup:this.config.operatorGroup,release:this.release,
      network:this.config.network,intervalMs:this.config.intervalMs,registry:this.config.registry,methodology:this.config.methodology});
    // Stream through native Fetcher bindings; no arbitrary-RPC response stub crosses Wrangler's bridge.
    return new Response(body,{headers:{"content-type":"application/vnd.sbx.hosted-journal+json","cache-control":"no-store"}});
  }
}

/** Cloudflare account/service-binding authority only; not an HTTP administration endpoint. */
export class RecoveryService extends WorkerEntrypoint<WorkerEnvironment> {
  async fetch(request:Request):Promise<Response> {
    const url=new URL(request.url),match=/^\/export\/(primary|secondary)$/.exec(url.pathname);
    if(request.method!=="POST"||!match||url.search)return json({error:"NOT_FOUND"},404);
    // No request payload is consumed or interpreted; some Fetcher bridges supply an empty body stream.
    const nodeName=match[1] as typeof NODE_NAMES[number];
    return this.env.SBX_NODES.getByName(nodeName).fetch(new Request("https://node.internal/internal/export-recovery",{
      method:"POST",headers:{"x-sbx-recovery-node":nodeName},
    }));
  }
}

export default {
  async fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    const url = new URL(request.url);
    if (["blackwell.fyi", "blackwell.today"].includes(url.hostname)) {
      url.hostname = "blackwellindex.com"; url.protocol = "https:"; url.port = "";
      return secured(Response.redirect(url.toString(), 308));
    }
    let name: typeof NODE_NAMES[number] = url.hostname === "secondary.blackwellindex.com" ? "secondary" : "primary";
    const prefixed = /^\/node\/(primary|secondary)(\/.*)?$/.exec(url.pathname);
    if (prefixed) {
      name = prefixed[1] as typeof NODE_NAMES[number];
      url.pathname = prefixed[2] ?? "/v1/status";
    }
    if (url.pathname.startsWith("/v1/") || url.pathname === "/healthz") {
      const headers = new Headers(request.headers);
      headers.set("x-sbx-client-ip", request.headers.get("CF-Connecting-IP") ?? "unknown");
      const upstream = new Request(url, {method:request.method,headers,body:request.body,redirect:"manual"});
      try { return secured(await env.SBX_NODES.getByName(name).fetch(upstream)); }
      catch { return secured(json({error:"NODE_UNAVAILABLE"},503)); }
    }
    if (prefixed || url.pathname.startsWith("/internal/")) return secured(json({error:"NOT_FOUND"},404));
    if (!["GET", "HEAD"].includes(request.method)) return secured(json({error:"METHOD_NOT_ALLOWED"},405));
    if (url.pathname === "/") url.pathname = url.hostname === "altx.exchange" ? "/altx/index.html" : "/index.html";
    if (["/altx", "/altx/"].includes(url.pathname)) url.pathname = "/altx/index.html";
    if (url.pathname === "/methodology") url.pathname = "/methodology.html";
    return secured(await env.ASSETS.fetch(new Request(url, request)));
  },
  async scheduled(_controller: ScheduledController, env: WorkerEnvironment): Promise<void> {
    await Promise.all(NODE_NAMES.map(name => env.SBX_NODES.getByName(name).fetch(new Request("https://node.internal/internal/wake", {method:"POST"}))));
  },
} satisfies ExportedHandler<WorkerEnvironment>;
