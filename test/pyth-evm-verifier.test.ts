import {expect,test} from 'bun:test';
import {verifyPythEvmUpdate} from '../src/pyth/evm-verifier';
import {PYTH_BASE_VERIFIER} from '../src/pyth/chain-preflight';
// Isolated fake signatures/RPC replies; these tests prove control flow, not cryptography.
const NOW=1788734337000,HASH='0x'+'a'.repeat(64),word=(n:bigint)=>n.toString(16).padStart(64,'0');
const time=BigInt(NOW)*1000n;
const body='93c7d375'+time.toString(16).padStart(16,'0')+'0401'+'00000001'+'05'+'00'+word(1000n).slice(-16)+'03'+'0003'+'04'+'fffa'+'05'+word(2n).slice(-16)+'0c01'+time.toString(16).padStart(16,'0');
const envelope='0x2a22999a'+'01'.repeat(64)+'01'+(body.length/2).toString(16).padStart(4,'0')+body;
const returned='0x'+word(64n)+'0'.repeat(24)+'01'.repeat(20)+word(BigInt(body.length/2))+body.padEnd(Math.ceil(body.length/64)*64,'0');
function fixture(fault='') {
 const calls:any[]=[];
 const dependencies={now:()=>NOW,fetch:(async(_url:unknown,init:RequestInit)=>{
  const q=JSON.parse(String(init.body));calls.push(q);let result:unknown;
  if(q.method==='eth_chainId')result=fault==='chain'&&q.id>100?'0x1':'0x2105';
  else if(q.method==='eth_getBlockByNumber')result={number:'0x123',hash:fault==='reorg'&&q.id>100?'0x'+'b'.repeat(64):HASH,timestamp:'0x'+Math.floor(NOW/1000).toString(16)};
  else if(q.method==='eth_getCode')result='0x6000';
  else if(q.method==='eth_getBalance')result=fault==='balance'?'0x0':'0x10';
  else if(q.method==='eth_call') {
   if(q.params[0].data==='0x54fd4d50')result='0x'+word(32n)+word(5n)+Buffer.from('0.1.1').toString('hex').padEnd(64,'0');
   else if(q.params[0].data==='0xbac12f87')result='0x'+word(fault==='fee'?2n:1n);
   else if(fault==='stall')return await new Promise<Response>(()=>{});
   else if(fault==='oversize')return new Response('x',{headers:{'Content-Type':'application/json','Content-Length':'1048577'}});
   else if(fault==='reject')return Response.json({jsonrpc:'2.0',id:q.id,error:{code:3,message:'private upstream details'}});
   else result=fault==='payload'?'0x':returned;
  } else throw Error('unexpected');
  return Response.json({jsonrpc:'2.0',id:q.id,result});
 }) as typeof fetch};return {calls,dependencies};
}
const options={update:envelope,network:'base' as const,simulationFrom:PYTH_BASE_VERIFIER};
test('contract verification makes only pinned reads and preserves its trust boundary',async()=>{
 const f=fixture(),r=await verifyPythEvmUpdate(options,f.dependencies);
 expect(r.status).toBe('CONTRACT_ACCEPTED');expect(r.payloadHex).toBe('0x'+body);
 expect(r.sbxPolicyVerification).toBe('NOT_PERFORMED');expect(r.transactionSubmission).toBe('NOT_PERFORMED');
 expect(f.calls).toHaveLength(11);
 expect(f.calls[8].params[1]).toEqual({blockHash:HASH,requireCanonical:true});
 expect(f.calls.every(q=>!q.method.startsWith('eth_send'))).toBe(true);
 expect(f.calls[8].params).toHaveLength(2);
});
for(const [fault,code] of [['balance','SIMULATION_BALANCE_INSUFFICIENT'],['fee','VERIFICATION_FEE_REVIEW_REQUIRED'],['reorg','PINNED_BLOCK_CHANGED'],['chain','CHAIN_ID_MISMATCH'],['oversize','RPC_RESPONSE_TOO_LARGE'],['reject','RPC_METHOD_REJECTED'],['payload','RESULT_ABI_INVALID']] as const) test(`fails closed on ${fault}`,async()=>{
 const f=fixture(fault),r=await verifyPythEvmUpdate(options,f.dependencies);
 expect(r.status).toBe('BLOCKED');expect(r.code).toBe(code);
 expect(r.payloadHex).toBeUndefined();expect(JSON.stringify(r)).not.toContain('private upstream details');
});

test('a noncooperative verification RPC cannot defeat the request deadline',async()=>{
 const f=fixture('stall'),r=await verifyPythEvmUpdate(options,{...f.dependencies,requestTimeoutMs:10});
 expect(r.status).toBe('BLOCKED');expect(r.code).toBe('REQUEST_TIMEOUT');expect(r.payloadHex).toBeUndefined();
});

test('cancellation during the verification call returns no accepted payload',async()=>{
 const f=fixture('stall'),controller=new AbortController();
 const request=f.dependencies.fetch;
 const dependencies={...f.dependencies,fetch:(async(...args:Parameters<typeof fetch>)=>{
  const q=JSON.parse(String(args[1]?.body));
  if(q.id===102)setTimeout(()=>controller.abort(),1);
  return request(...args);
 }) as typeof fetch};
 const r=await verifyPythEvmUpdate({...options,signal:controller.signal},dependencies);
 expect(r.status).toBe('ABORTED');expect(r.code).toBe('ABORTED');expect(r.payloadHex).toBeUndefined();
});
test('invalid inputs and pre-aborted callers make no requests',async()=>{
 for(const change of [{update:'bad'},{simulationFrom:'0x0'},{signal:AbortSignal.abort()}]) {
  const f=fixture(),r=await verifyPythEvmUpdate({...options,...change},f.dependencies);
  expect(r.status).not.toBe('CONTRACT_ACCEPTED');expect(f.calls).toHaveLength(0);
 }
});
