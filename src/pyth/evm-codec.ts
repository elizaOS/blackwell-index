/** SBX's narrow Pyth Pro EVM wire codec. Decoding is NOT signature verification.
 * Original implementation of the wire/ABI layout reviewed at upstream commit
 * 8dd8deee8d115b3ad4cea6ddc615118ba670ee36 (PythLazer.sol/Structs/Lib).
 * Only the five properties requested by the planned SBX consumer are accepted.
 */
export const PYTH_EVM_CODEC_LIMITS = Object.freeze({ payloadBytes: 65535, feeds: 100, properties: 5 });
export const PYTH_VERIFY_UPDATE_SELECTOR = "0x197e1a5a";
const ENVELOPE_MAGIC = 706910618, PAYLOAD_MAGIC = 2479346549;
const CHANNELS = { 1: "real_time", 2: "fixed_rate@50ms", 3: "fixed_rate@200ms", 4: "fixed_rate@1000ms" } as const;

export class PythEvmCodecError extends Error {
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new PythEvmCodecError(code); }
function bytes(input: unknown, limit: number, prefixRequired = false): Buffer {
  if (typeof input !== "string" || input.length > limit * 2 + 2) fail("HEX_INVALID");
  if (prefixRequired && !input.startsWith("0x")) fail("HEX_PREFIX_REQUIRED");
  const text = input.startsWith("0x") ? input.slice(2) : input;
  if (text.length > limit * 2 || !/^(?:[a-fA-F0-9]{2})*$/.test(text)) fail("HEX_INVALID");
  return Buffer.from(text, "hex");
}
const hex = (value: Uint8Array) => `0x${Buffer.from(value).toString("hex")}`;
const word = (value: bigint) => value.toString(16).padStart(64, "0");

export interface UnverifiedPythEvmEnvelope {
  authentication: "NOT_VERIFIED";
  canonicalHex: string;
  payloadHex: string;
  signatureHex: string;
  recoveryId: 0 | 1;
}

/** Accepts the API's hex encoding with or without 0x; emits one canonical form. */
export function decodePythEvmEnvelope(input: unknown): UnverifiedPythEvmEnvelope {
  const raw = bytes(input, PYTH_EVM_CODEC_LIMITS.payloadBytes + 71);
  if (raw.length < 71) fail("ENVELOPE_TRUNCATED");
  if (raw.readUInt32BE(0) !== ENVELOPE_MAGIC) fail("ENVELOPE_MAGIC_INVALID");
  const recoveryId = raw[68];
  if (recoveryId !== 0 && recoveryId !== 1) fail("RECOVERY_ID_INVALID");
  const length = raw.readUInt16BE(69);
  if (length === 0 || raw.length !== 71 + length) fail("ENVELOPE_LENGTH_INVALID");
  return { authentication: "NOT_VERIFIED", canonicalHex: hex(raw), payloadHex: hex(raw.subarray(71)),
    signatureHex: hex(raw.subarray(4, 69)), recoveryId };
}

export interface DecodedSbxEvmFeed {
  priceFeedId: number;
  price: bigint;
  confidence: bigint;
  publisherCount: number;
  exponent: number;
  feedUpdateTimestampUs: bigint;
}
export interface UnverifiedSbxEvmPayload {
  authentication: "NOT_VERIFIED";
  timestampUs: bigint;
  channel: typeof CHANNELS[keyof typeof CHANNELS];
  feeds: DecodedSbxEvmFeed[];
}

/** Structural checks only; caller must verify signatures, assignments and policy.
 * Zero confidence is unavailable in the reviewed Pro parser, not proof of exact
 * pricing. Do not synthesize a positive confidence to make a packet acceptable.
 */
export function decodeSbxEvmPayload(input: unknown): UnverifiedSbxEvmPayload {
  const raw = bytes(input, PYTH_EVM_CODEC_LIMITS.payloadBytes);
  let cursor = 0;
  const take = (length: number): Buffer => {
    if (cursor + length > raw.length) fail("PAYLOAD_TRUNCATED");
    const result = raw.subarray(cursor, cursor + length); cursor += length; return result;
  };
  if (take(4).readUInt32BE() !== PAYLOAD_MAGIC) fail("PAYLOAD_MAGIC_INVALID");
  const timestampUs = take(8).readBigUInt64BE();
  if (timestampUs === 0n) fail("TIMESTAMP_UNAVAILABLE");
  const channelId = take(1)[0]!;
  if (!Object.hasOwn(CHANNELS, channelId)) fail("CHANNEL_UNSUPPORTED");
  const channel = CHANNELS[channelId as keyof typeof CHANNELS], count = take(1)[0]!;
  if (count === 0 || count > PYTH_EVM_CODEC_LIMITS.feeds) fail("FEED_COUNT_INVALID");
  const ids = new Set<number>(), feeds: DecodedSbxEvmFeed[] = [];
  for (let index = 0; index < count; index++) {
    const priceFeedId = take(4).readUInt32BE();
    if (ids.has(priceFeedId)) fail("FEED_DUPLICATE");
    ids.add(priceFeedId);
    if (take(1)[0] !== PYTH_EVM_CODEC_LIMITS.properties) fail("PROPERTY_SET_INVALID");
    const fields = new Map<number, bigint>();
    for (let field = 0; field < PYTH_EVM_CODEC_LIMITS.properties; field++) {
      const property = take(1)[0]!;
      if (fields.has(property)) fail("PROPERTY_DUPLICATE");
      let value: bigint;
      switch (property) {
        case 0: value = take(8).readBigInt64BE(); break;
        case 3: value = BigInt(take(2).readUInt16BE()); break;
        case 4: value = BigInt(take(2).readInt16BE()); break;
        case 5: value = take(8).readBigUInt64BE(); break;
        case 12: {
          // FeedUpdateTimestamp is option<u64>: presence byte, then BE value.
          // Pinned PythLazerLib.sol parseUpdateFromPayload consumes this flag.
          const present = take(1)[0]!;
          if (present === 0) fail("FEED_TIMESTAMP_UNAVAILABLE");
          if (present !== 1) fail("FEED_TIMESTAMP_FLAG_INVALID");
          value = take(8).readBigUInt64BE(); break;
        }
        default: fail("PROPERTY_UNSUPPORTED");
      }
      fields.set(property, value);
    }
    const price = fields.get(0)!, publisherCount = Number(fields.get(3)!), exponent = Number(fields.get(4)!);
    const confidence = fields.get(5)!, feedUpdateTimestampUs = fields.get(12)!;
    if (price <= 0n) fail("POSITIVE_PRICE_REQUIRED");
    if (confidence === 0n) fail("CONFIDENCE_UNAVAILABLE");
    if (publisherCount === 0) fail("PUBLISHER_COUNT_UNAVAILABLE");
    if (feedUpdateTimestampUs === 0n || feedUpdateTimestampUs > timestampUs) fail("FEED_TIMESTAMP_INVALID");
    feeds.push({ priceFeedId, price, publisherCount, exponent, confidence, feedUpdateTimestampUs });
  }
  if (cursor !== raw.length) fail("PAYLOAD_TRAILING_BYTES");
  return { authentication: "NOT_VERIFIED", timestampUs, channel, feeds };
}

/** Encodes a call; never sends it or grants transaction authority. */
export function encodePythVerifyUpdateCall(input: unknown): string {
  const envelope = decodePythEvmEnvelope(input), data = envelope.canonicalHex.slice(2), length = data.length / 2;
  return PYTH_VERIFY_UPDATE_SELECTOR + word(32n) + word(BigInt(length)) + data.padEnd(Math.ceil(length / 32) * 64, "0");
}

/** Exact Solidity return ABI: (bytes payload,address signer), not (bytes,fee).
 * An RPC response is not independently authenticated by decoding its ABI.
 */
export function decodePythVerifyUpdateResult(input: unknown, submittedEnvelope: unknown): {
  authentication: "NOT_VERIFIED"; payloadHex: string; signer: string;
} {
  const envelope = decodePythEvmEnvelope(submittedEnvelope);
  const raw = bytes(input, 96 + Math.ceil(PYTH_EVM_CODEC_LIMITS.payloadBytes / 32) * 32, true);
  if (raw.length < 96) fail("RESULT_ABI_INVALID");
  const integer = (offset: number) => BigInt(`0x${raw.subarray(offset, offset + 32).toString("hex")}`);
  if (integer(0) !== 64n || raw.subarray(32, 44).some(value => value !== 0)) fail("RESULT_ABI_INVALID");
  const signer = hex(raw.subarray(44, 64));
  if (/^0x0+$/.test(signer)) fail("RESULT_SIGNER_INVALID");
  const size = integer(64);
  if (size === 0n || size > BigInt(PYTH_EVM_CODEC_LIMITS.payloadBytes)) fail("RESULT_ABI_INVALID");
  const length = Number(size), end = 96 + length;
  if (raw.length !== 96 + Math.ceil(length / 32) * 32 || raw.subarray(end).some(value => value !== 0)) fail("RESULT_ABI_INVALID");
  const payloadHex = hex(raw.subarray(96, end));
  if (payloadHex !== envelope.payloadHex) fail("RESULT_PAYLOAD_MISMATCH");
  return { authentication: "NOT_VERIFIED", payloadHex, signer };
}
