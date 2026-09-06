// No Cloudflare account, deployed endpoint, provider data or real recovery key is used.
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ARCHIVE_OPERATOR_ERRORS } from "../src/archive-protocol";
const moduleUrl=new URL("../scripts/export-hosted-stream.mjs",import.meta.url).href;
const helper=await import(moduleUrl) as {
  HOSTED_STREAM_OPERATOR_ERRORS:readonly string[];
  parseHostedStreamArguments(args:string[]):Record<string,unknown>;
  readHostedStreamResponse(fetcher:(signal:AbortSignal)=>Promise<Response>,options?:{deadlineMs?:number;maxFrameBytes?:number}):Promise<{encoded:Buffer;value:unknown}>;
  writeHostedStreamFrame(writer:EventEmitter&{exitCode:number|null;signalCode:string|null;stdin:EventEmitter&{destroyed:boolean;write:(bytes:Buffer)=>boolean}},bytes:Uint8Array):Promise<void>;
};
const contentType="application/vnd.sbx.checkpoint+json";
test("argument parsing never echoes untrusted option names or values",()=>{
  const marker="ISOLATED_TEST_SECRET_ARGUMENT_MARKER";
  expect(()=>helper.parseHostedStreamArguments([`--${marker}`])).toThrow("INVALID_HOSTED_STREAM_ARGUMENTS");
  try{helper.parseHostedStreamArguments([marker]);}catch(error){expect(String(error)).not.toContain(marker);}
  expect(helper.parseHostedStreamArguments(["--help"]).help).toBe(true);
});
test("CLI argument failures print only a sanitized code before any account operation",async()=>{
  const marker="ISOLATED_TEST_SECRET_ARGUMENT_MARKER",process=spawn("node",[resolve(import.meta.dir,"../scripts/export-hosted-stream.mjs"),`--${marker}`],{stdio:["ignore","pipe","pipe"]});
  const stderr:Buffer[]=[],stdout:Buffer[]=[];process.stderr.on("data",bytes=>stderr.push(bytes));process.stdout.on("data",bytes=>stdout.push(bytes));
  const exit=await new Promise<number|null>((resolveExit,reject)=>{process.once("error",reject);process.once("exit",resolveExit);});
  expect(exit).toBe(1);expect(Buffer.concat(stderr).toString()).toContain("HOSTED_STREAM_FAILED_NO_RAW_DATA_PRINTED");
  expect(Buffer.concat(stderr).toString()).not.toContain(marker);expect(Buffer.concat(stdout).toString()).not.toContain(marker);
},30000);
test("response deadline covers a stalled body and actively cancels it",async()=>{
  let cancelled=false;
  const response=new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(Buffer.from("{"));},cancel(){cancelled=true;}}),{headers:{"content-type":contentType}});
  await expect(helper.readHostedStreamResponse(async()=>response,{deadlineMs:10})).rejects.toThrow("HOSTED_STREAM_RESPONSE_DEADLINE");
  expect(cancelled).toBe(true);
});
test("response deadline also bounds a bridge that ignores fetch abort",async()=>{
  let observed:AbortSignal|undefined;
  await expect(helper.readHostedStreamResponse(signal=>{observed=signal;return new Promise(()=>{});},{deadlineMs:10})).rejects.toThrow("HOSTED_STREAM_RESPONSE_DEADLINE");
  expect(observed?.aborted).toBe(true);
});
test("response byte limit, content type and UTF-8 reject before returning payload",async()=>{
  let cancelled=false;
  const oversized=new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(Buffer.alloc(33));},cancel(){cancelled=true;}}),{headers:{"content-type":contentType}});
  await expect(helper.readHostedStreamResponse(async()=>oversized,{maxFrameBytes:32})).rejects.toThrow("HOSTED_STREAM_RESPONSE_TOO_LARGE");expect(cancelled).toBe(true);
  await expect(helper.readHostedStreamResponse(async()=>new Response("{}"))).rejects.toThrow("HOSTED_STREAM_RESPONSE_INVALID");
  await expect(helper.readHostedStreamResponse(async()=>new Response(new Uint8Array([255]),{headers:{"content-type":contentType}}))).rejects.toThrow();
  const good=await helper.readHostedStreamResponse(async()=>new Response('{"test":true}',{headers:{"content-type":contentType}}));expect(good.value).toEqual({test:true});
});
test("private error diagnostics use the exact server allowlist and bound rejected bodies to 1024 bytes",async()=>{
  expect(helper.HOSTED_STREAM_OPERATOR_ERRORS).toEqual(ARCHIVE_OPERATOR_ERRORS);
  for(const code of ARCHIVE_OPERATOR_ERRORS)await expect(helper.readHostedStreamResponse(async()=>new Response(JSON.stringify({error:code}),{status:409,headers:{"content-type":"application/json"}}))).rejects.toThrow(code);
  const marker="ISOLATED_TEST_RAW_PROVIDER_SECRET_MARKER";
  for(const payload of [JSON.stringify({error:marker}),JSON.stringify({error:"ARCHIVE_CHECKPOINT_EXPIRED",raw:marker}),JSON.stringify({error:marker.repeat(100)}),`not json ${marker}`]) {
    let failure="";try{await helper.readHostedStreamResponse(async()=>new Response(payload,{status:409,headers:{"content-type":"application/json"}}));}catch(error){failure=String(error);}
    expect(failure).toMatch(/HOSTED_STREAM_RESPONSE_(INVALID|TOO_LARGE)/);expect(failure).not.toContain(marker);
  }
});
function writer() {
  const stdin=Object.assign(new EventEmitter(),{destroyed:false,write:(_bytes:Buffer)=>{queueMicrotask(()=>stdin.emit("drain"));return false;}});
  return Object.assign(new EventEmitter(),{exitCode:null as number|null,signalCode:null as string|null,stdin});
}
test("repeated backpressure drains retain no child/stream listeners",async()=>{
  const child=writer();
  for(let index=0;index<1000;index++)await helper.writeHostedStreamFrame(child,Buffer.from("{}"));
  expect(child.eventNames()).toEqual([]);expect(child.stdin.eventNames()).toEqual([]);
});
test("writer exit, stream error, close, and synchronous write failure clean every wait listener",async()=>{
  for(const event of ["exit","error","close","throw"] as const) {
    const child=writer();child.stdin.write=()=>{if(event==="throw")throw new Error("isolated failure");queueMicrotask(()=>event==="exit"?child.emit("exit",1):child.stdin.emit(event,...(event==="error"?[new Error("isolated failure")]:[])));return false;};
    await expect(helper.writeHostedStreamFrame(child,Buffer.from("{}"))).rejects.toThrow("HOSTED_STREAM_LOCAL_WRITER_FAILED");
    expect(child.eventNames()).toEqual([]);expect(child.stdin.eventNames()).toEqual([]);
  }
});
