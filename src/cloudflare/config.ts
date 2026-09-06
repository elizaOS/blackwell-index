import { collectorCatalog, createCollectors } from "../collectors";
import { defaultMethodology, defaultRegistry } from "../config";
import { peerUrl } from "../network";
import { parseMethodology, parseRegistry } from "../validation";
import type { SbxNode } from "./index";

// Runtime declarations are generated separately: Worker vars must not become required Bun ProcessEnv fields.
export type WorkerEnvironment = {
  ASSETS: Fetcher;
  SBX_NODES: DurableObjectNamespace<SbxNode>;
  SBX_NETWORK: string;
  SBX_OPERATOR_GROUP: string;
  SBX_COLLECTORS: string;
  SBX_COLLECTION_INTERVAL_MS: string;
  SBX_REGISTRY_JSON?: string;
  SBX_METHODOLOGY_JSON?: string;
  SBX_PEERS_JSON?: string;
  SBX_RELEASE?: string;
} & Partial<Record<string, unknown>>;

export function runtimeConfig(env: WorkerEnvironment) {
  const network = env.SBX_NETWORK;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(network)) throw new Error("INVALID_NETWORK");
  const operatorGroup = env.SBX_OPERATOR_GROUP;
  if (!operatorGroup || operatorGroup.length > 128) throw new Error("INVALID_OPERATOR_GROUP");
  const intervalMs = Number(env.SBX_COLLECTION_INTERVAL_MS);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 30000 || intervalMs > 86400000) throw new Error("INVALID_COLLECTION_INTERVAL");
  const collectors = env.SBX_COLLECTORS.split(",").map(id => id.trim()).filter(Boolean);
  createCollectors(collectors);
  const registry = parseRegistry(env.SBX_REGISTRY_JSON ? JSON.parse(env.SBX_REGISTRY_JSON) : defaultRegistry(network));
  const methodology = parseMethodology(env.SBX_METHODOLOGY_JSON ? JSON.parse(env.SBX_METHODOLOGY_JSON) : defaultMethodology());
  if (registry.network !== network) throw new Error("NETWORK_REGISTRY_MISMATCH");
  const peers: unknown = env.SBX_PEERS_JSON ? JSON.parse(env.SBX_PEERS_JSON) : [];
  if (!Array.isArray(peers) || peers.length > 32 || !peers.every(p => typeof p === "string")) throw new Error("INVALID_PEERS");
  for (const peer of peers) {
    const url = peerUrl(peer);
    if (url.pathname !== "/") throw new Error("PEER_REQUIRES_HOST_ROOT");
  }
  const credentials: Record<string, string | undefined> = {};
  for (const descriptor of collectorCatalog) {
    const names = [...(descriptor.credentialEnvs ?? (descriptor.credentialEnv ? [descriptor.credentialEnv] : [])), ...(descriptor.configurationEnvs ?? [])];
    for (const name of names) if (typeof env[name] === "string") credentials[name] = env[name];
  }
  return { network, operatorGroup, intervalMs, collectors, registry, methodology, peers: peers as string[], credentials };
}
