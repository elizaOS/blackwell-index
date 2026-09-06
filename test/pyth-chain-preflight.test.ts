// Synthetic RPC/ABI fixtures only. No chain requests, signers or transactions.
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { preflightPythBase, pythReadOnlyRpc, PYTH_BASE_VERIFIER, PYTH_PREFLIGHT_LIMITS, PYTH_PREFLIGHT_NETWORKS, PYTH_PREFLIGHT_SELECTORS, runPythChainPreflightCli,
  type PythChainPreflightDependencies } from "../src/pyth/chain-preflight";

const NOW=1788700000000,HASH="0x"+"a".repeat(64),PRIVATE="isolated-private-error-must-not-appear";
const header=()=>({number:"0x1234",hash:HASH,timestamp:"0x"+Math.floor(NOW/1000).toString(16)});
const word=(value:bigint)=>value.toString(16).padStart(64,"0");

test("shared read-only transport rejects writes, custom endpoints and state overrides before fetch",async()=>{
  let requests=0;
  const request=(async()=>{requests++;throw Error("must not fetch");}) as unknown as typeof fetch;
  const invoke=(url:string,method:string,params:unknown[],id=1,timeout=100)=>pythReadOnlyRpc(url,id,method,params,request,new AbortController().signal,timeout);
  for(const method of ["eth_sendTransaction","eth_sendRawTransaction","personal_sign","eth_sign","wallet_addEthereumChain"]) {
    await expect(invoke(PYTH_PREFLIGHT_NETWORKS.base.rpc,method,[])).rejects.toThrow("RPC_METHOD_NOT_READ_ONLY");
  }
  await expect(invoke("https://example.invalid","eth_chainId",[])).rejects.toThrow("RPC_ENDPOINT_NOT_REVIEWED");
  await expect(invoke(PYTH_PREFLIGHT_NETWORKS.base.rpc,"eth_call",[{},"latest",{}])).rejects.toThrow("RPC_PARAMS_INVALID");
  await expect(invoke(PYTH_PREFLIGHT_NETWORKS.base.rpc,"eth_chainId",[],0)).rejects.toThrow("RPC_ID_INVALID");
  await expect(invoke(PYTH_PREFLIGHT_NETWORKS.base.rpc,"eth_chainId",[],1,6000)).rejects.toThrow("TIMEOUT_INVALID");
  expect(requests).toBe(0);
});
function version(text="0.1.1"):string {const bytes=Buffer.from(text);return "0x"+word(32n)+word(BigInt(bytes.length))+bytes.toString("hex").padEnd(64,"0");}
function fixture(network:"base-sepolia"|"base"="base") {
  const requests:Array<{url:string;body:{id:number;method:string;params:unknown[]};init:RequestInit}>=[];
  let mutate:(value:Record<string,unknown>,request:(typeof requests)[number])=>unknown=value=>value;
  const dependencies:PythChainPreflightDependencies={now:()=>NOW,fetch:(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const body=JSON.parse(String(init!.body)),request={url:String(input),body,init:init!};requests.push(request);
    let result:unknown;
    if(body.method==="eth_chainId")result="0x"+PYTH_PREFLIGHT_NETWORKS[network].chainId.toString(16);
    else if(body.method==="eth_getBlockByNumber")result=header();
    else if(body.method==="eth_getCode")result="0x60006000f3";
    else if(body.method==="eth_call")result=body.params[0].data===PYTH_PREFLIGHT_SELECTORS.version?version():"0x"+word(1n);
    else throw new Error("Unexpected isolated method");
    const output=mutate({jsonrpc:"2.0",id:body.id,result},request);
    return output instanceof Response?output:new Response(JSON.stringify(output),{headers:{"content-type":"application/json"}});
  }) as typeof fetch};
  return {requests,dependencies,mutate:(value:typeof mutate)=>{mutate=value;}};
}

for(const network of ["base-sepolia","base"] as const)test(`${network} deployment preflight pins the same sealed hash and makes only reviewed reads`,async()=>{
  const f=fixture(network),report=await preflightPythBase({network},f.dependencies);
  expect(report.status).toBe("DEPLOYMENT_PREFLIGHT_PASSED");expect(report.chainId).toBe(PYTH_PREFLIGHT_NETWORKS[network].chainId);expect(report.version).toBe("0.1.1");expect(report.verificationFeeWei).toBe("1");
  expect(report.block).toEqual({...header(),selection:"LATEST_SEALED",canonicalHashRechecked:true});expect(report.runtimeCodeBytes).toBe(5);expect(report.runtimeCodeSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(f.requests.map(request=>request.body.method)).toEqual(["eth_chainId","eth_getBlockByNumber","eth_getCode","eth_call","eth_call","eth_getBlockByNumber","eth_chainId"]);
  for(const request of f.requests) {
    expect(request.url).toBe(PYTH_PREFLIGHT_NETWORKS[network].rpc);expect(request.init.redirect).toBe("error");expect(new Headers(request.init.headers).has("authorization")).toBe(false);
    expect(request.body).not.toHaveProperty("privateKey");expect(request.body.method).not.toContain("send");
  }
  expect(f.requests[1]!.body.params).toEqual(["latest",false]);
  expect(f.requests[2]!.body.params).toEqual([PYTH_BASE_VERIFIER,{blockHash:HASH,requireCanonical:true}]);
  for(const index of [3,4])expect(f.requests[index]!.body.params[1]).toEqual({blockHash:HASH,requireCanonical:true});
  expect(f.requests[3]!.body.params[0]).toEqual({to:PYTH_BASE_VERIFIER,data:"0x54fd4d50"});expect(f.requests[4]!.body.params[0]).toEqual({to:PYTH_BASE_VERIFIER,data:"0xbac12f87"});
  expect(f.requests[5]!.body.params).toEqual(["0x1234",false]);
  for(const field of ["implementationAttestation","finalityVerification","signedPayloadVerification","priceVerification","transactionSubmission"] as const)expect(report[field]).toBe("NOT_PERFORMED");
  expect(report.oracleHealth).toBe("NOT_ASSESSED");expect(report.observationAuthority).toBe("SINGLE_PUBLIC_RPC");
});

test("default network is Base Sepolia; other networks and endpoint arguments are rejected without requests",async()=>{
  const f=fixture("base-sepolia");expect((await preflightPythBase({},f.dependencies)).chainId).toBe(84532);
  const other=fixture();expect((await preflightPythBase({network:"other" as "base"},other.dependencies)).code).toBe("NETWORK_NOT_REVIEWED");
  expect((await runPythChainPreflightCli(["--rpc",`https://example.invalid/${PRIVATE}`],other.dependencies)).report.code).toBe("ARGUMENTS_INVALID");expect(other.requests).toHaveLength(0);
});

for(const change of ["initial-chain","final-chain","hash","height","time"] as const)test(`preflight rejects changed ${change} instead of mixing chain states`,async()=>{
  const f=fixture();f.mutate((value,request)=>{
    if(change==="initial-chain"&&request.body.id===1||change==="final-chain"&&request.body.id===7)value.result="0x1";
    if(request.body.id===6) {
      const replacement={...header()};if(change==="hash")replacement.hash="0x"+"b".repeat(64);if(change==="height")replacement.number="0x1235";if(change==="time")replacement.timestamp="0x"+(Math.floor(NOW/1000)-1).toString(16);
      value.result=replacement;
    }
    return value;
  });
  const report=await preflightPythBase({network:"base"},f.dependencies);expect(report.status).toBe("BLOCKED");expect(report.code).toBe(change.endsWith("chain")?"CHAIN_ID_MISMATCH":"PINNED_BLOCK_CHANGED");expect(report.block).toBeUndefined();
});

for(const change of ["pending","stale","future","empty-code","zero-code","new-version","fee-width"] as const)test(`preflight refuses ${change} deployment data`,async()=>{
  const f=fixture();f.mutate((value,request)=>{
    if(request.body.id===2) {
      if(change==="pending")value.result={...header(),hash:null,number:null};
      if(change==="stale")value.result={...header(),timestamp:"0x"+(Math.floor(NOW/1000)-121).toString(16)};
      if(change==="future")value.result={...header(),timestamp:"0x"+(Math.floor(NOW/1000)+6).toString(16)};
    }
    if(request.body.id===3&&change==="empty-code")value.result="0x";
    if(request.body.id===3&&change==="zero-code")value.result="0x0000";
    if(request.body.id===4&&change==="new-version")value.result=version("0.2.0");
    if(request.body.id===5&&change==="fee-width")value.result="0x01";
    return value;
  });
  const report=await preflightPythBase({network:"base"},f.dependencies);expect(report.status).toBe("BLOCKED");expect(report.version).toBeUndefined();
});

for(const change of ["offset","length","padding","trailing","high-bit"] as const)test(`version ABI ${change} cannot pass the reviewed version pin`,async()=>{
  const f=fixture();f.mutate((value,request)=>{
    if(request.body.id===4) {
      const bytes=Buffer.from(version().slice(2),"hex");
      if(change==="offset")bytes[31]=64;
      if(change==="length")bytes[63]=33;
      if(change==="padding")bytes[95]=1;
      if(change==="high-bit")for(let index=64;index<69;index++)bytes[index]=bytes[index]!|0x80;
      value.result="0x"+bytes.toString("hex")+(change==="trailing"?"00":"");
    }
    return value;
  });
  expect((await preflightPythBase({network:"base"},f.dependencies)).code).toBe("VERSION_ABI_INVALID");
});

test("verification fee remains an exact uint256 string and is not total transaction cost",async()=>{
  const f=fixture();f.mutate((value,request)=>{if(request.body.id===5)value.result="0x"+"f".repeat(64);return value;});
  const report=await preflightPythBase({network:"base"},f.dependencies);expect(report.status).toBe("DEPLOYMENT_PREFLIGHT_PASSED");expect(report.verificationFeeWei).toBe(((1n<<256n)-1n).toString());expect(report.transactionSubmission).toBe("NOT_PERFORMED");
});

for(const change of ["id","version","both","extra","array","error"] as const)test(`strict JSON-RPC rejects ${change} envelopes without exposing diagnostics`,async()=>{
  const f=fixture();f.mutate(value=>{
    if(change==="id")value.id="1";if(change==="version")value.jsonrpc="1.0";if(change==="both")value.error={message:PRIVATE};if(change==="extra")value.secret=PRIVATE;
    if(change==="array")return [value];if(change==="error"){delete value.result;value.error={code:-32602,message:PRIVATE};}return value;
  });
  const report=await preflightPythBase({network:"base"},f.dependencies);expect(report.status).toBe("BLOCKED");expect(JSON.stringify(report)).not.toContain(PRIVATE);expect(f.requests).toHaveLength(1);
});

test("bounded response reads reject declared and streaming oversize data",async()=>{
  for(const declared of [true,false]) {
    const f=fixture();f.mutate(()=>new Response(new Uint8Array(PYTH_PREFLIGHT_LIMITS.responseBytes+1),{headers:{"content-type":"application/json",...(declared?{"content-length":String(PYTH_PREFLIGHT_LIMITS.responseBytes+1)}:{})}}));
    expect((await preflightPythBase({network:"base"},f.dependencies)).code).toBe("RPC_RESPONSE_TOO_LARGE");
  }
});

test("HTTP, malformed JSON and unexpected fetch exceptions remain sanitized",async()=>{
  for(const kind of ["http","json","content-type","network"] as const) {
    const f=fixture();f.mutate(()=>kind==="http"?new Response(PRIVATE,{status:429}):new Response(PRIVATE,{headers:{"content-type":kind==="content-type"?"text/html":"application/json"}}));
    if(kind==="network")f.dependencies.fetch=(async()=>{throw new Error(PRIVATE);}) as unknown as typeof fetch;
    const result=await preflightPythBase({network:"base"},f.dependencies);expect(result.status).toBe("BLOCKED");expect(JSON.stringify(result)).not.toContain(PRIVATE);
  }
});

test("noncooperative fetch and body readers cannot defeat bounded cancellation",async()=>{
  const f=fixture();f.dependencies.fetch=(()=>new Promise(()=>{})) as unknown as typeof fetch;f.dependencies.requestTimeoutMs=10;
  expect((await preflightPythBase({network:"base"},f.dependencies)).code).toBe("REQUEST_TIMEOUT");
  const stream=fixture();stream.dependencies.requestTimeoutMs=10;stream.mutate(()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});}}),{headers:{"content-type":"application/json"}}));
  expect((await preflightPythBase({network:"base"},stream.dependencies)).code).toBe("REQUEST_TIMEOUT");
  const controller=new AbortController(),stopped=fixture();stopped.dependencies.fetch=f.dependencies.fetch;
  const pending=preflightPythBase({network:"base",signal:controller.signal},stopped.dependencies);controller.abort();
  expect((await pending).status).toBe("ABORTED");
});

test("real CLI rejects a secret-bearing option without requests or value echo",async()=>{
  const child=Bun.spawn([process.execPath,resolve(import.meta.dir,"../src/pyth/chain-preflight.ts"),"--rpc",PRIVATE],{env:{},stdout:"pipe",stderr:"pipe"});
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(code).toBe(1);expect(JSON.parse(stdout).code).toBe("ARGUMENTS_INVALID");expect(stdout+stderr).not.toContain(PRIVATE);
},10000);
