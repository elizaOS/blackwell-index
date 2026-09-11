/** Bounded replay of retained B200 response bytes. No live fetch, signer or publication. */
import { createHash } from "node:crypto";
import { hash } from "./crypto";
import { instanceResourceKey } from "./instance-resources";
import { lambda } from "./collectors/lambda";
import { oracle } from "./collectors/oracle";
import { runpod } from "./collectors/runpod";
import { verda } from "./collectors/verda";
import type { SqlDriver } from "./journal";
import { operatingStudy, type StudyOptions } from "./study";
import type { Collector, Methodology, Observation, Registry } from "./types";
import { parseMethodology, parseRegistry } from "./validation";

export const SOURCE_AUDIT_LIMITS = Object.freeze({ evidenceRecords: 256, evidenceBytes: 32 * 1024 * 1024, bodyBytes: 10 * 1024 * 1024 });
interface EvidenceHeader { source: string; url: string; received_at: number; content_type: string; bytes: number; storage: string }

const replayCollectors: Record<string, Collector> = { "oracle-public": oracle, "verda-public": verda, "runpod-secure": runpod, "lambda-cloud": lambda };
// Satisfies the existing collector's key-presence check only. No credentials are loaded.
const OFFLINE_RUNPOD_KEY = "sbx-offline-replay-not-a-credential";
const OFFLINE_LAMBDA_KEY = "sbx-offline-lambda-replay-not-a-credential";
const LAMBDA_ARCHIVE_URL = "https://cloud.lambda.ai/api/v1/instance-types";

export async function auditB200Sources(db: SqlDriver, registryInput: Registry, methodologyInput: Methodology,
  options: StudyOptions & { maxEvidenceRecords?: number; maxEvidenceBytes?: number }) {
  const registry = parseRegistry(registryInput), methodology = parseMethodology(methodologyInput);
  const limitRecords = options.maxEvidenceRecords ?? SOURCE_AUDIT_LIMITS.evidenceRecords;
  const limitBytes = options.maxEvidenceBytes ?? SOURCE_AUDIT_LIMITS.evidenceBytes;
  if (!Number.isSafeInteger(limitRecords) || limitRecords < 1 || limitRecords > SOURCE_AUDIT_LIMITS.evidenceRecords ||
      !Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > SOURCE_AUDIT_LIMITS.evidenceBytes) throw new Error("Invalid source audit limit");

  // SQLite transactions are synchronous. Materialize bounded input in one read snapshot,
  // then replay through asynchronous collectors using only the captured byte arrays.
  const { study, series, archived, bytesRead } = db.transaction(() => {
    const study = operatingStudy(db, options), series = study.series.filter(value => value.terms.model === "B200");
    const digests = [...new Set(series.flatMap(value => value.points.map(point => point.evidenceHash)))].sort();
    const archived = new Map<string, { header: EvidenceHeader | null; body: Uint8Array | null; reasons: string[] }>(); let bytesRead = 0;
    for (const [index, digest] of digests.entries()) {
      const reasons: string[] = [];
      if (index >= limitRecords) { archived.set(digest, { header: null, body: null, reasons: ["EVIDENCE_RECORD_LIMIT"] }); continue; }
      const header = db.query("SELECT source,url,received_at,content_type,length(body) AS bytes,typeof(body) AS storage FROM evidence WHERE hash=?").get(digest) as EvidenceHeader | null;
      if (!header) { archived.set(digest, { header: null, body: null, reasons: ["EVIDENCE_MISSING"] }); continue; }
      if (header.storage !== "blob") reasons.push("EVIDENCE_BODY_STORAGE_INVALID");
      if (!Number.isSafeInteger(header.received_at) || header.received_at <= 0 || header.received_at > study.asOf) reasons.push("EVIDENCE_TIME_INVALID_OR_AFTER_CUTOFF");
      if (!Number.isSafeInteger(header.bytes) || header.bytes < 1 || header.bytes > SOURCE_AUDIT_LIMITS.bodyBytes) reasons.push("EVIDENCE_BODY_LIMIT_OR_EMPTY");
      if (bytesRead + header.bytes > limitBytes) reasons.push("EVIDENCE_BYTE_LIMIT");
      let body: Uint8Array | null = null;
      if (!reasons.length) {
        const row = db.query("SELECT body FROM evidence WHERE hash=?").get(digest) as { body: Uint8Array };
        body = new Uint8Array(row.body); bytesRead += body.byteLength;
        if (createHash("sha256").update(body).digest("hex") !== digest) reasons.push("EVIDENCE_HASH_MISMATCH");
      }
      archived.set(digest, { header, body, reasons });
    }
    return { study, series, archived, bytesRead };
  })();

  const evidence = [];
  const reproduced = new Map<string, Observation[]>();
  const hasInstanceResources = series.some(item => item.terms.instanceResources !== undefined);
  const lambdaResourceDigests = new Set(series.filter(item => item.terms.source === lambda.id && item.terms.instanceResources)
    .flatMap(item => item.points.map(point => point.evidenceHash)));
  for (const [digest, record] of archived) {
    const reasons = [...record.reasons]; let matchedArchiveRequests = 0, missingArchiveRequests = 0;
    const header = record.header, collector = header && Object.hasOwn(replayCollectors, header.source) ? replayCollectors[header.source] : undefined;
    const replayResources = collector === lambda && lambdaResourceDigests.has(digest);
    let replayedResourceB200Observations = 0;
    if (header && !collector) reasons.push("COLLECTOR_REPLAY_UNSUPPORTED");
    let origin: string | null = null;
    if (header) {
      try {
        const url = new URL(header.url); origin = url.origin;
        const provider = registry.providers.find(value => value.id === collector?.provider);
        if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
            !provider?.allowedHosts.includes(url.hostname) || !provider.sources.includes(header.source)) reasons.push("SOURCE_METADATA_NOT_ADMITTED");
        if (collector === runpod && header.url !== "https://api.runpod.io/graphql") reasons.push("RUNPOD_ARCHIVE_URL_NOT_CANONICAL");
        if (collector === lambda && header.url !== LAMBDA_ARCHIVE_URL) reasons.push("LAMBDA_ARCHIVE_URL_NOT_CANONICAL");
      } catch { reasons.push("EVIDENCE_URL_INVALID"); }
    }
    if (!reasons.length && collector && header && record.body) {
      const body = record.body;
      try {
        // One retained transport body may have both legacy and explicitly enriched
        // observations. Replay each required semantic version without rewriting either.
        for (const resourceMode of replayResources ? [false, true] : [false]) {
          const result = await collector.collect({ now: () => header.received_at,
            env: collector === runpod ? { RUNPOD_API_KEY: OFFLINE_RUNPOD_KEY } : collector === lambda
              ? { LAMBDA_API_KEY: OFFLINE_LAMBDA_KEY, ...(resourceMode ? { LAMBDA_INSTANCE_RESOURCES: "1" } : {}) } : {},
            fetch: (async (input, init) => {
              const url = new URL(input instanceof Request ? input.url : String(input));
              if (collector === runpod) {
                if (init?.method !== "POST" || url.searchParams.getAll("api_key").length !== 1 || url.searchParams.get("api_key") !== OFFLINE_RUNPOD_KEY)
                  throw new Error("OFFLINE_RUNPOD_REQUEST_INVALID");
                url.searchParams.delete("api_key");
              }
              if (collector === lambda && ((init?.method ?? "GET") !== "GET" || init?.body != null ||
                  new Headers(init?.headers).get("Authorization") !== `Bearer ${OFFLINE_LAMBDA_KEY}`))
                throw new Error("OFFLINE_LAMBDA_REQUEST_INVALID");
              if (url.toString() !== new URL(header.url).toString()) {
                missingArchiveRequests++;
                return new Response(null, { status: 404 });
              }
              matchedArchiveRequests++;
              return new Response(body.slice(), { headers: { "content-type": header.content_type } });
            }) as typeof fetch,
            archive: async value => {
              if (value.hash !== digest || value.source !== header.source || value.url !== header.url) throw new Error("OFFLINE_ARCHIVE_MISMATCH");
            } });
          const b200 = result.observations.filter(value => value.model === "B200" && value.evidenceHash === digest);
          reproduced.set(digest, [...(reproduced.get(digest) ?? []), ...b200]);
          if (resourceMode) {
            replayedResourceB200Observations = b200.length;
            if (!b200.length || result.errors.length) reasons.push("LAMBDA_INSTANCE_RESOURCES_REPLAY_FAILED");
          }
          if (!b200.length) reasons.push("NO_B200_OBSERVATIONS_REPRODUCED");
        }
      } catch { reasons.push("OFFLINE_COLLECTOR_REPLAY_FAILED"); }
    }
    evidence.push({ hash: digest, source: header?.source ?? null, origin, firstRetainedAt: header?.received_at ?? null,
      bytes: header?.bytes ?? null, contentHashVerified: record.body !== null && !record.reasons.includes("EVIDENCE_HASH_MISMATCH"),
      matchedArchiveRequests, missingArchiveRequests, replayedB200Observations: reproduced.get(digest)?.length ?? 0,
      ...(replayResources ? { replayVariants: ["LEGACY", "INSTANCE_RESOURCES_V1"], replayedResourceB200Observations } : {}), reasons });
  }

  let observationCount = 0, observationsReproduced = 0;
  const offers = series.map(item => {
    const terms = item.terms, provider = registry.providers.find(value => value.id === terms.provider);
    const issues = new Set<string>(item.issues); let matched = 0;
    for (const point of item.points) {
      observationCount++;
      const record = archived.get(point.evidenceHash)!;
      if (!point.evidenceRetainedAtCapture || !record.header || record.header.received_at > point.observedAt) { issues.add("EVIDENCE_NOT_RETAINED_AT_OBSERVATION"); continue; }
      if (record.header.source !== terms.source) { issues.add("EVIDENCE_SOURCE_MISMATCH"); continue; }
      // Includes provenance URL, source record, hardware, unit and all commercial fields.
      // Reusing an unchanged body at a later observation time does not prove a new HTTP retrieval.
      const candidates = reproduced.get(point.evidenceHash) ?? [];
      if (candidates.some(value => hash({ ...value, observedAt: point.observedAt }) === point.observationHash)) { matched++; observationsReproduced++; }
      else issues.add("OBSERVATION_NOT_REPRODUCED_FROM_RETAINED_RESPONSE");
    }
    const inResearchCohort = terms.procurement === "ON_DEMAND" && terms.priceBasis === "LIST" && terms.tenancy === "EXCLUSIVE" &&
      terms.priceScope === "PUBLIC" && (methodology.cohort.regions.includes("*") || methodology.cohort.regions.includes(terms.region));
    return { seriesId: item.id, terms, economicGroup: provider?.economicGroup ?? null, inResearchCohort,
      observationCount: item.points.length, observationsReproduced: matched, firstKnownAt: item.firstKnownAt, lastKnownAt: item.lastKnownAt,
      latestObservedAt: item.lastObservedAt, latestPrice: item.lastPrice, issues: [...issues].sort(),
      unknowns: [...(terms.region === "global" || terms.region === "unspecified" ? ["GEOGRAPHIC_OFFER_NOT_ESTABLISHED"] : []),
        ...(hasInstanceResources && !terms.instanceResources ? ["INSTANCE_RESOURCES_UNKNOWN"] : []),
        ...(terms.topology === "UNKNOWN" ? ["TOPOLOGY_UNKNOWN"] : []), ...(terms.minimumOrderGpuCount === null ? ["MINIMUM_ORDER_UNKNOWN"] : []),
        ...(item.points.some(point => point.availability === "UNKNOWN") ? ["EXECUTABLE_AVAILABILITY_UNKNOWN"] : []),
        ...(item.points.some(point => point.availability === "UNAVAILABLE") ? ["EXECUTABLE_AVAILABILITY_UNAVAILABLE"] : []),
        ...(item.points.some(point => point.priceEffectiveAt === null) ? ["TARIFF_EFFECTIVE_TIME_UNKNOWN"] : [])] };
  });
  const eligible = offers.filter(value => value.inResearchCohort);
  const providers = [...new Set(offers.map(value => value.terms.provider))].sort().map(id => {
    const configured = registry.providers.find(value => value.id === id);
    const rights = configured?.rights;
    return { provider: id, economicGroup: configured?.economicGroup ?? null,
      ownershipVerification: "NOT_ESTABLISHED", collectionConfigured: rights?.collect ?? false,
      redistributionConfigured: rights?.redistribute ?? false, derivationConfigured: rights?.derive ?? false,
      rightsEvidencePresent: Boolean(rights?.evidence.trim()), rightsExpired: rights?.expiresAt !== null && rights?.expiresAt !== undefined && rights.expiresAt <= study.asOf,
      derivativesRightsReview: "NOT_ESTABLISHED", eligibleSeries: eligible.filter(value => value.terms.provider === id).length };
  });
  const groups = [...new Set(eligible.flatMap(value => value.economicGroup === null ? [] : [value.economicGroup]))].sort();
  const comparabilityIssues = [
    ...(new Set(eligible.map(value => [...value.terms.includes].sort().join(","))).size > 1 ? ["BUNDLED_COMPONENTS_DIFFER"] : []),
    ...(new Set(eligible.map(value => value.terms.gpuCount)).size > 1 ? ["PHYSICAL_INSTANCE_SIZES_DIFFER"] : []),
    ...(hasInstanceResources && new Set(eligible.flatMap(value => value.terms.instanceResources
      ? [JSON.stringify(instanceResourceKey(value.terms.instanceResources))] : [])).size > 1 ? ["QUANTITATIVE_INSTANCE_RESOURCES_DIFFER"] : []),
    ...new Set(eligible.flatMap(value => value.unknowns)),
    ...(eligible.length ? ["LIST_TARIFFS_NOT_EXECUTED_TRANSACTIONS"] : ["NO_ELIGIBLE_B200_OFFERS"]),
  ].sort();
  const boundedScanComplete = study.completeness.complete && !evidence.some(value => value.reasons.some(reason => reason.includes("LIMIT")));
  const integrityPassed = observationCount > 0 && observationsReproduced === observationCount && evidence.every(value => !value.reasons.length) &&
    offers.every(value => !value.issues.length) && !Object.keys(study.anomalies.counts).length;
  return { schemaVersion: 1, kind: "B200_RETAINED_SOURCE_AUDIT", privacy: "PRIVATE_RETAINED_DATA", asOf: study.asOf,
    status: !boundedScanComplete ? "INCOMPLETE" : !observationCount && !Object.keys(study.anomalies.counts).length ? "NO_B200_DATA" : integrityPassed ? "LOCAL_REPLAY_PASSED" : "LOCAL_REPLAY_FAILED",
    publishable: false, liveMarketQualified: false, methodologyHash: hash(methodology), registryHash: hash(registry), studyHash: hash(study),
    window: study.window, cadence: study.cadence, captureErrors: study.observations.errorCount, anomalies: study.anomalies.counts, sustainedOperation: study.proposedThirtyDayStudy,
    completeness: { boundedScanComplete, study: study.completeness, limits: { evidenceRecords: limitRecords, evidenceBytes: limitBytes, bodyBytes: SOURCE_AUDIT_LIMITS.bodyBytes }, bytesRead },
    summary: { observationCount, observationsReproduced, evidenceRecords: evidence.length, evidenceHashesVerified: evidence.filter(value => value.contentHashVerified).length,
      eligibleSeries: eligible.length, configuredEconomicGroupsObserved: groups.length, independentlyVerifiedEconomicGroups: null, requiredProductionGroups: methodology.minProviderGroups },
    providers, groups, offers, comparabilityIssues, evidence,
    limitations: ["Local byte integrity and reproduction through the current Oracle/Verda/Runpod collectors; not provider authentication, TLS attestation or an independent hardware/terms review.",
      "Only referenced B200 response bodies are replayed. Other collector requests return local 404 responses and never contact a service. Unsupported sources remain unverified.",
      "Runpod replay uses a fixed offline placeholder and the credential-free canonical GraphQL URL. Retained response bytes do not attest the original request query, account entitlements or public-price applicability.",
      ...(evidence.some(value => value.source === lambda.id) ? ["Lambda replay uses the current collector with a fixed offline Bearer placeholder and the exact instance-types URL. It reproduces retained response fields only: original account entitlements, public-price applicability, physical exclusivity, topology and full bundle semantics are not independently verified."] : []),
      ...(lambdaResourceDigests.size ? ["Explicit Lambda instance-resource observations replay the documented whole-instance vCPU and GiB fields separately from legacy observations. This does not establish physical CPU counts, storage type/performance, HGX topology or bill completeness."] : []),
      "Body hashes are deduplicated by the journal. An unchanged body can reproduce later observations, but its first archive timestamp does not prove each later retrieval occurred.",
      "Registry economic groups and rights flags are operator assertions. Legal entity independence, financial-reference rights, weights, comparability and Pyth/venue acceptance remain unestablished.",
      "No approval, production setting, remote resource, signing identity or source journal is modified."] };
}
