/** Authenticated offchain observation only. No signing, chain transactions, or invented feed bindings. */
import { z } from "zod";
import {verifyPythEvmUpdate} from './evm-verifier';
import {decodeSbxEvmPayload} from './evm-codec';
import { hash } from "../crypto";
import { PYTH_SYMBOLS_URL, validatePythManifest, validatePythSymbols, verifyPythReadback,
  type PythFeedBinding, type PythManifest, type PythReadback } from "./index";
import { PYTH_RECOVERY_LIMITS } from "./recovery-state";

export const PYTH_LATEST_PRICE_URL="https://pyth-lazer.dourolabs.app/v1/latest_price";
// The batch cap is a local resource bound, not a promised Pyth subscription entitlement.
export const PYTH_READBACK_LIMITS=Object.freeze({feeds:PYTH_RECOVERY_LIMITS.feeds,feedsPerRequest:100,responseBytes:1024*1024,tickBytes:16*1024*1024,tickDurationMs:60000,catalogBytes:8_000_000,maxBackoffMs:60*60*1000});
const channels=["real_time","fixed_rate@50ms","fixed_rate@200ms","fixed_rate@1000ms"] as const;
const channelRank:Record<(typeof channels)[number],number>={real_time:0,"fixed_rate@50ms":50,"fixed_rate@200ms":200,"fixed_rate@1000ms":1000};
const natural=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),positive=natural.min(1);
const digest=z.string().regex(/^[a-f0-9]{64}$/),integerText=z.string().max(20).regex(/^(0|[1-9][0-9]*)$/);
export const pythReadbackConfigSchema=z.object({schemaVersion:z.literal(1),enabled:z.boolean(),
  tokenEnv:z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).default("PYTH_PRO_API_KEY"),
  channel:z.enum(channels).default("fixed_rate@1000ms"),pollIntervalMs:positive.min(1000).max(3600000).default(30000),
  requestTimeoutMs:positive.max(30000).default(10000),maxAgeMs:positive.max(86400000),
  maxFeedsPerRequest:positive.max(PYTH_READBACK_LIMITS.feedsPerRequest).default(100),
  maxEnvelopeAgeMs:positive.max(86400000).default(30000),maxConfidenceBps:natural.max(10000),maxPriceDeviationBps:natural.max(10000),
  quoteCurrency:z.string().regex(/^[A-Z]{3}$/).default("USD"),
  signedEvm:z.object({network:z.enum(['base','base-sepolia']),simulationFrom:z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value=>!/^0x0+$/.test(value))}).strict().optional(),
}).strict();
export type PythReadbackConfig=z.infer<typeof pythReadbackConfigSchema>;
const feedStateSchema=z.object({feedId:positive.max(4294967295),feedUpdateTimestampUs:integerText,payloadHash:digest}).strict();
export const pythReadbackStateSchema=z.object({schemaVersion:z.literal(1),scopeHash:digest,updatedAt:positive,nextAttemptAt:positive,
  consecutiveFailures:natural.max(16),feeds:z.array(feedStateSchema).max(PYTH_READBACK_LIMITS.feeds)}).strict();
const stateSchema=pythReadbackStateSchema;
export type PythReadbackState=z.infer<typeof stateSchema>;
const expectedSchema=z.object({feedId:positive.max(4294967295),price:z.string().max(80).regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),sourceTimestampUs:integerText}).strict();
export type PythExpectedPrint=z.infer<typeof expectedSchema>;
export type PythReadbackStatus="DISABLED"|"NOT_CONFIGURED"|"BACKOFF"|"BLOCKED"|"UPSTREAM_OBSERVED"|"UNCHANGED"|"DEGRADED"|"ABORTED"|"PERSISTENCE_FAILED";
export interface PythReadbackFeedResult {feedId:number;status:string;feedUpdateTimestampUs?:string}
export interface PythReadbackResult {
  status:PythReadbackStatus;
  checkedAt:number;
  code?:string;
  feeds:PythReadbackFeedResult[];
  bootstrap:boolean;
  state?:PythReadbackState;
  publisherAttribution:"NOT_ESTABLISHED";
  signatureVerification:"NOT_PERFORMED"|"CONTRACT_ACCEPTED_SINGLE_RPC";
  onchainVerification:"NOT_PERFORMED";
}
export interface PythReadbackTickOptions {
  configuration:unknown;
  manifest:unknown;
  state?:unknown;
  expectedPrints?:readonly PythExpectedPrint[];
  /** The caller must durably commit this state before resolving. Rejection fails closed. */
  persistState:(state:PythReadbackState)=>void|Promise<void>;
  /** Backend environment only. The token value is never copied into state or reports. */
  env?:Record<string,string|undefined>;
  signal?:AbortSignal;
}
/** Dependency injection is for isolated tests, not configuration-supplied endpoints. */
export interface PythReadbackDependencies {fetch?:typeof fetch;now?:()=>number}
class ReadbackFailure extends Error {
  constructor(readonly code:string,readonly retryAfterMs?:number){super(code);}
}
function fail(code:string):never {throw new ReadbackFailure(code);}
function clock(now:()=>number):number {const value=now();if(!positive.safeParse(value).success)fail("CLOCK_INVALID");return value;}
function result(status:PythReadbackStatus,checkedAt:number,bootstrap:boolean,code?:string):PythReadbackResult {
  return {status,checkedAt,feeds:[],bootstrap,...(code===undefined?{}:{code}),publisherAttribution:"NOT_ESTABLISHED",signatureVerification:"NOT_PERFORMED",onchainVerification:"NOT_PERFORMED"};
}
function unsigned(value:unknown,maximum=18446744073709551615n):string {
  const text=typeof value==="number"&&Number.isSafeInteger(value)&&value>=0?String(value):value;
  if(!integerText.safeParse(text).success||BigInt(text as string)>maximum)fail("INTEGER_ENCODING_INVALID");
  return text as string;
}
function expectedMantissa(price:string,exponent:number):bigint {
  const [whole="0",fraction=""]=price.split("."),digits=BigInt(whole+fraction),shift=-exponent-fraction.length;
  const divisor=shift<0?10n**BigInt(-shift):1n;
  if(digits%divisor!==0n)fail("EXPECTED_PRICE_INVALID");
  const value=shift<0?digits/divisor:digits*10n**BigInt(shift);
  if(value<=0n||value>9223372036854775807n)fail("EXPECTED_PRICE_INVALID");
  return value;
}
function retryAfter(header:string|null,now:number):number|undefined {
  if(!header||header.length>128)return undefined;
  if(/^[0-9]{1,12}$/.test(header))return Math.min(Number(header)*1000,PYTH_READBACK_LIMITS.maxBackoffMs);
  const parsed=Date.parse(header);return Number.isFinite(parsed)?Math.min(Math.max(parsed-now,0),PYTH_READBACK_LIMITS.maxBackoffMs):undefined;
}
/** One allocation per bounded body, including one-byte chunks; no unbounded chunk arrays. */
async function requestJson(url:string,init:RequestInit,maximum:number,timeoutMs:number,now:()=>number,request:typeof fetch,signal?:AbortSignal,budget?:{remaining:number}):Promise<unknown> {
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  let response:Response|undefined;
  let rejectAbort:(error:ReadbackFailure)=>void=()=>{};
  const abortPromise=new Promise<never>((_,reject)=>{rejectAbort=reject;});
  // Avoid an unhandled rejection if cancellation occurs between response reads.
  void abortPromise.catch(()=>{});
  const abort=(code:string)=>{controller.abort();rejectAbort(new ReadbackFailure(code));};
  const onAbort=()=>abort("ABORTED");
  signal?.addEventListener("abort",onAbort,{once:true});
  try {
    if(signal?.aborted)fail("ABORTED");
    timer=setTimeout(()=>abort("REQUEST_TIMEOUT"),timeoutMs);
    response=await Promise.race([request(url,{...init,redirect:"error",signal:controller.signal}),abortPromise]);
    if(response.status===401||response.status===403)fail("AUTHORIZATION_REQUIRED");
    if(response.status===429||response.status===503)throw new ReadbackFailure(`HTTP_${response.status}`,retryAfter(response.headers.get("retry-after"),clock(now)));
    if(response.status===400)fail("REQUEST_OR_ENTITLEMENT_INVALID");
    if(!response.ok)throw new ReadbackFailure(response.status===404?"FEED_OR_ENDPOINT_UNAVAILABLE":"UPSTREAM_HTTP_ERROR");
    if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type")??""))fail("CONTENT_TYPE_INVALID");
    const declared=response.headers.get("content-length");
    if(declared&&/^[0-9]+$/.test(declared)&&Number(declared)>maximum)fail("RESPONSE_TOO_LARGE");
    if(!response.body)fail("RESPONSE_BODY_MISSING");
    reader=response.body.getReader();const bytes=new Uint8Array(maximum);let used=0;
    for(;;) {
      const part=await Promise.race([reader.read(),abortPromise]);if(part.done)break;
      if(used+part.value.byteLength>maximum)fail("RESPONSE_TOO_LARGE");
      if(budget){budget.remaining-=part.value.byteLength;if(budget.remaining<0)fail("TICK_RESPONSE_BUDGET_EXCEEDED");}
      bytes.set(part.value,used);used+=part.value.byteLength;
    }
    try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,used))) as unknown;}catch{fail("RESPONSE_JSON_INVALID");}
  }catch(error){if(error instanceof ReadbackFailure)throw error;if(signal?.aborted)fail("ABORTED");fail("NETWORK_ERROR");}
  finally {
    if(timer!==undefined)clearTimeout(timer);signal?.removeEventListener("abort",onAbort);controller.abort();
    if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* A non-cooperating injected reader may still own a pending read. */}}
    else if(response?.body)void response.body.cancel().catch(()=>{});
  }
}
function scope(manifest:PythManifest,configuration:PythReadbackConfig):string {
  // Capture the exact reviewed policy. Renewed approval or changed bindings require
  // an explicit state migration/review, never silent loss of high-water marks.
  return hash({kind:"SBX_PYTH_READBACK_V1",configuration,network:manifest.network,registryHash:manifest.registryHash,
    methodologyHash:manifest.methodologyHash,approval:manifest.approval,bindings:manifest.bindings});
}
export function validatePythReadbackCatalog(raw:unknown,manifest:PythManifest,config:PythReadbackConfig):void {
  let parsed:ReturnType<typeof validatePythSymbols>;
  try{parsed=validatePythSymbols(raw);}catch{fail("CATALOG_INVALID");}
  const values=new Map(parsed.map(value=>[value.pyth_lazer_id,value]));
  for(const binding of manifest.bindings) {
    const value=values.get(binding.pythFeedId) as ((typeof parsed)[number]&{min_channel?:unknown;quote_currency?:unknown})|undefined;
    if(!value||value.symbol!==binding.symbol||value.exponent!==binding.exponent||value.min_publishers!==binding.minPublishers||value.state!=="stable"||value.quote_currency!==config.quoteCurrency)fail("CATALOG_BINDING_MISMATCH");
    if(typeof value.min_channel!=="string"||!channels.includes(value.min_channel as (typeof channels)[number]))fail("CATALOG_CHANNEL_REVIEW_REQUIRED");
    if(channelRank[config.channel]<channelRank[value.min_channel as (typeof channels)[number]])fail("CHANNEL_UNSUPPORTED");
  }
}
/** Shared policy for parsed or contract-returned values. Does not authenticate input. */
export function validatePythReadbackFeed(raw:unknown,binding:PythFeedBinding,config:PythReadbackConfig,now:number,envelopeUs:bigint,expected:PythExpectedPrint|undefined,previous:z.infer<typeof feedStateSchema>|undefined) {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))fail("FEED_INVALID");
  const value=raw as Record<string,unknown>;
  if(value.priceFeedId!==binding.pythFeedId||value.exponent!==binding.exponent)fail("FEED_IDENTITY_MISMATCH");
  if(["price","confidence","publisherCount","feedUpdateTimestamp"].some(key=>value[key]===null||value[key]===undefined))fail("PRICE_UNAVAILABLE");
  const price=unsigned(value.price,9223372036854775807n),confidence=unsigned(value.confidence,9223372036854775807n),feedUpdateTimestamp=unsigned(value.feedUpdateTimestamp);
  if(BigInt(price)===0n)fail("PRICE_INVALID");
  const generated=BigInt(feedUpdateTimestamp),nowUs=BigInt(now)*1000n;
  if(generated===0n||generated>nowUs||generated>envelopeUs)fail("FEED_CLOCK_INVALID");
  if(nowUs-generated>BigInt(config.maxAgeMs)*1000n)fail("PRICE_STALE");
  if(!natural.max(65535).safeParse(value.publisherCount).success||Number(value.publisherCount)<binding.minPublishers)fail("INSUFFICIENT_PUBLISHERS");
  if(BigInt(confidence)*10000n>BigInt(price)*BigInt(config.maxConfidenceBps))fail("CONFIDENCE_EXCEEDED");
  const normalized:PythReadback={priceFeedId:binding.pythFeedId,price,confidence,exponent:binding.exponent,publisherCount:Number(value.publisherCount),feedUpdateTimestamp};
  try{verifyPythReadback(normalized,binding,{now,maxAgeMs:config.maxAgeMs,maxDeviationBps:config.maxConfidenceBps});}catch{fail("FEED_INVALID");}
  // Pyth documents confidence/count as carried with the same generated price;
  // marketSession alone may change without a new generation timestamp.
  const payloadHash=hash(normalized);
  if(previous) {
    if(generated<BigInt(previous.feedUpdateTimestampUs))fail("FEED_TIMESTAMP_ROLLBACK");
    if(generated===BigInt(previous.feedUpdateTimestampUs)&&payloadHash!==previous.payloadHash)fail("SAME_TIMESTAMP_CONFLICT");
  }
  if(!expected)fail("EXPECTED_PRINT_MISSING");
  const source=BigInt(expected.sourceTimestampUs);
  if(source===0n||source>nowUs)fail("EXPECTED_PRINT_CLOCK_INVALID");
  if(nowUs-source>BigInt(config.maxAgeMs)*1000n)fail("EXPECTED_PRINT_STALE");
  if(generated<source)fail("AWAITING_EXPECTED_PRINT");
  let expectedPrice:bigint;
  try{expectedPrice=expectedMantissa(expected.price,binding.exponent);}catch{fail("EXPECTED_PRICE_INVALID");}
  const deviation=BigInt(price)>expectedPrice?BigInt(price)-expectedPrice:expectedPrice-BigInt(price);
  if(deviation*10000n>expectedPrice*BigInt(config.maxPriceDeviationBps))fail("PRICE_MISMATCH");
  return {state:{feedId:binding.pythFeedId,feedUpdateTimestampUs:feedUpdateTimestamp,payloadHash},
    report:{feedId:binding.pythFeedId,status:previous&&generated===BigInt(previous.feedUpdateTimestampUs)?"UNCHANGED":"ADVANCED",feedUpdateTimestampUs:feedUpdateTimestamp}};
}

/** Await durable persistence before returning a successful observation or advancing a watermark. */
export async function readbackTick(options:PythReadbackTickOptions,dependencies:PythReadbackDependencies={}):Promise<PythReadbackResult> {
  const now=dependencies.now??Date.now,request=dependencies.fetch??fetch;let checkedAt=0,startedAt=0,bootstrap=options.state===undefined;
  let config:PythReadbackConfig|undefined,manifest:PythManifest|undefined,state:PythReadbackState|undefined,scopeHash:string|undefined;
  try {
    checkedAt=clock(now);startedAt=checkedAt;if(options.signal?.aborted)return result("ABORTED",checkedAt,bootstrap,"ABORTED");
    const parsed=pythReadbackConfigSchema.safeParse(options.configuration);if(!parsed.success)return result("BLOCKED",checkedAt,bootstrap,"CONFIGURATION_INVALID");config=parsed.data;
    if(!config.enabled)return result("DISABLED",checkedAt,bootstrap);
    if(options.manifest===null||options.manifest===undefined)return result("NOT_CONFIGURED",checkedAt,bootstrap,"APPROVAL_REQUIRED");
    try{manifest=validatePythManifest(structuredClone(options.manifest),checkedAt);}catch{return result("NOT_CONFIGURED",checkedAt,bootstrap,"APPROVAL_REQUIRED");}
    if(!manifest.enabled||manifest.approval.status!=="APPROVED"||manifest.approval.expiresAt<=checkedAt)return result("NOT_CONFIGURED",checkedAt,bootstrap,"APPROVAL_REQUIRED");
    if(config.maxAgeMs>manifest.maxAgeMs)return result("BLOCKED",checkedAt,bootstrap,"AGE_POLICY_EXCEEDS_APPROVAL");
    if(manifest.bindings.length>PYTH_READBACK_LIMITS.feeds)return result("BLOCKED",checkedAt,bootstrap,"FEED_CAPACITY");
    const token=(options.env??process.env)[config.tokenEnv];
    if(!token||token.length>8192||/[\r\n]/.test(token))return result("NOT_CONFIGURED",checkedAt,bootstrap,"CONSUMER_TOKEN_REQUIRED");
    if(typeof options.persistState!=="function")return result("PERSISTENCE_FAILED",checkedAt,bootstrap,"PERSISTENCE_REQUIRED");
    scopeHash=scope(manifest,config);
    if(options.state!==undefined) {
      const prior=stateSchema.safeParse(options.state);if(!prior.success)return result("BLOCKED",checkedAt,false,"STATE_INVALID");state=prior.data;
      if(state.scopeHash!==scopeHash)return result("BLOCKED",checkedAt,false,"STATE_SCOPE_REVIEW_REQUIRED");
      const boundIds=new Set(manifest.bindings.map(binding=>binding.pythFeedId));
      if(new Set(state.feeds.map(feed=>feed.feedId)).size!==state.feeds.length||state.feeds.some(feed=>!boundIds.has(feed.feedId)||BigInt(feed.feedUpdateTimestampUs)===0n||BigInt(feed.feedUpdateTimestampUs)>BigInt(state!.updatedAt)*1000n)||state.nextAttemptAt<state.updatedAt||state.nextAttemptAt-state.updatedAt>PYTH_READBACK_LIMITS.maxBackoffMs)return result("BLOCKED",checkedAt,false,"STATE_INVALID");
      if(state.updatedAt>checkedAt)return result("BLOCKED",checkedAt,false,"CLOCK_ROLLBACK");
      if(checkedAt<state.nextAttemptAt)return {...result("BACKOFF",checkedAt,false),state};
    }
    const expectedValues=z.array(expectedSchema).max(PYTH_READBACK_LIMITS.feeds).safeParse(options.expectedPrints??[]);
    if(!expectedValues.success)fail("EXPECTED_PRINTS_INVALID");
    const expected=new Map(expectedValues.data.map(value=>[value.feedId,value]));
    if(expected.size!==expectedValues.data.length||[...expected.keys()].some(id=>!manifest!.bindings.some(binding=>binding.pythFeedId===id)))fail("EXPECTED_PRINTS_INVALID");
    const tickDeadline=performance.now()+PYTH_READBACK_LIMITS.tickDurationMs,budget={remaining:PYTH_READBACK_LIMITS.tickBytes};
    const timeout=()=>{const remaining=Math.floor(tickDeadline-performance.now());if(remaining<=0)fail("TICK_DEADLINE_EXCEEDED");return Math.min(config!.requestTimeoutMs,remaining);};
    const catalog=await requestJson(PYTH_SYMBOLS_URL,{method:"GET"},PYTH_READBACK_LIMITS.catalogBytes,timeout(),now,request,options.signal,budget);
    validatePythReadbackCatalog(catalog,manifest,config);
    const feeds=new Map<number,{value:unknown;envelope:bigint}>(),envelopes:bigint[]=[];
    for(let offset=0;offset<manifest.bindings.length;offset+=config.maxFeedsPerRequest) {
      const batch=manifest.bindings.slice(offset,offset+config.maxFeedsPerRequest),ids=new Set(batch.map(binding=>binding.pythFeedId));
      const raw=await requestJson(PYTH_LATEST_PRICE_URL,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({
        priceFeedIds:[...ids],properties:["price","confidence","exponent","publisherCount","feedUpdateTimestamp",...(config.signedEvm?[]:["marketSession"])],
        formats:config.signedEvm?["evm"]:[],parsed:!config.signedEvm,channel:config.channel,...(config.signedEvm?{jsonBinaryEncoding:'hex'}:{}),
      })},PYTH_READBACK_LIMITS.responseBytes,timeout(),now,request,options.signal,budget);
      let signedPayload:unknown;
      if(config.signedEvm) {
        const wire=raw&&typeof raw==='object'&&!Array.isArray(raw)?(raw as {evm?:unknown}).evm:undefined;
        if(!wire||typeof wire!=='object'||Array.isArray(wire)||(wire as {encoding?:unknown}).encoding!=='hex')fail('SIGNED_PAYLOAD_MISSING');
        const controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
        const timer=setTimeout(abort,timeout());
        try {
          if(options.signal?.aborted)fail('ABORTED');
          const verified=await verifyPythEvmUpdate({update:(wire as {data?:unknown}).data,...config.signedEvm,signal:controller.signal},{fetch:request,now,requestTimeoutMs:Math.min(config.requestTimeoutMs,5000),responseBudget:budget});
          if(verified.status!=='CONTRACT_ACCEPTED'||!verified.payloadHex)fail('SIGNED_VERIFICATION_FAILED');
          const decoded=decodeSbxEvmPayload(verified.payloadHex);
          if(decoded.channel!==config.channel)fail('CHANNEL_MISMATCH');
          signedPayload={timestampUs:String(decoded.timestampUs),priceFeeds:decoded.feeds.map(feed=>({priceFeedId:feed.priceFeedId,price:String(feed.price),confidence:String(feed.confidence),exponent:feed.exponent,publisherCount:feed.publisherCount,feedUpdateTimestamp:String(feed.feedUpdateTimestampUs)}))};
        } finally {clearTimeout(timer);options.signal?.removeEventListener('abort',abort);controller.abort();}
      }
      const completedAt=clock(now);if(completedAt<checkedAt)fail("CLOCK_ROLLBACK");checkedAt=completedAt;
      if(manifest.approval.expiresAt<=checkedAt)fail("APPROVAL_EXPIRED");
      if(!raw||typeof raw!=="object"||Array.isArray(raw))fail("RESPONSE_INVALID");
      const payload=config.signedEvm?signedPayload:(raw as {parsed?:unknown}).parsed;
      if(!payload||typeof payload!=="object"||Array.isArray(payload))fail("PARSED_PAYLOAD_MISSING");
      const {timestampUs,priceFeeds}=payload as {timestampUs?:unknown;priceFeeds?:unknown};
      const envelope=BigInt(unsigned(timestampUs)),nowUs=BigInt(checkedAt)*1000n;
      if(envelope===0n||envelope>nowUs||nowUs-envelope>BigInt(config.maxEnvelopeAgeMs)*1000n)fail("ENVELOPE_CLOCK_INVALID");
      envelopes.push(envelope);
      if(!Array.isArray(priceFeeds)||priceFeeds.length>batch.length||config.signedEvm&&priceFeeds.length!==batch.length)fail("RESPONSE_FEED_SET_INVALID");
      for(const value of priceFeeds) {
        const id=value&&typeof value==="object"?(value as {priceFeedId?:unknown}).priceFeedId:undefined;
        if(typeof id!=="number"||!ids.has(id)||feeds.has(id))fail("RESPONSE_FEED_SET_INVALID");feeds.set(id,{value,envelope});
      }
    }
    // Recheck early batches at the final clock, not only when their response arrived.
    if(envelopes.some(envelope=>BigInt(checkedAt)*1000n-envelope>BigInt(config!.maxEnvelopeAgeMs)*1000n))fail("ENVELOPE_CLOCK_INVALID");
    const previous=new Map((state?.feeds??[]).map(value=>[value.feedId,value])),out=result("UNCHANGED",checkedAt,bootstrap);
    for(const binding of manifest.bindings) {
      if(!feeds.has(binding.pythFeedId)){out.feeds.push({feedId:binding.pythFeedId,status:"PRICE_UNAVAILABLE"});continue;}
      try{const entry=feeds.get(binding.pythFeedId)!;const value=validatePythReadbackFeed(entry.value,binding,config,checkedAt,entry.envelope,expected.get(binding.pythFeedId),previous.get(binding.pythFeedId));previous.set(binding.pythFeedId,value.state);out.feeds.push(value.report);}
      catch(error){out.feeds.push({feedId:binding.pythFeedId,status:error instanceof ReadbackFailure?error.code:"FEED_INVALID"});}
    }
    const degraded=out.feeds.some(feed=>feed.status!=="ADVANCED"&&feed.status!=="UNCHANGED");
    // Signed acceptance is atomic across every requested feed and batch. Failure
    // persists only backoff metadata through the catch path, never partial marks.
    if(config.signedEvm&&degraded)fail('SIGNED_POLICY_FAILED');
    if(config.signedEvm)out.signatureVerification='CONTRACT_ACCEPTED_SINGLE_RPC';
    out.status=degraded?"DEGRADED":out.feeds.some(feed=>feed.status==="ADVANCED")?"UPSTREAM_OBSERVED":"UNCHANGED";
    const next:PythReadbackState={schemaVersion:1,scopeHash,updatedAt:checkedAt,nextAttemptAt:checkedAt+config.pollIntervalMs,
      consecutiveFailures:degraded?Math.min((state?.consecutiveFailures??0)+1,16):0,feeds:[...previous.values()].sort((a,b)=>a.feedId-b.feedId)};
    stateSchema.parse(next);options.signal?.throwIfAborted();
    try{await options.persistState(next);}catch{return result("PERSISTENCE_FAILED",checkedAt,bootstrap,"PERSISTENCE_FAILED");}
    if(options.signal?.aborted)return {...result("ABORTED",checkedAt,bootstrap,"ABORTED"),state:next};
    return {...out,state:next};
  }catch(error) {
    if(options.signal?.aborted||error instanceof ReadbackFailure&&error.code==="ABORTED")return result("ABORTED",checkedAt,bootstrap,"ABORTED");
    const code=error instanceof ReadbackFailure?error.code:"READBACK_FAILED";
    try{const completedAt=clock(now);if(completedAt<startedAt||state&&completedAt<state.updatedAt)return result("BLOCKED",completedAt,bootstrap,"CLOCK_ROLLBACK");checkedAt=completedAt;}
    catch{return result("BLOCKED",checkedAt,bootstrap,"CLOCK_INVALID");}
    const out=result("DEGRADED",checkedAt,bootstrap,code);
    if(config&&scopeHash) {
      const failures=Math.min((state?.consecutiveFailures??0)+1,16),delay=Math.max(config.pollIntervalMs,Math.min(5000*2**(failures-1),PYTH_READBACK_LIMITS.maxBackoffMs),error instanceof ReadbackFailure?error.retryAfterMs??0:0);
      const next:PythReadbackState={schemaVersion:1,scopeHash,updatedAt:checkedAt,nextAttemptAt:checkedAt+delay,consecutiveFailures:failures,feeds:state?.feeds??[]};
      try{stateSchema.parse(next);await options.persistState(next);}catch{return result("PERSISTENCE_FAILED",checkedAt,bootstrap,"PERSISTENCE_FAILED");}
      if(options.signal?.aborted)return {...result("ABORTED",checkedAt,bootstrap,"ABORTED"),state:next};
      return {...out,state:next};
    }
    return out;
  }
}

export interface PythReadbackLoopOptions extends Omit<PythReadbackTickOptions,"expectedPrints"|"signal"> {
  signal:AbortSignal;
  /** Return expectations from the latest genuinely observed, approved local print. */
  getExpectedPrints:()=>readonly PythExpectedPrint[]|Promise<readonly PythExpectedPrint[]>;
  onReport?:(report:PythReadbackResult)=>void|Promise<void>;
}
function sleep(ms:number,signal:AbortSignal):Promise<void> {
  return new Promise(resolve=>{
    if(signal.aborted){resolve();return;}
    const timer=setTimeout(done,ms);function done(){clearTimeout(timer);signal.removeEventListener("abort",done);resolve();}
    signal.addEventListener("abort",done,{once:true});if(signal.aborted)done();
  });
}
/** One tick at a time; no unbounded report history or overlapping requests. Restart after configuration changes. */
export async function runReadbackMonitor(options:PythReadbackLoopOptions,dependencies:PythReadbackDependencies={}):Promise<{ticks:number;status:PythReadbackStatus}> {
  let state=options.state,ticks=0,status:PythReadbackStatus="ABORTED";
  const configuration=pythReadbackConfigSchema.safeParse(options.configuration);
  if(!configuration.success)return {ticks,status:"BLOCKED"};
  if(!configuration.data.enabled)return {ticks,status:"DISABLED"};
  while(!options.signal.aborted) {
    let expectedPrints:readonly PythExpectedPrint[];
    try{expectedPrints=await options.getExpectedPrints();}catch{return {ticks,status:"BLOCKED"};}
    const report=await readbackTick({...options,...(state===undefined?{}:{state}),expectedPrints},dependencies);
    ticks++;status=report.status;if(report.state)state=report.state;
    if(options.onReport){try{await options.onReport(report);}catch{return {ticks,status:"BLOCKED"};}}
    if(["DISABLED","NOT_CONFIGURED","BLOCKED","ABORTED","PERSISTENCE_FAILED"].includes(status))return {ticks,status};
    await sleep(configuration.data.pollIntervalMs,options.signal);
  }
  return {ticks,status:options.signal.aborted?"ABORTED":status};
}
