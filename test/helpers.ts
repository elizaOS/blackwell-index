// Synthetic values exist only in tests; production code never imports this module.
import { generateIdentity, signBatch } from "../src/crypto";
import { defaultMethodology } from "../src/config";
import { MODELS, type Observation, type Registry, type Methodology } from "../src/types";
export const NOW=1788681600000;
export function environment() {
  const identities=Array.from({length:3},generateIdentity);
  const registry:Registry={schemaVersion:1,version:"test-v1",network:"sbx-test",operators:identities.map((k,i)=>({nodeId:k.nodeId,publicKey:k.publicKey,operatorGroup:`operator-${i}`,enabled:true})),
    providers:["alpha","beta","gamma"].map(id=>({id,economicGroup:id,allowedHosts:[`${id}.example`],sources:[`${id}-api`],rights:{collect:true,redistribute:true,derive:true,evidence:"Test-only permission",expiresAt:null}}))};
  const methodology:Methodology={...defaultMethodology(),status:"APPROVED",effectiveAt:NOW-10000,version:"test-v1",providerWeights:{B200:{alpha:1,beta:1,gamma:2},B300:{alpha:1,beta:1,gamma:2},GB200:{alpha:1,beta:1,gamma:2},GB300:{alpha:1,beta:1,gamma:2}}};
  const observations:Observation[]=registry.providers.flatMap((provider,p)=>MODELS.map((model,m)=>({schemaVersion:1,provider:provider.id,source:`${provider.id}-api`,sku:`sku-${model}`,model,region:"us-test",procurement:"ON_DEMAND",priceBasis:"LIST",tenancy:"EXCLUSIVE",currency:"USD",unit:"USD_PER_GPU_HOUR",price:String(2+p+m),instancePrice:String((2+p+m)*8),gpuCount:8,includes:["host"],availableGpuCount:null,observedAt:NOW-1000,priceEffectiveAt:NOW-86400000*30,expiresAt:null,sourceUrl:`https://${provider.id}.example/prices`,evidenceHash:"a".repeat(64)})));
  const batches=identities.map(identity=>signBatch({schemaVersion:1,network:registry.network,nodeId:identity.nodeId,publicKey:identity.publicKey,sequence:1,createdAt:NOW,observations:structuredClone(observations)},identity));
  return {identities,registry,methodology,observations,batches};
}
