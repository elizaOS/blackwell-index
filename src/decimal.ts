const SCALE = 1_000_000n;
/** Exact decimal parsing. Inputs beyond six decimals are rejected, never rounded invisibly. */
export function toMicros(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,10})(\.[0-9]{1,6})?$/.test(value)) throw new Error("Invalid decimal price");
  const [whole, fraction = ""] = value.split(".");
  const result = BigInt(whole!) * SCALE + BigInt(fraction.padEnd(6, "0"));
  if (result <= 0n) throw new Error("Price must be positive");
  return result;
}
export function fromMicros(value: bigint): string {
  if (value < 0n) throw new Error("Negative price");
  return `${value / SCALE}.${(value % SCALE).toString().padStart(6, "0")}`;
}
export function normalizeInstance(price: string, gpuCount: number): string {
  if (!Number.isSafeInteger(gpuCount) || gpuCount < 1 || gpuCount > 100_000) throw new Error("Invalid physical GPU count");
  const result = (toMicros(price) + BigInt(Math.floor(gpuCount / 2))) / BigInt(gpuCount);
  if (result === 0n) throw new Error("Normalized price below precision");
  return fromMicros(result);
}
export function median(values: bigint[]): bigint {
  if (!values.length) throw new Error("Empty median");
  const sorted = [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i]! : (sorted[i - 1]! + sorted[i]! + 1n) / 2n;
}
export function weighted(values: Array<{ price: bigint; weight: number }>): bigint {
  if (!values.length || values.some(x => !Number.isSafeInteger(x.weight) || x.weight <= 0)) throw new Error("Invalid weights");
  const divisor = values.reduce((s, x) => s + BigInt(x.weight), 0n);
  return (values.reduce((s, x) => s + x.price * BigInt(x.weight), 0n) + divisor / 2n) / divisor;
}
export function distance(a: bigint, b: bigint): bigint { return a > b ? a - b : b - a; }
