import { GetProductsCommand, PricingClient } from "@aws-sdk/client-pricing";
import { fromMicros, normalizeInstance, toMicros } from "../decimal";
import type { Collector, CollectorResult, GpuModel, Procurement } from "../types";
import { array, CollectionError, decimal, failure, jsonRequest, object, string, timestamp } from "./http";

const ENDPOINT = "https://api.pricing.us-east-1.amazonaws.com";
interface SignedPricingRequest { protocol: string; hostname: string; path: string; port?: number; method: string; headers: Record<string, string>; body?: RequestInit["body"] }
export const AWS_INSTANCES: ReadonlyArray<{ sku: string; model: GpuModel; gpuCount: number }> = [
  { sku: "p6-b200.48xlarge", model: "B200", gpuCount: 8 },
  { sku: "p6-b300.48xlarge", model: "B300", gpuCount: 8 },
  { sku: "p6e-gb200.36xlarge", model: "GB200", gpuCount: 4 },
  { sku: "p6e-gb300.36xlarge", model: "GB300", gpuCount: 4 },
];

export const aws: Collector = {
  id: "aws-pricing", provider: "aws",
  async collect(context) {
    const accessKeyId = context.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = context.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId?.trim() || !secretAccessKey?.trim()) return { observations: [], errors: ["NO_KEY: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for aws-pricing; AWS_SESSION_TOKEN is required for temporary credentials"] };
    const result: CollectorResult = { observations: [], errors: [] };
    let lastResponse: Awaited<ReturnType<typeof jsonRequest>> | undefined;
    // Explicit credentials work in Node/Bun and Workers without filesystem or instance-metadata discovery.
    const client = new PricingClient({
      region: "us-east-1", endpoint: ENDPOINT, maxAttempts: 1,
      credentials: { accessKeyId, secretAccessKey, ...(context.env.AWS_SESSION_TOKEN ? { sessionToken: context.env.AWS_SESSION_TOKEN } : {}) },
      requestHandler: {
        metadata: { handlerProtocol: "http/1.1" },
        async handle(request: SignedPricingRequest) {
          if (request.protocol !== "https:" || request.hostname !== "api.pricing.us-east-1.amazonaws.com" || request.path !== "/" || request.port && request.port !== 443) throw new CollectionError("INVALID_ENDPOINT", "AWS signed pricing request changed origin");
          lastResponse = await jsonRequest(context, "aws-pricing", new URL(ENDPOINT), { method: request.method, headers: request.headers, ...(request.body !== undefined ? { body: request.body } : {}) });
          return { response: { statusCode: 200, headers: { "content-type": "application/x-amz-json-1.1" }, body: new TextEncoder().encode(JSON.stringify(lastResponse.data)) } };
        },
      },
    });
    try {
      for (const mapping of AWS_INSTANCES) {
        try {
          let token: string | undefined;
          const visited = new Set<string>();
          const observations = [];
          do {
            if (visited.has(token ?? "") || visited.size >= 100) throw new CollectionError("INVALID_PAGINATION", `AWS ${mapping.sku} pages repeated or exceed 100`);
            visited.add(token ?? ""); lastResponse = undefined;
            const response = await client.send(new GetProductsCommand({ ServiceCode: "AmazonEC2", FormatVersion: "aws_v1", MaxResults: 100, ...(token ? { NextToken: token } : {}), Filters: [
              { Type: "TERM_MATCH", Field: "instanceType", Value: mapping.sku },
              { Type: "TERM_MATCH", Field: "operatingSystem", Value: "Linux" },
              { Type: "TERM_MATCH", Field: "tenancy", Value: "Shared" },
              { Type: "TERM_MATCH", Field: "preInstalledSw", Value: "NA" },
            ] }));
            const evidence = lastResponse as Awaited<ReturnType<typeof jsonRequest>> | undefined;
            if (!evidence) throw new CollectionError("MISSING_EVIDENCE", "AWS raw response was not archived");
            // The SDK may expose PriceList as lazy decoded JSON wrappers. Parse the archived wire representation directly.
            for (const serialized of array(object(evidence.data).PriceList ?? [])) {
              const item = object(JSON.parse(string(serialized, "PriceList item")));
              const product = object(item.product); const attrs = object(product.attributes);
              if (attrs.instanceType !== mapping.sku || attrs.operatingSystem !== "Linux" || attrs.tenancy !== "Shared" || attrs.preInstalledSw !== "NA") continue;
              if (attrs.gpu !== undefined && String(attrs.gpu) !== String(mapping.gpuCount)) throw new CollectionError("HARDWARE_MISMATCH", `AWS ${mapping.sku} GPU count changed`);
              const terms = object(item.terms);
              for (const [termKind, rawTerms] of Object.entries(terms)) {
                if (termKind !== "OnDemand" && termKind !== "CapacityBlock") continue;
                for (const [termId, rawTerm] of Object.entries(object(rawTerms))) {
                  const term = object(rawTerm);
                  const effectiveAt = timestamp(term.effectiveDate);
                  if (effectiveAt !== null && effectiveAt > evidence.observedAt) continue;
                  const dimensions = Object.values(object(term.priceDimensions)).map(value => object(value));
                  if (dimensions.length !== 1) throw new CollectionError("UNSUPPORTED_TIERS", `AWS ${mapping.sku}`);
                  const dimension = dimensions[0]!;
                  if (dimension.unit !== "Hrs" || dimension.beginRange !== "0" || dimension.endRange !== "Inf") throw new CollectionError("UNSUPPORTED_UNIT", `AWS ${mapping.sku} requires flat instance-hours`);
                  const instancePrice = fromMicros(toMicros(decimal(object(dimension.pricePerUnit).USD)));
                  const capacityBlock = termKind === "CapacityBlock" || attrs.marketoption === "CapacityBlock" || /capacity.?block/i.test(String(attrs.usagetype)) || /capacity block/i.test(String(dimension.description));
                  const procurement: Procurement = capacityBlock ? "CAPACITY_BLOCK" : "ON_DEMAND";
                  observations.push({
                    schemaVersion: 1 as const, provider: this.provider, source: this.id, sku: mapping.sku, model: mapping.model,
                    region: string(attrs.regionCode ?? attrs.location, "AWS region"), procurement, priceBasis: "LIST" as const, priceScope: "PUBLIC" as const, tenancy: "EXCLUSIVE" as const,
                    currency: "USD" as const, unit: "USD_PER_GPU_HOUR" as const, price: normalizeInstance(instancePrice, mapping.gpuCount), instancePrice, gpuCount: mapping.gpuCount,
                    includes: ["gpu", "cpu", "memory", "local-storage"], availableGpuCount: null, availability: "UNKNOWN" as const,
                    topology: mapping.model.startsWith("GB") ? "NVL72" as const : "HGX" as const, minimumOrderGpuCount: null, sourceRecordId: `${string(product.sku)}:${termId}`,
                    observedAt: evidence.observedAt, priceEffectiveAt: effectiveAt, expiresAt: null, sourceUrl: evidence.sourceUrl, evidenceHash: evidence.evidenceHash,
                  });
                }
              }
            }
            token = response.NextToken;
          } while (token);
          result.observations.push(...observations);
          if (!observations.length) result.errors.push(`NO_DATA: aws-pricing has no supported current public hourly price for ${mapping.sku}`);
        } catch (error) {
          result.errors.push(failure(error, this.id));
          if (error instanceof CollectionError && ["RATE_LIMITED", "HTTP_ERROR"].includes(error.code)) break;
        }
      }
    } finally { client.destroy(); }
    return result;
  },
};
