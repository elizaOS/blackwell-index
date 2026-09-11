import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { NodeIdentity, ObservationBatch, SignedBatch } from "./types";

/** Emit complete JSON scalar tokens so hashing and byte counts preserve UTF-8 boundaries. */
function writeCanonical(value: unknown, write: (part: string) => void): void {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) {
    write(JSON.stringify(value)); return;
  }
  if (Array.isArray(value)) {
    write("[");
    // Match Array.map's captured length and handling of holes/inherited indexes.
    const length = value.length;
    for (let i = 0; i < length; i++) {
      if (i) write(",");
      if (i in value) writeCanonical(value[i], write);
    }
    write("]"); return;
  }
  if (typeof value === "object" && value !== null) {
    write("{");
    const keys = Object.keys(value).sort();
    for (let i = 0; i < keys.length; i++) {
      if (i) write(",");
      const key = keys[i]!;
      write(JSON.stringify(key)); write(":");
      writeCanonical((value as Record<string, unknown>)[key], write);
    }
    write("}"); return;
  }
  throw new Error("Canonical payload must contain only finite JSON values");
}
export function canonical(value: unknown): string {
  const parts: string[] = [];
  writeCanonical(value, part => { parts.push(part); });
  return parts.join("");
}
export function canonicalByteLength(value: unknown): number {
  let bytes = 0;
  writeCanonical(value, part => { bytes += Buffer.byteLength(part); });
  return bytes;
}
export function hash(value: unknown): string {
  const digest = createHash("sha256");
  // Batch small tokens to bound native crypto calls without splitting a scalar's UTF-8 encoding.
  let parts: string[] = [], characters = 0;
  const flush = () => { if (parts.length) { digest.update(parts.join("")); parts = []; characters = 0; } };
  writeCanonical(value, part => {
    if (characters + part.length > 16 * 1024) flush();
    if (part.length >= 16 * 1024) digest.update(part);
    else { parts.push(part); characters += part.length; }
  });
  flush();
  return digest.digest("hex");
}
export function nodeIdFor(publicKey: string): string { return createHash("sha256").update(publicKey).digest("hex"); }
export function generateIdentity(): NodeIdentity {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { nodeId: nodeIdFor(publicKey), publicKey, privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}
export function signBatch(payload: ObservationBatch, identity: NodeIdentity): SignedBatch {
  if (payload.nodeId !== identity.nodeId || payload.publicKey !== identity.publicKey) throw new Error("Identity mismatch");
  return { payload, signature: sign(null, Buffer.from(canonical(payload)), createPrivateKey(identity.privateKeyPem)).toString("base64") };
}
export function verifyBatch(batch: SignedBatch): boolean {
  try {
    if (Buffer.from(batch.signature,"base64").toString("base64") !== batch.signature || Buffer.from(batch.payload.publicKey,"base64").toString("base64") !== batch.payload.publicKey) return false;
    if (batch.payload.nodeId !== nodeIdFor(batch.payload.publicKey)) return false;
    const key = createPublicKey({ key: Buffer.from(batch.payload.publicKey, "base64"), type: "spki", format: "der" });
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, Buffer.from(canonical(batch.payload)), key, Buffer.from(batch.signature, "base64"));
  } catch { return false; }
}
