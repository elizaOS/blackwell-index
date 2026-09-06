import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { NodeIdentity, ObservationBatch, SignedBatch } from "./types";

export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new Error("Canonical payload must contain only finite JSON values");
}
export function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
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
