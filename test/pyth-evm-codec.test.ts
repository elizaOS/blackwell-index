import { expect, test } from "bun:test";
import { decodePythEvmEnvelope, decodePythVerifyUpdateResult, decodeSbxEvmPayload, encodePythVerifyUpdateCall } from "../src/pyth/evm-codec";

// Invented, isolated wire fixtures. No real price, signature or publisher proof.
const TIME = 1788732000000000n;
type Field = [number, bigint];
const FIELDS: Field[] = [[0, 123456789n], [3, 3n], [4, -6n], [5, 125n], [12, TIME - 1000n]];
const asHex = (value: Uint8Array) => `0x${Buffer.from(value).toString("hex")}`;
function payload(rows: Array<{ id?: number; fields?: Field[] }> = [{}], time = TIME, channel = 4): Buffer {
  const header = Buffer.alloc(14); header.writeUInt32BE(2479346549); header.writeBigUInt64BE(time, 4); header[12] = channel; header[13] = rows.length;
  return Buffer.concat([header, ...rows.flatMap(({ id = 7, fields = FIELDS }) => {
    const feed = Buffer.alloc(5); feed.writeUInt32BE(id); feed[4] = fields.length;
    return [feed, ...fields.map(([property, value]) => {
      const width = property === 3 || property === 4 ? 2 : 8, field = Buffer.alloc(width + 1); field[0] = property;
      if (property === 4) field.writeInt16BE(Number(value), 1);
      else if (property === 3) field.writeUInt16BE(Number(value), 1);
      else if (property === 0) field.writeBigInt64BE(value, 1);
      else field.writeBigUInt64BE(value, 1);
      return property === 12 ? Buffer.concat([field.subarray(0, 1), Buffer.from([1]), field.subarray(1)]) : field;
    })];
  })]);
}
function envelope(body = payload()): Buffer {
  const prefix = Buffer.alloc(71); prefix.writeUInt32BE(706910618); prefix.fill(1, 4, 68); prefix[68] = 1; prefix.writeUInt16BE(body.length, 69);
  return Buffer.concat([prefix, body]);
}
function result(body = payload()): Buffer {
  const raw = Buffer.alloc(96 + Math.ceil(body.length / 32) * 32);
  raw[31] = 64; raw.fill(1, 44, 64); raw.writeBigUInt64BE(BigInt(body.length), 88); body.copy(raw, 96); return raw;
}
const fieldValue = (property: number, value: bigint): Field[] => FIELDS.map(field => field[0] === property ? [property, value] : field);


test("feed timestamp consumes its option tag and rejects absent or noncanonical tags", () => {
  const raw = payload(), flag = raw.length - 9;
  expect(raw[flag]).toBe(1);
  for (const tag of [0, 2, 255]) {
    const invalid = Buffer.from(raw); invalid[flag] = tag;
    expect(() => decodeSbxEvmPayload(asHex(invalid))).toThrow(tag === 0 ? "FEED_TIMESTAMP_UNAVAILABLE" : "FEED_TIMESTAMP_FLAG_INVALID");
  }
  const absent = Buffer.concat([raw.subarray(0, flag), Buffer.from([0])]);
  expect(() => decodeSbxEvmPayload(asHex(absent))).toThrow("FEED_TIMESTAMP_UNAVAILABLE");
});

test("envelope normalizes API hex but explicitly provides no authentication", () => {
  const raw = envelope(), decoded = decodePythEvmEnvelope(raw.toString("hex").toUpperCase());
  expect(decoded).toEqual({ authentication: "NOT_VERIFIED", canonicalHex: asHex(raw), payloadHex: asHex(payload()), signatureHex: asHex(raw.subarray(4, 69)), recoveryId: 1 });
  const tampered = Buffer.from(raw); tampered[4] = 99;
  expect(decodePythEvmEnvelope(asHex(tampered)).authentication).toBe("NOT_VERIFIED");
  expect(decodePythEvmEnvelope(asHex(tampered)).signatureHex).not.toBe(decoded.signatureHex);
});

test("exact requested core properties decode without losing integer precision", () => {
  const decoded = decodeSbxEvmPayload(asHex(payload()));
  expect(decoded).toEqual({ authentication: "NOT_VERIFIED", timestampUs: TIME, channel: "fixed_rate@1000ms", feeds: [{ priceFeedId: 7, price: 123456789n, confidence: 125n, publisherCount: 3, exponent: -6, feedUpdateTimestampUs: TIME - 1000n }] });
  expect(decodeSbxEvmPayload(asHex(payload([{ fields: [...FIELDS].reverse() }])))).toEqual(decoded);
  const high: Field[] = [[0, (1n << 63n) - 1n], [3, 65535n], [4, -32768n], [5, (1n << 64n) - 1n], [12, (1n << 64n) - 1n]];
  const boundary = decodeSbxEvmPayload(asHex(payload([{ id: 4294967295, fields: high }], (1n << 64n) - 1n)));
  expect(boundary.feeds[0]!.price).toBe((1n << 63n) - 1n);
  expect(boundary.feeds[0]!.confidence).toBe((1n << 64n) - 1n);
  expect(boundary.feeds[0]!.priceFeedId).toBe(4294967295);
  expect(boundary.feeds[0]!.exponent).toBe(-32768);
});

test("all truncations and trailing bytes fail rather than padding missing fields", () => {
  for (const [raw, decode] of [[payload(), decodeSbxEvmPayload], [envelope(), decodePythEvmEnvelope]] as const) {
    for (let size = 0; size < raw.length; size++) expect(() => decode(asHex(raw.subarray(0, size)))).toThrow();
    expect(() => decode(asHex(Buffer.concat([raw, Buffer.from([0])])))).toThrow();
  }
});

test("untrusted encodings are bounded and strict", () => {
  for (const input of [null, undefined, 4, {}, [], "0x0", "0X00", " 0x00", "0xgg", "0x00\n", "00".repeat(66000)]) {
    expect(() => decodePythEvmEnvelope(input)).toThrow(); expect(() => decodeSbxEvmPayload(input)).toThrow();
  }
  for (const index of [0, 1, 2, 3]) {
    const raw = envelope(); raw[index] = raw[index]! ^ 1; expect(() => decodePythEvmEnvelope(asHex(raw))).toThrow("ENVELOPE_MAGIC_INVALID");
  }
  for (const recovery of [2, 27, 28, 255]) {
    const raw = envelope(); raw[68] = recovery; expect(() => decodePythEvmEnvelope(asHex(raw))).toThrow("RECOVERY_ID_INVALID");
  }
  const empty = envelope(Buffer.alloc(0)); expect(() => decodePythEvmEnvelope(asHex(empty))).toThrow("ENVELOPE_LENGTH_INVALID");
});

test("feed cardinality and property identity are enforced", () => {
  expect(() => decodeSbxEvmPayload(asHex(payload([])))).toThrow("FEED_COUNT_INVALID");
  expect(() => decodeSbxEvmPayload(asHex(payload([{}, {}])))).toThrow("FEED_DUPLICATE");
  expect(decodeSbxEvmPayload(asHex(payload(Array.from({ length: 100 }, (_, id) => ({ id }))))).feeds.length).toBe(100);
  expect(() => decodeSbxEvmPayload(asHex(payload(Array.from({ length: 101 }, (_, id) => ({ id })))))).toThrow("FEED_COUNT_INVALID");
  expect(() => decodeSbxEvmPayload(asHex(payload([{ fields: FIELDS.slice(1) }])))).toThrow("PROPERTY_SET_INVALID");
  expect(() => decodeSbxEvmPayload(asHex(payload([{ fields: [...FIELDS, FIELDS[0]!] }])))).toThrow("PROPERTY_SET_INVALID");
  expect(() => decodeSbxEvmPayload(asHex(payload([{ fields: [FIELDS[0]!, FIELDS[0]!, ...FIELDS.slice(2)] }])))).toThrow("PROPERTY_DUPLICATE");
  expect(() => decodeSbxEvmPayload(asHex(payload([{ fields: [[2, 1n], ...FIELDS.slice(1)] }])))).toThrow("PROPERTY_UNSUPPORTED");
});

test("zero missing sentinels and negative GPU prices never become valid data", () => {
  for (const [property, value, code] of [[0, 0n, "POSITIVE_PRICE_REQUIRED"], [0, -1n, "POSITIVE_PRICE_REQUIRED"], [3, 0n, "PUBLISHER_COUNT_UNAVAILABLE"], [5, 0n, "CONFIDENCE_UNAVAILABLE"], [12, 0n, "FEED_TIMESTAMP_INVALID"], [12, TIME + 1n, "FEED_TIMESTAMP_INVALID"]] as const) {
    expect(() => decodeSbxEvmPayload(asHex(payload([{ fields: fieldValue(property, value) }])))).toThrow(code);
  }
  expect(() => decodeSbxEvmPayload(asHex(payload([{}], 0n)))).toThrow("TIMESTAMP_UNAVAILABLE");
  for (const channel of [0, 5, 255]) expect(() => decodeSbxEvmPayload(asHex(payload([{}], TIME, channel)))).toThrow("CHANNEL_UNSUPPORTED");
  for (const [channel, expected] of [[1, "real_time"], [2, "fixed_rate@50ms"], [3, "fixed_rate@200ms"], [4, "fixed_rate@1000ms"]] as const) expect(decodeSbxEvmPayload(asHex(payload([{}], TIME, channel))).channel).toBe(expected);
});

test("verifyUpdate ABI call has the exact selector, offset, length and zero padding", () => {
  const raw = envelope(), call = encodePythVerifyUpdateCall(asHex(raw)), encoded = Buffer.from(call.slice(10), "hex");
  expect(call.slice(0, 10)).toBe("0x197e1a5a");
  expect(encoded.subarray(0, 31).every(value => value === 0)).toBe(true); expect(encoded[31]).toBe(32);
  expect(encoded.readBigUInt64BE(56)).toBe(BigInt(raw.length));
  expect(encoded.subarray(64, 64 + raw.length).toString("hex")).toBe(raw.toString("hex"));
  expect(encoded.subarray(64 + raw.length).every(value => value === 0)).toBe(true);
  expect(encoded.length).toBe(64 + Math.ceil(raw.length / 32) * 32);
});

test("result ABI returns the signer and exact submitted payload without claiming trust", () => {
  expect(decodePythVerifyUpdateResult(asHex(result()), asHex(envelope()))).toEqual({ authentication: "NOT_VERIFIED", payloadHex: asHex(payload()), signer: `0x${"01".repeat(20)}` });
  const raw = result();
  for (let size = 0; size < raw.length; size++) expect(() => decodePythVerifyUpdateResult(asHex(raw.subarray(0, size)), asHex(envelope()))).toThrow();
  expect(() => decodePythVerifyUpdateResult(raw.toString("hex"), asHex(envelope()))).toThrow("HEX_PREFIX_REQUIRED");
  for (const change of ["offset", "high-address", "zero-address", "length", "padding", "trailing", "payload"]) {
    let modified = Buffer.from(raw);
    if (change === "offset") modified[31] = 32;
    if (change === "high-address") modified[32] = 1;
    if (change === "zero-address") modified.fill(0, 44, 64);
    if (change === "length") modified[64] = 1;
    if (change === "padding") modified[modified.length - 1] = 1;
    if (change === "trailing") modified = Buffer.concat([modified, Buffer.alloc(32)]);
    if (change === "payload") modified[100] = modified[100]! ^ 1;
    expect(() => decodePythVerifyUpdateResult(asHex(modified), asHex(envelope()))).toThrow();
  }
});
