import { createHash } from "node:crypto";
import { fromMicros, normalizeInstance } from "../decimal";
import type { Collector, Observation } from "../types";
import { array, CollectionError, failure, jsonRequest, object, positiveInteger, string } from "./http";
import { blackwellModel } from "./models";

/** The API specifies cents, not an ISO currency. Review the account's billing currency first. */
export const SHADEFORM_CONFIGURATION_ENVS = ["SHADEFORM_BILLING_CURRENCY", "SHADEFORM_BILLING_EVIDENCE"];
export const shadeform: Collector = {
  id: "shadeform-instances", provider: "shadeform",
  async collect(context) {
    const key = context.env.SHADEFORM_API_KEY;
    if (!key?.trim()) return { observations: [], errors: ["NO_KEY: SHADEFORM_API_KEY is required for shadeform-instances"] };
    if (context.env.SHADEFORM_BILLING_CURRENCY !== "USD" || !context.env.SHADEFORM_BILLING_EVIDENCE?.trim()) {
      return { observations: [], errors: ["UNCONFIRMED_CURRENCY: Review Shadeform billing currency and configure SHADEFORM_BILLING_CURRENCY=USD with SHADEFORM_BILLING_EVIDENCE before collection"] };
    }
    try {
      const response = await jsonRequest(context, this.id, new URL("https://api.shadeform.ai/v1/instances/types"), { headers: { "X-API-KEY": key } });
      // This is an operator assertion, not a provider currency field. Bind its protected reference without disclosing it.
      const receipt = new TextEncoder().encode(JSON.stringify({ kind: "SHADEFORM_ACCOUNT_PRICE_NORMALIZATION_V1", currency: "USD", currencySource: "OPERATOR_REVIEWED_ACCOUNT_BILLING",
        billingEvidenceReferenceHash: createHash("sha256").update(context.env.SHADEFORM_BILLING_EVIDENCE!).digest("hex"),
        priceUnit: "INTEGER_CENTS_PER_INSTANCE_HOUR", input: { url: response.sourceUrl, evidenceHash: response.evidenceHash, observedAt: response.observedAt } }));
      const evidenceHash = createHash("sha256").update(receipt).digest("hex");
      const document = object(response.data);
      if (["next", "next_page", "next_cursor", "nextPageToken", "pagination"].some(name => document[name] != null && document[name] !== "") || document.has_more === true) throw new CollectionError("INCOMPLETE_COVERAGE", "Shadeform instance-types pagination is not documented");
      const observations: Observation[] = [], seen = new Map<string, string>();
      for (const value of array(document.instance_types)) {
        const instance = object(value), configuration = object(instance.configuration), model = blackwellModel(configuration.gpu_type);
        const shadeType = string(instance.shade_instance_type, "shade_instance_type"), cloudType = string(instance.cloud_instance_type, "cloud_instance_type");
        if (!model && !blackwellModel(cloudType) && !/^(?:B200|B300|GB200|GB300)(?:x\d+)?$/i.test(shadeType)) continue;
        // GB systems need verified topology, minimum-order and procurement mapping, not a marketing family substitution.
        if (model !== "B200" && model !== "B300") throw new CollectionError("UNSUPPORTED_MODEL", "Shadeform GB systems require reviewed system and procurement mapping");
        const standardized = /^(B200|B300)(?:x([1-9]\d*))?$/.exec(shadeType), gpuCount = positiveInteger(configuration.num_gpus, "configuration.num_gpus");
        const cloudModel = blackwellModel(cloudType);
        if (!standardized || standardized[1] !== model || (standardized[2] && Number(standardized[2]) !== gpuCount) || cloudModel && cloudModel !== model) throw new CollectionError("HARDWARE_MISMATCH", "Shadeform model names or GPU counts disagree");
        if (gpuCount > 100_000 || configuration.gpu_manufacturer !== "nvidia") throw new CollectionError("HARDWARE_MISMATCH", "Unsupported physical GPU specification");
        if (!["vm", "baremetal"].includes(String(instance.deployment_type))) throw new CollectionError("UNVERIFIED_TENANCY", "Only documented whole-GPU VM or bare-metal instance types are supported");
        if (instance.currency !== undefined && instance.currency !== "USD") throw new CollectionError("UNSUPPORTED_CURRENCY", "Shadeform response contradicts reviewed USD billing");
        if (instance.hourly_price_unit !== undefined || instance.unit !== undefined) throw new CollectionError("UNSUPPORTED_UNIT", "Shadeform added undocumented price-unit metadata");
        if (instance.procurement !== undefined || instance.pricing_type !== undefined || instance.is_spot === true || instance.reserved === true) throw new CollectionError("UNSUPPORTED_TERMS", "Shadeform returned procurement metadata requiring review");
        const cloud = string(instance.cloud, "cloud");
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(cloud)) throw new CollectionError("INVALID_SCHEMA", "Unsupported underlying-cloud identifier");
        const sku = `${cloud}:${shadeType}:${cloudType}`;
        if (sku.length > 200) throw new CollectionError("INVALID_SCHEMA", "Shadeform instance identifier exceeds canonical limit");
        positiveInteger(configuration.memory_in_gb, "configuration.memory_in_gb"); positiveInteger(configuration.vcpus, "configuration.vcpus");
        positiveInteger(configuration.storage_in_gb, "configuration.storage_in_gb"); positiveInteger(configuration.vram_per_gpu_in_gb, "configuration.vram_per_gpu_in_gb");
        const cents = positiveInteger(instance.hourly_price, "hourly_price (integer cents per instance-hour)"), instancePrice = fromMicros(BigInt(cents) * 10_000n);
        const availability = array(instance.availability);
        if (!availability.length) throw new CollectionError("INCOMPLETE_DATA", "Shadeform instance has no regional availability records");
        for (const item of availability) {
          const regional = object(item), region = string(regional.region, "availability.region");
          if (typeof regional.available !== "boolean") throw new CollectionError("INVALID_SCHEMA", "Shadeform availability must be explicit");
          const observation: Observation = { schemaVersion: 1, provider: this.provider, source: this.id, sku, model, region,
            procurement: "ON_DEMAND", priceBasis: "LIST", priceScope: "ACCOUNT_SPECIFIC", tenancy: "EXCLUSIVE", currency: "USD", unit: "USD_PER_GPU_HOUR",
            price: normalizeInstance(instancePrice, gpuCount), instancePrice, gpuCount,
            includes: ["gpu", "cpu", "memory", "storage", "reseller:shadeform", `upstream-cloud:${cloud}`],
            availableGpuCount: null, availability: regional.available ? "AVAILABLE" : "UNAVAILABLE", topology: "UNKNOWN", minimumOrderGpuCount: gpuCount,
            sourceRecordId: `cloud:${cloud}:type:${cloudType}`, observedAt: response.observedAt, priceEffectiveAt: null, expiresAt: null,
            sourceUrl: response.sourceUrl, evidenceHash };
          const identity = `${sku}\n${region}`, fingerprint = JSON.stringify(observation), previous = seen.get(identity);
          if (previous !== undefined && previous !== fingerprint) throw new CollectionError("AMBIGUOUS_PRICE", "Duplicate Shadeform regional instance disagrees");
          if (previous !== undefined) continue;
          seen.set(identity, fingerprint); observations.push(observation);
        }
      }
      if (!observations.length) throw new CollectionError("NO_DATA", "Shadeform returned no supported Blackwell instance types");
      if (observations.length > 2000) throw new CollectionError("INCOMPLETE_COVERAGE", "Shadeform output exceeds the canonical batch limit");
      await context.archive({ hash: evidenceHash, source: this.id, url: response.sourceUrl, receivedAt: context.now(), contentType: "application/vnd.sbx.account-price-normalization+json", body: receipt });
      return { observations, errors: [] };
    } catch (error) { return { observations: [], errors: [failure(error, this.id)] }; }
  },
};
