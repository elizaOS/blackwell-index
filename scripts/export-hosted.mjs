/** Node.js is required by Wrangler's getPlatformProxy. No public HTTP export route. */
import { getPlatformProxy } from "wrangler";
import { spawn } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root=fileURLToPath(new URL("../",import.meta.url)),MAX_BYTES=8*1024*1024;
let activeProxy,activeChild,childExit,terminating=false;
const bounded=(operation,milliseconds)=>Promise.race([operation,new Promise(resolveWait=>{const timer=setTimeout(resolveWait,milliseconds);timer.unref();})]);
const {values}=parseArgs({options:{node:{type:"string"},"expected-node-id":{type:"string"},"expected-release":{type:"string"},"key-file":{type:"string"},output:{type:"string"},help:{type:"boolean"}}});
async function main() {
  if(values.help){console.log("node scripts/export-hosted.mjs --node primary|secondary --expected-node-id NODE_ID --expected-release COMMIT_SHA --key-file PRIVATE_KEY_FILE --output NEW_BUNDLE_FILE\nRequires Node.js, Bun, installed frozen dependencies and authorized Wrangler login. Exports through a private remote service binding; no public HTTP backup endpoint or provider credentials.");return;}
  if(!["primary","secondary"].includes(values.node)||!/^[a-f0-9]{64}$/.test(values["expected-node-id"]??"")||!/^[a-f0-9]{40}$/.test(values["expected-release"]??"")||!values["key-file"]||!values.output)throw new Error("INVALID_HOSTED_EXPORT_ARGUMENTS");
  const key=resolve(values["key-file"]),output=resolve(values.output),stat=lstatSync(key);
  if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>100||existsSync(output))throw new Error("HOSTED_EXPORT_REQUIRES_PRIVATE_KEY_AND_NEW_OUTPUT");
  const proxy=await getPlatformProxy({configPath:resolve(root,"config/hosted-recovery.wrangler.jsonc"),persist:false,remoteBindings:true});
  activeProxy=proxy;
  try {
    const response=await proxy.env.RECOVERY.fetch(`https://recovery.internal/export/${values.node}`,{method:"POST"});
    if(!response.ok||!response.headers.get("content-type")?.includes("application/vnd.sbx.hosted-journal+json"))throw new Error("HOSTED_EXPORT_RESPONSE_INVALID");
    const parts=[];let bytes=0;
    for await(const part of response.body){bytes+=part.byteLength;if(bytes>MAX_BYTES)throw new Error("HOSTED_EXPORT_TOO_LARGE");parts.push(Buffer.from(part));}
    const child=spawn("bun",[resolve(root,"src/cli.ts"),"import-hosted-backup","--expected-node-id",values["expected-node-id"],"--expected-release",values["expected-release"],"--key-file",key,"--output",output],{cwd:root,stdio:["pipe","inherit","inherit"]});
    activeChild=child;
    const exited=new Promise((resolveExit,reject)=>{child.on("error",reject);child.on("exit",code=>resolveExit(code));});
    childExit=exited;
    child.stdin.on("error",()=>{});child.stdin.end(Buffer.concat(parts));
    if(await exited!==0)throw new Error("HOSTED_EXPORT_LOCAL_VERIFICATION_FAILED");
  } finally {await bounded(proxy.dispose(),5000);activeProxy=undefined;activeChild=undefined;childExit=undefined;}
}
async function terminate(message){
  if(terminating)return;terminating=true;
  console.error(message);
  activeChild?.kill("SIGTERM");
  if(childExit)await bounded(childExit.catch(()=>{}),5000);
  if(activeChild&&activeChild.exitCode===null&&activeChild.signalCode===null)activeChild.kill("SIGKILL");
  try{if(activeProxy)await bounded(activeProxy.dispose(),5000);}finally{process.exit(1);}
}
const deadline=setTimeout(()=>void terminate("HOSTED_EXPORT_DEADLINE_EXCEEDED"),120_000);
process.once("SIGINT",()=>void terminate("HOSTED_EXPORT_INTERRUPTED"));process.once("SIGTERM",()=>void terminate("HOSTED_EXPORT_INTERRUPTED"));
main().catch(error=>{const message=error instanceof Error?error.message:"";console.error(/^[A-Z][A-Z0-9_]+$/.test(message)?message:"Hosted export failed. Check authorized Wrangler access and the expected deployed identity; no raw response was printed.");process.exitCode=1;}).finally(()=>clearTimeout(deadline));
