/** Node.js private Fetcher client. One bounded response at a time; Bun verifies/encrypts before archival completion. */
import { getPlatformProxy } from "wrangler";
import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root=fileURLToPath(new URL("../",import.meta.url)),MAX_FRAME=512*1024;
// TypeScript and this Node-only entry point share a tested exact diagnostic allowlist.
export const HOSTED_STREAM_OPERATOR_ERRORS=Object.freeze([
  "COLLECTION_RUNNING_RETRY_EXPORT","ARCHIVE_RELEASE_REQUIRED","ARCHIVE_CHECKPOINT_ALREADY_ACTIVE","ARCHIVE_CHECKPOINT_NOT_FOUND",
  "ARCHIVE_CHECKPOINT_EXPIRED","ARCHIVE_CHECKPOINT_NOT_COMPLETE","ARCHIVE_CHECKPOINT_INCOMPLETE","ARCHIVE_CHECKPOINT_STAGING_CAPACITY",
  "ARCHIVE_FROZEN_CAPACITY","ARCHIVE_SOURCE_MISMATCH","ARCHIVE_MEMBERSHIP_INCOMPLETE","ARCHIVE_SCHEMA_REVIEW_REQUIRED",
  "ARCHIVE_MEMBERSHIP_VERSION_UNSUPPORTED","ARCHIVE_RECORD_TOO_LARGE","ARCHIVE_CONFIGURATION_MISSING","ARCHIVE_CLOCK_ROLLBACK",
  "ARCHIVE_BLOCK_ORDER_MISMATCH","ARCHIVE_BLOCK_METADATA_MISSING","ARCHIVE_IMMUTABLE_DATA_CHANGED","ARCHIVE_CHECKPOINT_CAPACITY",
]);
const operatorErrors=new Set(HOSTED_STREAM_OPERATOR_ERRORS);
let proxy,child,childExit,terminating=false,values;
const bounded=(operation,ms)=>Promise.race([operation,new Promise(resolveWait=>{const timer=setTimeout(resolveWait,ms);timer.unref();})]);
export function parseHostedStreamArguments(args=process.argv.slice(2)) {
  try{return parseArgs({args,options:{node:{type:"string"},"expected-node-id":{type:"string"},"expected-release":{type:"string"},"key-file":{type:"string"},output:{type:"string"},"max-archive-bytes":{type:"string"},help:{type:"boolean"}}}).values;}
  catch {throw new Error("INVALID_HOSTED_STREAM_ARGUMENTS");}
}
function absent(path){try{lstatSync(path);return false;}catch(error){if(error?.code==="ENOENT")return true;throw error;}}
/** A deadline owns the complete response, including bridges that ignore fetch cancellation. */
export async function readHostedStreamResponse(fetchResponse,{deadlineMs=30_000,maxFrameBytes=MAX_FRAME}={}) {
  const controller=new AbortController();let response,reader,timer;
  const cancel=()=>{try{void Promise.resolve(reader?reader.cancel():response?.body?.cancel()).catch(()=>{});}catch{/* The original failure is authoritative. */}};
  const operation=(async()=>{
    response=await fetchResponse(controller.signal);
    if(controller.signal.aborted){cancel();throw new Error("HOSTED_STREAM_RESPONSE_DEADLINE");}
    const failed=!response.ok,contentType=response.headers.get("content-type")?.split(";")[0]?.trim();
    if(!response.body||contentType!==(failed?"application/json":"application/vnd.sbx.checkpoint+json"))throw new Error("HOSTED_STREAM_RESPONSE_INVALID");
    reader=response.body.getReader();const parts=[];let bytes=0;
    for(;;) {
      const part=await reader.read();
      if(controller.signal.aborted)throw new Error("HOSTED_STREAM_RESPONSE_DEADLINE");
      if(part.done)break;
      bytes+=part.value.byteLength;if(bytes>(failed?1024:maxFrameBytes))throw new Error("HOSTED_STREAM_RESPONSE_TOO_LARGE");parts.push(Buffer.from(part.value));
    }
    const encoded=Buffer.concat(parts);let value;
    try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(encoded));}catch{throw new Error("HOSTED_STREAM_RESPONSE_INVALID");}
    if(failed) {
      const known=response.status===409&&value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).length===1&&operatorErrors.has(value.error);
      throw new Error(known?value.error:"HOSTED_STREAM_RESPONSE_INVALID");
    }
    return {encoded,value};
  })();
  try {
    return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();cancel();reject(new Error("HOSTED_STREAM_RESPONSE_DEADLINE"));},deadlineMs);})]);
  } finally {clearTimeout(timer);cancel();try{reader?.releaseLock();}catch{/* A noncooperating bridge can still own a pending read. */}}
}
async function requestOnce(path) {
  return readHostedStreamResponse(signal=>proxy.env.RECOVERY.fetch(`https://recovery.internal/archive/${values.node}/${path}`,{method:"POST",signal}));
}
async function request(path) {
  const attempts=/\/(block\/[0-9]+|seal)$/.test(path)?3:1;
  for(let attempt=0;attempt<attempts;attempt++) {
    try{return await requestOnce(path);}
    catch(error){if(operatorErrors.has(error?.message)||attempt+1===attempts)throw error;await new Promise(resolveWait=>setTimeout(resolveWait,250*(attempt+1)));}
  }
  throw new Error("HOSTED_STREAM_RETRY_EXHAUSTED");
}
function startChild(command,args) {
  child=spawn("bun",[resolve(root,"src/cli.ts"),command,...args],{cwd:root,stdio:["pipe","inherit","inherit"]});
  child.stdin.on("error",()=>{});
  childExit=new Promise((resolveExit,reject)=>{child.on("error",reject);child.on("exit",code=>resolveExit(code));});
  childExit.catch(()=>{});return child;
}
/** Backpressure waits install and remove their own listeners; no per-frame promise accumulation. */
export async function writeHostedStreamFrame(writer,bytes) {
  if(writer.exitCode!==null||writer.signalCode!==null||!writer.stdin||writer.stdin.destroyed)throw new Error("HOSTED_STREAM_LOCAL_WRITER_FAILED");
  await new Promise((resolveWrite,reject)=>{
    const clean=()=>{writer.off("exit",failed);writer.off("error",failed);writer.stdin.off("error",failed);writer.stdin.off("close",failed);writer.stdin.off("drain",drained);};
    const failed=()=>{clean();reject(new Error("HOSTED_STREAM_LOCAL_WRITER_FAILED"));};
    const drained=()=>{clean();resolveWrite();};
    writer.once("exit",failed);writer.once("error",failed);writer.stdin.once("error",failed);writer.stdin.once("close",failed);writer.stdin.once("drain",drained);
    try{if(writer.stdin.write(Buffer.concat([bytes,Buffer.from("\n")])))drained();}catch{failed();}
  });
}
async function main() {
  values=parseHostedStreamArguments();
  if(values.help){console.log("node scripts/export-hosted-stream.mjs --node primary|secondary --expected-node-id NODE_ID --expected-release SHA --key-file PRIVATE_KEY --output NEW_ARCHIVE [--max-archive-bytes N]\nRequires authorized Wrangler login, Node.js and Bun. Private service binding only. Produces encrypted V2 archive, inspects all retained history and releases sealed checkpoint staging. No source records are deleted.");return;}
  if(!["primary","secondary"].includes(values.node)||!/^[a-f0-9]{64}$/.test(values["expected-node-id"]??"")||!/^[a-f0-9]{40}$/.test(values["expected-release"]??"")||!values["key-file"]||!values.output)throw new Error("INVALID_HOSTED_STREAM_ARGUMENTS");
  if(values["max-archive-bytes"]!==undefined&&(!/^[1-9][0-9]{0,15}$/.test(values["max-archive-bytes"])||!Number.isSafeInteger(Number(values["max-archive-bytes"]))))throw new Error("INVALID_HOSTED_STREAM_BUDGET");
  const key=resolve(values["key-file"]),output=resolve(values.output),stat=lstatSync(key);
  if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>100||!absent(output)||!absent(`${output}.partial`))throw new Error("HOSTED_STREAM_REQUIRES_PRIVATE_KEY_AND_NEW_OUTPUT");
  const args=["--expected-node-id",values["expected-node-id"],"--expected-release",values["expected-release"],"--key-file",key,
    ...(values["max-archive-bytes"]?["--max-archive-bytes",values["max-archive-bytes"]]:[])];
  proxy=await getPlatformProxy({configPath:resolve(root,"config/hosted-recovery.wrangler.jsonc"),persist:false,remoteBindings:true});
  const descriptor=await request("begin"),checkpoint=descriptor.value?.payload?.checkpointId;
  if(typeof checkpoint!=="string"||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(checkpoint))throw new Error("HOSTED_STREAM_DESCRIPTOR_INVALID");
  const writer=startChild("import-stream-backup",[...args,"--output",output]);
  const send=bytes=>writeHostedStreamFrame(writer,bytes);
  await send(descriptor.encoded);
  for(let index=0;index<10_000_000;index++) {
    const block=await request(`${checkpoint}/block/${index}`);
    if(block.value===null)break;
    await send(block.encoded);
    if(index===9_999_999)throw new Error("HOSTED_STREAM_BLOCK_BUDGET");
  }
  await send((await request(`${checkpoint}/seal`)).encoded);writer.stdin.end();
  if(await childExit!==0)throw new Error("HOSTED_STREAM_SOURCE_VERIFICATION_FAILED");
  startChild("backup-stream-inspect",[...args,"--input",output]).stdin.end();
  if(await childExit!==0)throw new Error("HOSTED_STREAM_CONTENT_VERIFICATION_FAILED");
  await request(`${checkpoint}/complete`);
  console.log(JSON.stringify({status:"VERIFIED_ENCRYPTED_ARCHIVE",checkpointId:checkpoint,sourceRecordsDeleted:false,checkpointStagingReleased:true}));
}
async function terminate(code) {
  if(terminating)return;terminating=true;console.error(code);child?.kill("SIGTERM");
  if(childExit)await bounded(childExit.catch(()=>{}),5000);
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");
  if(proxy)await bounded(proxy.dispose().catch(()=>{}),5000);process.exit(1);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const deadline=setTimeout(()=>void terminate("HOSTED_STREAM_DEADLINE_EXCEEDED"),55*60*1000);
  process.once("SIGINT",()=>void terminate("HOSTED_STREAM_INTERRUPTED"));process.once("SIGTERM",()=>void terminate("HOSTED_STREAM_INTERRUPTED"));
  main().catch(error=>terminate(operatorErrors.has(error?.message)?error.message:"HOSTED_STREAM_FAILED_NO_RAW_DATA_PRINTED")).finally(async()=>{clearTimeout(deadline);if(proxy)await bounded(proxy.dispose(),5000);});
}
