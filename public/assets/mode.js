import { deploymentConfig } from "./config.js";

export function resolveMode({ DEMO_MODE = false } = {}) {
  return DEMO_MODE === true ? "demo" : "real";
}

export const mode = resolveMode(deploymentConfig);
export const feedPath = mode === "real" ? "/v1/feeds" : "/v1/demo";
