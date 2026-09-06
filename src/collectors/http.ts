import { createHash } from "node:crypto";
import type { CollectorContext } from "../types";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export class CollectionError extends Error {
  constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); }
}

/** Credentials are request-only. Evidence URLs never contain secrets. */
export async function jsonRequest(context: CollectorContext, source: string, url: URL, init: RequestInit = {}) {
  const evidenceUrl = new URL(url);
  for (const name of ["api_key", "key", "token", "access_token"]) evidenceUrl.searchParams.delete(name);
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("Accept", "application/json");
  if (!headers.has("user-agent")) headers.set("User-Agent", "blackwell-index/0.1");
  const response = await context.fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(25_000),
    headers,
  });
  if (!response.ok) {
    // Scheduling consumes the original header separately. Do not reflect arbitrary
    // upstream header text into local diagnostics or archived error strings.
    const rawRetry = response.headers.get("retry-after");
    const retry = rawRetry && /^\d{1,10}$/.test(rawRetry) ? rawRetry : null;
    await response.body?.cancel();
    throw new CollectionError(response.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR", `${source} HTTP ${response.status}${retry ? `; Retry-After=${retry}` : ""}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new CollectionError("RESPONSE_TOO_LARGE", source); }
  if (!response.body) throw new CollectionError("EMPTY_RESPONSE", source);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new CollectionError("RESPONSE_TOO_LARGE", source); }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  const observedAt = context.now();
  const evidenceHash = createHash("sha256").update(body).digest("hex");
  await context.archive({ hash: evidenceHash, source, url: evidenceUrl.toString(), receivedAt: observedAt, contentType: response.headers.get("content-type") ?? "application/octet-stream", body });
  let data: unknown;
  try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { throw new CollectionError("INVALID_JSON", source); }
  return { data, evidenceHash, observedAt, sourceUrl: evidenceUrl.toString() };
}

export function object(value: unknown, label = "record"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CollectionError("INVALID_SCHEMA", `${label} must be an object`);
  return value as Record<string, unknown>;
}
export function array(value: unknown, label = "records"): unknown[] {
  if (!Array.isArray(value)) throw new CollectionError("INVALID_SCHEMA", `${label} must be an array`);
  return value;
}
export function string(value: unknown, label = "value"): string {
  if (typeof value !== "string" || !value.trim()) throw new CollectionError("INVALID_SCHEMA", `${label} must be a nonempty string`);
  return value;
}
export function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new CollectionError("INVALID_SCHEMA", `${label} must be a positive safe integer`);
  return value;
}
/** No floating point arithmetic or implicit conversion of missing prices. */
export function decimal(value: unknown): string {
  const result = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof result !== "string" || !/^(0|[1-9]\d*)(?:\.\d+)?$/.test(result) || !/[1-9]/.test(result)) throw new CollectionError("INVALID_PRICE", "Expected a positive decimal");
  const [whole, fraction = ""] = result.split(".");
  const significantFraction = fraction.replace(/0+$/, "");
  if (significantFraction.length > 6) throw new CollectionError("INVALID_PRICE", "More than six significant fractional digits");
  return significantFraction ? `${whole}.${significantFraction}` : whole!;
}
export function timestamp(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new CollectionError("INVALID_SCHEMA", "Invalid source timestamp");
  return parsed;
}
export function failure(error: unknown, source: string): string {
  return error instanceof CollectionError ? error.message : `COLLECTION_FAILED: ${source}`;
}
