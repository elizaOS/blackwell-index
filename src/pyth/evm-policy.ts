import {decodeSbxEvmPayload} from './evm-codec';
import {validatePythReadbackFeed,type PythReadbackConfig,type PythExpectedPrint,type PythReadbackState} from './readback';
import type {PythFeedBinding} from './index';

/** Pure batch policy, not signature verification or approval validation.
 * The caller must pass only bytes returned by successful contract verification,
 * validated configuration/bindings and journal-reproduced expected prints.
 * No state is mutated or persisted, including when a later feed fails.
 */
export function checkPythEvmBatchPolicy(payloadHex:string,bindings:readonly PythFeedBinding[],config:PythReadbackConfig,now:number,expected:readonly PythExpectedPrint[],previous:Readonly<PythReadbackState['feeds']>=[]) {
  const payload=decodeSbxEvmPayload(payloadHex);
  if(!Number.isSafeInteger(now)||now<=0)throw Error('CLOCK_INVALID');
  if(payload.channel!==config.channel)throw Error('CHANNEL_MISMATCH');
  const nowUs=BigInt(now)*1000n;
  if(payload.timestampUs>nowUs||nowUs-payload.timestampUs>BigInt(config.maxEnvelopeAgeMs)*1000n)throw Error('ENVELOPE_CLOCK_INVALID');
  const ids=new Set(bindings.map(binding=>binding.pythFeedId));
  if(ids.size!==bindings.length||payload.feeds.length!==bindings.length||payload.feeds.some(feed=>!ids.has(feed.priceFeedId)))throw Error('RESPONSE_FEED_SET_INVALID');
  const expectedById=new Map(expected.map(value=>[value.feedId,value]));
  if(expectedById.size!==expected.length||expected.length!==bindings.length||expected.some(value=>!ids.has(value.feedId)))throw Error('EXPECTED_PRINTS_INVALID');
  const previousById=new Map(previous.map(value=>[value.feedId,value]));
  if(previousById.size!==previous.length)throw Error('STATE_INVALID');
  const values=new Map(payload.feeds.map(feed=>[feed.priceFeedId,feed]));
  return bindings.map(binding=>{
    const feed=values.get(binding.pythFeedId)!;
    return validatePythReadbackFeed({priceFeedId:feed.priceFeedId,price:String(feed.price),confidence:String(feed.confidence),exponent:feed.exponent,publisherCount:feed.publisherCount,feedUpdateTimestamp:String(feed.feedUpdateTimestampUs)},binding,config,now,payload.timestampUs,expectedById.get(binding.pythFeedId),previousById.get(binding.pythFeedId));
  });
}
