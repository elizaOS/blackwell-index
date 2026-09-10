/** Private capture and read-only health. No node identity, network peers or publisher. */
import type { NodeConfig } from "./config";
import type { Journal, SqlDriver } from "./journal";
import type { CollectorContext, Methodology, Registry } from "./types";
import { collectCapture } from "./collect-cycle";
import { observationSchema } from "./validation";

export const RESEARCH_LIMITS = Object.freeze({ cycleMs: 120_000, requests: 64, captureBytes: 4 * 1024 * 1024 });
const PUBLIC_SOURCES = ["oracle-public", "azure-retail", "verda-public"];

export function validateResearchJournal(db: SqlDriver): void {
  if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='local_journal_storage'").get())
    throw new Error("RESEARCH_REQUIRES_ORDINARY_JOURNAL");
}

export function validateResearch(config: NodeConfig, registry: Registry, methodology: Methodology): void {
  if (config.network !== registry.network || config.pythManifestPath !== undefined || config.peers.length ||
      !config.collectors.length || new Set(config.collectors).size !== config.collectors.length ||
      config.collectors.some(id => !PUBLIC_SOURCES.includes(id)) || methodology.status !== "DRAFT" ||
      registry.providers.some(provider => provider.rights.derive || provider.rights.redistribute)) throw new Error("RESEARCH_ONLY_CONFIGURATION_REQUIRED");
  for (const id of config.collectors) {
    const provider = registry.providers.find(value => value.sources.includes(id));
    if (!provider?.rights.collect) throw new Error("RESEARCH_COLLECTION_PERMISSION_REQUIRED");
  }
}

export function researchHealth(db: SqlDriver, config: NodeConfig, methodology: Methodology, now = Date.now()) {
  validateResearchJournal(db);
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("INVALID_RESEARCH_CLOCK");
  const maxAgeMs = Math.min(methodology.maxAgeMs, config.intervalMs * 2 + RESEARCH_LIMITS.cycleMs);
  return db.transaction(() => {
    const header = db.query("SELECT id,collected_at,length(CAST(observations AS BLOB))+length(CAST(errors AS BLOB)) AS bytes FROM captures ORDER BY id DESC LIMIT 1").get() as { id: number; collected_at: number; bytes: number } | null;
    const reasons: string[] = [];
    let observations: Array<ReturnType<typeof observationSchema.parse>> = [], errorCount = 0;
    if (!header) reasons.push("NO_CAPTURES");
    else if (!Number.isSafeInteger(header.bytes) || header.bytes < 1 || header.bytes > RESEARCH_LIMITS.captureBytes) reasons.push("CAPTURE_SIZE_INVALID");
    else {
      try {
        const row = db.query("SELECT observations,errors FROM captures WHERE id=?").get(header.id) as { observations: string; errors: string };
        const raw = JSON.parse(row.observations), errors = JSON.parse(row.errors);
        if (!Array.isArray(raw) || !Array.isArray(errors) || errors.some(value => typeof value !== "string")) throw new Error("INVALID_CAPTURE");
        observations = raw.map(value => observationSchema.parse(value)); errorCount = errors.length;
      } catch { reasons.push("CAPTURE_INVALID"); }
    }
    const lastCaptureAt = header && Number.isSafeInteger(header.collected_at) && header.collected_at > 0 ? header.collected_at : null;
    if (header && lastCaptureAt === null) reasons.push("CAPTURE_TIME_INVALID");
    if (lastCaptureAt !== null && (lastCaptureAt > now || now - lastCaptureAt > maxAgeMs)) reasons.push("CAPTURE_STALE_OR_FUTURE");
    if (errorCount) reasons.push("COLLECTION_ERRORS");
    const sources = config.collectors.map(id => {
      const points = observations.filter(value => value.source === id);
      const latestObservedAt = points.length ? Math.max(...points.map(value => value.observedAt)) : null;
      const fresh = points.length > 0 && points.every(value => value.observedAt <= now && value.observedAt <= (lastCaptureAt ?? 0) &&
        now - value.observedAt <= maxAgeMs && (value.expiresAt === null || value.expiresAt > now));
      return { id, count: points.length, latestObservedAt, fresh, models: [...new Set(points.map(value => value.model))].sort() };
    });
    if (!sources.length || sources.some(value => !value.fresh)) reasons.push("SOURCE_MISSING_STALE_OR_FUTURE");
    return { kind: "PRIVATE_RESEARCH_COLLECTION_HEALTH", status: reasons.length ? "DEGRADED" : "HEALTHY_RESEARCH", checkedAt: now,
      lastCaptureAt, captureAgeMs: lastCaptureAt === null ? null : now - lastCaptureAt, maxAgeMs,
      observationCount: observations.length, errorCount, sources, reasons, publishable: false, liveMarketQualified: false,
      note: "Collection liveness only; does not establish qualified prices, rights, independent groups or continuous history." };
  })();
}

export async function collectResearch(store: Journal, config: NodeConfig, registry: Registry, methodology: Methodology,
  context: Pick<CollectorContext, "now" | "fetch"> = { now: Date.now, fetch: globalThis.fetch }) {
  validateResearch(config, registry, methodology);
  validateResearchJournal(store.db);
  const deadline = AbortSignal.timeout(RESEARCH_LIMITS.cycleMs); let requests = 0;
  const admittedHosts = new Set(registry.providers.filter(provider => provider.sources.some(id => config.collectors.includes(id))).flatMap(provider => provider.allowedHosts));
  const transport = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !admittedHosts.has(url.hostname) ||
        (init?.method ?? "GET") !== "GET" || ++requests > RESEARCH_LIMITS.requests || deadline.aborted) throw new Error("RESEARCH_REQUEST_REJECTED");
    return context.fetch(input, { ...init, redirect: "manual", signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
  }) as typeof fetch;
  await collectCapture(config.collectors, registry, store, { now: context.now, env: {}, fetch: transport });
  return researchHealth(store.db, config, methodology, context.now());
}
