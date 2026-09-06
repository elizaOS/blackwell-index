import { fromMicros, normalizeInstance, toMicros } from "../decimal";
import { MODELS, type Collector, type CollectorResult, type GpuModel, type Procurement } from "../types";
import { array, CollectionError, decimal, failure, jsonRequest, object, positiveInteger, string } from "./http";

/** Public endpoint: the official OpenAPI explicitly sets security: [] for this GET. */
export const verda: Collector = {
  id: "verda-public", provider: "verda",
  async collect(context) {
    const result: CollectorResult = { observations: [], errors: [] };
    try {
      const response = await jsonRequest(context, this.id, new URL("https://api.verda.com/v1/instance-types?currency=usd"));
      const items = array(response.data).map(value => object(value)).filter(item => MODELS.includes(item.model as GpuModel));
      const skus = new Set<string>(), ids = new Set<string>();
      // Conflicting catalog rows are not independent observations; reject the whole ambiguous response.
      for (const item of items) {
        const sku = string(item.instance_type), id = string(item.id);
        if (skus.has(sku) || ids.has(id)) throw new CollectionError("DUPLICATE_SOURCE_RECORD", "verda catalog contains repeated SKU or record ID");
        skus.add(sku); ids.add(id);
      }
      for (const item of items) {
        try {
          const model = item.model as GpuModel, sku = string(item.instance_type), id = string(item.id);
          const gpu = object(item.gpu), gpuCount = positiveInteger(gpu.number_of_gpus, "gpu.number_of_gpus");
          const skuParts = /^([1-9]\d*)(GB300|GB200|B300|B200)\.([1-9]\d*)V$/.exec(sku);
          const description = /^([1-9]\d*)x (GB300|GB200|B300|B200)(?:\s|$)/.exec(string(gpu.description));
          const cpus = positiveInteger(object(item.cpu).number_of_cores, "cpu.number_of_cores");
          positiveInteger(object(item.memory).size_in_gigabytes, "memory.size_in_gigabytes");
          if (!skuParts || skuParts[2] !== model || Number(skuParts[1]) !== gpuCount || Number(skuParts[3]) !== cpus ||
              !description || description[2] !== model || Number(description[1]) !== gpuCount || item.manufacturer !== "NVIDIA") {
            throw new CollectionError("HARDWARE_MISMATCH", "verda SKU, model and physical hardware fields disagree");
          }
          if (item.description !== "Dedicated Hardware Instance") throw new CollectionError("UNSUPPORTED_TENANCY", "verda instance is not explicitly dedicated");
          if (item.currency !== "usd") throw new CollectionError("UNSUPPORTED_CURRENCY", "verda catalog is not USD");
          const terms: {field:"price_per_hour"|"spot_price";procurement:Procurement}[] = [
            {field:"price_per_hour",procurement:"ON_DEMAND"}, {field:"spot_price",procurement:"SPOT"},
          ];
          for (const term of terms) {
            if (term.field === "spot_price" && (item.spot_price === null || item.spot_price === undefined)) continue;
            try {
              const instancePrice = fromMicros(toMicros(decimal(string(item[term.field], term.field))));
              result.observations.push({
                schemaVersion:1,provider:this.provider,source:this.id,sku,model,region:"unspecified",
                procurement:term.procurement,priceBasis:"LIST",priceScope:"PUBLIC",tenancy:"EXCLUSIVE",
                currency:"USD",unit:"USD_PER_GPU_HOUR",price:normalizeInstance(instancePrice,gpuCount),instancePrice,gpuCount,
                // Storage is dynamically provisioned and is not included in this catalog rate.
                includes:["gpu","cpu","memory"],availableGpuCount:null,availability:"UNKNOWN",topology:"UNKNOWN",
                minimumOrderGpuCount:gpuCount,sourceRecordId:`${id}:${term.field}`,
                observedAt:response.observedAt,priceEffectiveAt:null,expiresAt:null,sourceUrl:response.sourceUrl,evidenceHash:response.evidenceHash,
              });
            } catch (error) { result.errors.push(failure(error,this.id)); }
          }
        } catch (error) { result.errors.push(failure(error,this.id)); }
      }
      if (!result.observations.length && !result.errors.length) throw new CollectionError("NO_DATA", "verda has no supported Blackwell catalog prices");
    } catch (error) { result.errors.push(failure(error,this.id)); }
    return result;
  },
};
