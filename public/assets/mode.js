import { deploymentConfig } from "./config.js";

export function resolveMode({ DEMO_MODE = false } = {}) {
  return DEMO_MODE === true ? "demo" : "real";
}

export const mode = resolveMode(deploymentConfig);
export const feedPath = mode === "real" ? "/v1/feeds" : "/v1/demo";

if (typeof document !== "undefined") {
  for (const link of document.querySelectorAll('a[href="/v1/demo"]')) link.href = feedPath;
}
