/** Read-only contract verification. Does not establish SBX assignments or publish a price. */
import {preflightPythBase,pythReadOnlyRpc,PYTH_BASE_VERIFIER,type PythChainPreflightDependencies} from './chain-preflight';
import {decodePythEvmEnvelope,decodePythVerifyUpdateResult,decodeSbxEvmPayload,encodePythVerifyUpdateCall} from './evm-codec';

export interface PythEvmVerificationOptions {
  update:unknown;
  network:'base'|'base-sepolia';
  /** Explicit simulation sender only; no wallet authority or transaction is implied. */
  simulationFrom:string;
  signal?:AbortSignal;
}
export interface PythEvmVerificationReport {
  status:'CONTRACT_ACCEPTED'|'BLOCKED'|'ABORTED';
  code?:string;
  blockHash?:string;
  signer?:string;
  payloadHex?:string;
  observationAuthority:'SINGLE_PUBLIC_RPC';
  transactionSubmission:'NOT_PERFORMED';
  sbxPolicyVerification:'NOT_PERFORMED';
  implementationAttestation:'NOT_PERFORMED';
}
const fail=(code:string):never=>{throw new Error(code);};
const quantity=(value:unknown):bigint=>{
  if(typeof value!=='string'||!/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(value))fail('RPC_QUANTITY_INVALID');
  return BigInt(value as string);
};

/** Fixed chain endpoints, bounded transport, canonical-block calls, no state overrides.
 * Returned bytes require a separate assignment, freshness, quorum and economic-policy
 * check before any consumer uses them. A successful RPC is not independent consensus.
 */
export async function verifyPythEvmUpdate(options:PythEvmVerificationOptions,dependencies:PythChainPreflightDependencies={}):Promise<PythEvmVerificationReport> {
  const base:PythEvmVerificationReport={status:'BLOCKED',observationAuthority:'SINGLE_PUBLIC_RPC',transactionSubmission:'NOT_PERFORMED',sbxPolicyVerification:'NOT_PERFORMED',implementationAttestation:'NOT_PERFORMED'};
  const controller=new AbortController(),abort=()=>controller.abort();
  options.signal?.addEventListener('abort',abort,{once:true});
  let expired=false;const timer=setTimeout(()=>{expired=true;controller.abort();},30000);
  try {
    if(options.signal?.aborted)fail('ABORTED');
    if(typeof options.simulationFrom!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(options.simulationFrom)||/^0x0+$/.test(options.simulationFrom))fail('SIMULATION_SENDER_INVALID');
    const envelope=decodePythEvmEnvelope(options.update);
    // Fail malformed data before any network request. Authentication remains pending.
    decodeSbxEvmPayload(envelope.payloadHex);
    const preflight=await preflightPythBase({network:options.network,signal:controller.signal},dependencies);
    if(preflight.status!=='DEPLOYMENT_PREFLIGHT_PASSED'||!preflight.block)fail(preflight.code??'PREFLIGHT_FAILED');
    const block=preflight.block!;
    const pinned={blockHash:block.hash,requireCanonical:true};let id=100;
    const call=(method:string,params:unknown[])=>pythReadOnlyRpc(preflight.rpc,++id,method,params,dependencies.fetch??fetch,controller.signal,dependencies.requestTimeoutMs??5000);
    const fee=BigInt(preflight.verificationFeeWei!);
    if(fee>1n)fail('VERIFICATION_FEE_REVIEW_REQUIRED');
    if(quantity(await call('eth_getBalance',[options.simulationFrom,pinned]))<fee)fail('SIMULATION_BALANCE_INSUFFICIENT');
    const returned=await call('eth_call',[{from:options.simulationFrom,to:PYTH_BASE_VERIFIER,value:`0x${fee.toString(16)}`,data:encodePythVerifyUpdateCall(envelope.canonicalHex)},pinned]);
    const verified=decodePythVerifyUpdateResult(returned,envelope.canonicalHex);
    const confirmed=await call('eth_getBlockByNumber',[block.number,false]) as Record<string,unknown>|null;
    if(!confirmed||confirmed.hash!==block.hash||confirmed.number!==block.number||confirmed.timestamp!==block.timestamp)fail('PINNED_BLOCK_CHANGED');
    if(quantity(await call('eth_chainId',[]))!==BigInt(preflight.chainId))fail('CHAIN_ID_MISMATCH');
    const now=(dependencies.now??Date.now)();
    if(!Number.isSafeInteger(now)||now<preflight.checkedAt||BigInt(now)-quantity(block.timestamp)*1000n>120000n)fail('BLOCK_CLOCK_INVALID');
    if(controller.signal.aborted)fail('ABORTED');
    return {...base,status:'CONTRACT_ACCEPTED',blockHash:block.hash,signer:verified.signer,payloadHex:verified.payloadHex};
  } catch(error) {
    const code=expired?'TOTAL_DEADLINE_EXCEEDED':options.signal?.aborted?'ABORTED':error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'VERIFICATION_FAILED';
    return {...base,status:options.signal?.aborted?'ABORTED':'BLOCKED',code};
  } finally {clearTimeout(timer);options.signal?.removeEventListener('abort',abort);controller.abort();}
}
