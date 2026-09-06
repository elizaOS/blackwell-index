import type { GpuModel } from "../types";

/** GB200 contains B200 text, but is a distinct system family. */
export function blackwellModel(value: unknown): GpuModel | null {
  if (typeof value !== "string") return null;
  const matches = value.toUpperCase().replaceAll("_", " ").match(/\b(?:GB300|GB200|B300|B200)\b/g);
  const unique = new Set(matches);
  return unique.size === 1 ? [...unique][0] as GpuModel : null;
}
