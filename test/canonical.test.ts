import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonical, canonicalByteLength, hash } from "../src/crypto";

// Previous wire implementation is an independent compatibility oracle. Do not
// replace it with the production traversal: retained signatures depend on bytes.
function previousCanonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(previousCanonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${previousCanonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("Canonical payload must contain only finite JSON values");
}
function compatible(value: unknown): void {
  const expected = previousCanonical(value);
  expect(canonical(value)).toBe(expected);
  expect(canonicalByteLength(value)).toBe(Buffer.byteLength(expected));
  expect(hash(value)).toBe(createHash("sha256").update(expected).digest("hex"));
}

describe("canonical wire compatibility", () => {
  test("preserves scalar encoding, lexical keys and complete Unicode tokens", () => {
    for (const value of [null, true, false, 0, -0, 1e-7, 1e21, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE,
      "", "\"\\\b\f\n\r\t\u0000", "é中😀", "\ud800", "\udc00", "\u2028\u2029",
      { "2": "two", "10": "ten", "01": "one", z: [null, "😀", { "\ud800": "\udc00" }], a: true }]) compatible(value);
    expect(canonical({ "2": 2, "10": 10 })).toBe('{"10":10,"2":2}');
    expect(hash({ a: 1 })).toBe("015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
  });

  test("preserves sparse arrays, inherited indexes and captured array length", () => {
    const sparse = new Array(4);
    sparse[3] = "last";
    const prototype = Object.create(Array.prototype);
    prototype[1] = "inherited";
    Object.setPrototypeOf(sparse, prototype);
    compatible(sparse);
    expect(canonical(sparse)).toBe('[,"inherited",,"last"]');
    const changing = () => {
      const value: unknown[] = [null, "original"];
      Object.defineProperty(value, 0, { get() { value.push("outside captured length"); return "first"; } });
      return value;
    };
    const expected = previousCanonical(changing());
    expect(canonical(changing())).toBe(expected);
    expect(canonicalByteLength(changing())).toBe(Buffer.byteLength(expected));
    expect(hash(changing())).toBe(createHash("sha256").update(expected).digest("hex"));
  });

  test("preserves nested archive-sized base64 and escaped row payloads", () => {
    const body = Buffer.alloc(256 * 1024);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;
    compatible({ domain: "SBX_ARCHIVE_BLOCK_V2", block: { fragments: [
      { table: 0, data: body.toString("base64"), key: ["evidence", 0], offset: 0 },
      { table: 1, data: JSON.stringify({ quote: "$10.00", region: "日本😀", line: "\n\ud800" }) },
    ], index: 1, previousHash: null } });
  });

  test("preserves hashes across batches of small tokens and oversized Unicode scalars", () => {
    compatible({ before: Array.from({ length: 6000 }, (_, i) => [i, "é中😀\ud800"]),
      exact: "x".repeat(16382), oversized: "😀".repeat(20000),
      after: Array.from({ length: 7000 }, (_, i) => ({ value: i % 2 ? "\udc00" : "tail" })) });
  });

  test("rejects unsupported values at the same nested positions", () => {
    for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol("unsupported"), () => 1]) {
      for (const input of [value, [value], { nested: value }]) {
        expect(() => previousCanonical(input)).toThrow("Canonical payload must contain only finite JSON values");
        expect(() => canonical(input)).toThrow("Canonical payload must contain only finite JSON values");
        expect(() => canonicalByteLength(input)).toThrow("Canonical payload must contain only finite JSON values");
        expect(() => hash(input)).toThrow("Canonical payload must contain only finite JSON values");
      }
    }
  });
});
