/** Read-only deployment metadata check. Not a price, signature, transaction or oracle-health check. */
import { createHash } from "node:crypto";

// Primary references reviewed 2026-09-06:
// https://docs.pyth.network/price-feeds/pro/contract-addresses
// https://github.com/pyth-network/pyth-crosschain/blob/main/lazer/contracts/evm/src/PythLazer.sol
// https://docs.base.org/base-chain/api-reference/rpc-overview
// https://eips.ethereum.org/EIPS/eip-1898
export const PYTH_BASE_VERIFIER="0xACeA761c27A909d4D3895128EBe6370FDE2dF481";
// Independently derived with cast sig from the reviewed Solidity ABI. The source
// currently reports 0.2.0; Base's observed 0.1.1 is a separate per-chain review pin.
export const PYTH_PREFLIGHT_SELECTORS=Object.freeze({version:"0x54fd4d50",verificationFee:"0xbac12f87"});
export const PYTH_PREFLIGHT_NETWORKS=Object.freeze({
  "base-sepolia":Object.freeze({chainId:84532,rpc:"https://sepolia.base.org",expectedVersion:"0.1.1"}),
  base:Object.freeze({chainId:8453,rpc:"https://mainnet.base.org",expectedVersion:"0.1.1"}),
});
export const PYTH_PREFLIGHT_LIMITS=Object.freeze({responseBytes:1024*1024,codeBytes:64*1024,requestTimeoutMs:5000,totalTimeoutMs:30000,maxBlockAgeMs:120000});
type Network=keyof typeof PYTH_PREFLIGHT_NETWORKS;
export interface PythChainPreflightOptions {network?:Network;signal?:AbortSignal}
export interface PythChainPreflightDependencies {fetch?:typeof fetch;now?:()=>number;requestTimeoutMs?:number}
export interface PythChainPreflightReport {
  status:"DEPLOYMENT_PREFLIGHT_PASSED"|"BLOCKED"|"ABORTED";
  checkedAt:number;
  code?:string;
  network:Network;
  chainId:number;
  rpc:string;
  verifier:string;
  expectedVersion:string;
  block?:{number:string;hash:string;timestamp:string;selection:"LATEST_SEALED";canonicalHashRechecked:true};
  runtimeCodeBytes?:number;
  runtimeCodeSha256?:string;
  version?:string;
  verificationFeeWei?:string;
  observationAuthority:"SINGLE_PUBLIC_RPC";
  implementationAttestation:"NOT_PERFORMED";
  finalityVerification:"NOT_PERFORMED";
  signedPayloadVerification:"NOT_PERFORMED";
  priceVerification:"NOT_PERFORMED";
  transactionSubmission:"NOT_PERFORMED";
  oracleHealth:"NOT_ASSESSED";
}
class PreflightFailure extends Error {constructor(readonly code:string){super(code);}}
function fail(code:string):never {throw new PreflightFailure(code);}
function now(clock:()=>number):number {const value=clock();if(!Number.isSafeInteger(value)||value<=0||value>Number.MAX_SAFE_INTEGER-5000)fail("CLOCK_INVALID");return value;}
function quantity(value:unknown):bigint {
  if(typeof value!=="string"||!/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(value))fail("RPC_QUANTITY_INVALID");return BigInt(value);
}
function hex(value:unknown,maximum:number):Buffer {
  if(typeof value!=="string"||value.length>2+maximum*2||!/^0x(?:[0-9a-fA-F]{2})*$/.test(value))fail("RPC_HEX_INVALID");return Buffer.from(value.slice(2),"hex");
}
function decodeVersion(value:unknown):string {
  const bytes=hex(value,128);
  if(bytes.length<96||BigInt("0x"+bytes.subarray(0,32).toString("hex"))!==32n)fail("VERSION_ABI_INVALID");
  const length=BigInt("0x"+bytes.subarray(32,64).toString("hex"));
  if(length<1n||length>32n||bytes.length!==96)fail("VERSION_ABI_INVALID");
  const end=64+Number(length);
  if(bytes.subarray(end).some(byte=>byte!==0))fail("VERSION_ABI_INVALID");
  const text=bytes.subarray(64,end).toString("utf8");
  if(!/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(text))fail("VERSION_ABI_INVALID");return text;
}
function decodeFee(value:unknown):string {const bytes=hex(value,32);if(bytes.length!==32)fail("FEE_ABI_INVALID");return BigInt("0x"+bytes.toString("hex")).toString();}
type Block={number:string;hash:string;timestamp:string};
function block(value:unknown,clock:number):Block {
  if(!value||typeof value!=="object"||Array.isArray(value))fail("SEALED_BLOCK_REQUIRED");
  const raw=value as Record<string,unknown>,height=quantity(raw.number),timestamp=quantity(raw.timestamp);
  if(height===0n||typeof raw.hash!=="string"||!/^0x[0-9a-f]{64}$/.test(raw.hash)||/^0x0+$/.test(raw.hash))fail("SEALED_BLOCK_REQUIRED");
  if(timestamp===0n||timestamp*1000n>BigInt(clock)+5000n||BigInt(clock)-timestamp*1000n>BigInt(PYTH_PREFLIGHT_LIMITS.maxBlockAgeMs))fail("BLOCK_CLOCK_INVALID");
  return {number:raw.number as string,hash:raw.hash,timestamp:raw.timestamp as string};
}
async function rpc(url:string,id:number,method:string,params:unknown[],request:typeof fetch,signal:AbortSignal,timeout:number):Promise<unknown> {
  const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,response:Response|undefined;
  let rejectAbort:(error:PreflightFailure)=>void=()=>{};
  const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});void aborted.catch(()=>{});
  const stop=(code:string)=>{controller.abort();rejectAbort(new PreflightFailure(code));};
  const abort=()=>stop("ABORTED"),timer=setTimeout(()=>stop("REQUEST_TIMEOUT"),timeout);
  signal.addEventListener("abort",abort,{once:true});
  try {
    if(signal.aborted)fail("ABORTED");
    response=await Promise.race([request(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id,method,params}),redirect:"error",signal:controller.signal}),aborted]);
    if(!response.ok)fail(response.status===429?"RPC_RATE_LIMITED":"RPC_HTTP_ERROR");
    if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type")??""))fail("RPC_CONTENT_TYPE_INVALID");
    const length=response.headers.get("content-length");if(length&&/^\d+$/.test(length)&&Number(length)>PYTH_PREFLIGHT_LIMITS.responseBytes)fail("RPC_RESPONSE_TOO_LARGE");
    if(!response.body)fail("RPC_BODY_MISSING");
    reader=response.body.getReader();const bytes=new Uint8Array(PYTH_PREFLIGHT_LIMITS.responseBytes);let used=0;
    for(;;) {
      const next=await Promise.race([reader.read(),aborted]);if(next.done)break;
      if(used+next.value.byteLength>bytes.length)fail("RPC_RESPONSE_TOO_LARGE");bytes.set(next.value,used);used+=next.value.byteLength;
    }
    let value:unknown;try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,used)));}catch{fail("RPC_JSON_INVALID");}
    if(!value||typeof value!=="object"||Array.isArray(value))fail("RPC_ENVELOPE_INVALID");
    const raw=value as Record<string,unknown>;
    if(raw.jsonrpc!=="2.0"||raw.id!==id||Object.keys(raw).some(key=>!["jsonrpc","id","result","error"].includes(key))||("error" in raw)===("result" in raw))fail("RPC_ENVELOPE_INVALID");
    if("error" in raw)fail("RPC_METHOD_REJECTED");return raw.result;
  }catch(error){if(error instanceof PreflightFailure)throw error;if(signal.aborted)fail("ABORTED");fail("RPC_NETWORK_ERROR");}
  finally {
    clearTimeout(timer);signal.removeEventListener("abort",abort);controller.abort();
    if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* Isolated noncooperative reader may still own a pending read. */}}
    else if(response?.body)void response.body.cancel().catch(()=>{});
  }
}

/** Only the two reviewed public endpoints and seven read-only requests are possible. */
export async function preflightPythBase(options:PythChainPreflightOptions={},dependencies:PythChainPreflightDependencies={}):Promise<PythChainPreflightReport> {
  const network=options.network??"base-sepolia",valid=Object.hasOwn(PYTH_PREFLIGHT_NETWORKS,network),selected=PYTH_PREFLIGHT_NETWORKS[valid?network:"base-sepolia"];
  const report:PythChainPreflightReport={status:"BLOCKED",checkedAt:0,network:valid?network:"base-sepolia",chainId:selected.chainId,rpc:selected.rpc,verifier:PYTH_BASE_VERIFIER,expectedVersion:selected.expectedVersion,
    observationAuthority:"SINGLE_PUBLIC_RPC",implementationAttestation:"NOT_PERFORMED",finalityVerification:"NOT_PERFORMED",signedPayloadVerification:"NOT_PERFORMED",priceVerification:"NOT_PERFORMED",transactionSubmission:"NOT_PERFORMED",oracleHealth:"NOT_ASSESSED"};
  const controller=new AbortController(),cancel=()=>controller.abort();options.signal?.addEventListener("abort",cancel,{once:true});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},PYTH_PREFLIGHT_LIMITS.totalTimeoutMs);
  try {
    const clock=dependencies.now??Date.now;report.checkedAt=now(clock);if(!valid)fail("NETWORK_NOT_REVIEWED");
    const timeout=dependencies.requestTimeoutMs??PYTH_PREFLIGHT_LIMITS.requestTimeoutMs;
    if(!Number.isSafeInteger(timeout)||timeout<1||timeout>PYTH_PREFLIGHT_LIMITS.requestTimeoutMs)fail("TIMEOUT_INVALID");
    if(options.signal?.aborted)fail("ABORTED");let id=0;
    const call=(method:string,params:unknown[])=>rpc(selected.rpc,++id,method,params,dependencies.fetch??fetch,controller.signal,timeout);
    if(quantity(await call("eth_chainId",[]))!==BigInt(selected.chainId))fail("CHAIN_ID_MISMATCH");
    const sealed=block(await call("eth_getBlockByNumber",["latest",false]),now(clock));
    const pinned={blockHash:sealed.hash,requireCanonical:true};
    const code=hex(await call("eth_getCode",[PYTH_BASE_VERIFIER,pinned]),PYTH_PREFLIGHT_LIMITS.codeBytes);
    if(!code.length||!code.some(byte=>byte!==0))fail("VERIFIER_CODE_MISSING");
    const version=decodeVersion(await call("eth_call",[{to:PYTH_BASE_VERIFIER,data:PYTH_PREFLIGHT_SELECTORS.version},pinned]));
    if(version!==selected.expectedVersion)fail("DEPLOYED_VERSION_REVIEW_REQUIRED");
    const verificationFeeWei=decodeFee(await call("eth_call",[{to:PYTH_BASE_VERIFIER,data:PYTH_PREFLIGHT_SELECTORS.verificationFee},pinned]));
    const confirmed=block(await call("eth_getBlockByNumber",[sealed.number,false]),now(clock));
    if(confirmed.hash!==sealed.hash||confirmed.number!==sealed.number||confirmed.timestamp!==sealed.timestamp)fail("PINNED_BLOCK_CHANGED");
    if(quantity(await call("eth_chainId",[]))!==BigInt(selected.chainId))fail("CHAIN_ID_MISMATCH");
    const checkedAt=now(clock);if(checkedAt<report.checkedAt)fail("CLOCK_ROLLBACK");block(sealed,checkedAt);controller.signal.throwIfAborted();
    return {...report,status:"DEPLOYMENT_PREFLIGHT_PASSED",checkedAt,block:{...sealed,selection:"LATEST_SEALED",canonicalHashRechecked:true},
      runtimeCodeBytes:code.length,runtimeCodeSha256:createHash("sha256").update(code).digest("hex"),version,verificationFeeWei};
  }catch(error) {
    const aborted=options.signal?.aborted===true;
    return {...report,status:aborted?"ABORTED":"BLOCKED",code:timedOut?"TOTAL_DEADLINE_EXCEEDED":aborted?"ABORTED":error instanceof PreflightFailure?error.code:"PREFLIGHT_FAILED"};
  }finally{clearTimeout(timer);options.signal?.removeEventListener("abort",cancel);controller.abort();}
}

export async function runPythChainPreflightCli(args:string[],dependencies:PythChainPreflightDependencies={},signal?:AbortSignal):Promise<{exitCode:number;report:PythChainPreflightReport}> {
  const valid=args.length===0||args.length===2&&args[0]==="--network"&&["base-sepolia","base"].includes(args[1]!);
  const report=await preflightPythBase({network:(valid?(args[1]??"base-sepolia"):"invalid") as Network,...(signal?{signal}:{})},dependencies);
  if(!valid)report.code="ARGUMENTS_INVALID";
  return {exitCode:report.status==="DEPLOYMENT_PREFLIGHT_PASSED"?0:report.status==="ABORTED"?130:1,report};
}
if(import.meta.main) {
  const controller=new AbortController(),stop=()=>controller.abort();process.on("SIGTERM",stop);process.on("SIGINT",stop);
  try{const result=await runPythChainPreflightCli(process.argv.slice(2),{},controller.signal);process.stdout.write(JSON.stringify(result.report)+"\n");process.exitCode=result.exitCode;}
  finally{process.off("SIGTERM",stop);process.off("SIGINT",stop);}
}
