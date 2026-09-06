import { allowedObservation } from "./engine";
import { hash } from "./crypto";
import { fromMicros, median, toMicros, weighted } from "./decimal";
import { MODELS, type Feed, type Methodology, type NodeIdentity, type Observation, type Registry, type Snapshot } from "./types";
import { observationSchema } from "./validation";

/** User-confirmed public demo approval, separate from oracle-network source admission. */
export function demoRegistry(registry: Registry): Registry {
  return {...registry,providers:registry.providers.map(p=>["oracle","azure","verda"].includes(p.id)?{...p,rights:{...p.rights,redistribute:true,derive:true,evidence:"Operator confirmed provider approval for public demo display and derivation on 2026-09-06"}}:p)};
}

export type DemoSnapshot = Snapshot & { mode: "CENTRALIZED_DEMO"; pythPublished: false };

/** Single-operator catalog view; never changes oracle quorum or publication policy. */
export function centralizedDemo(raw: unknown[], registry: Registry, methodology: Methodology, _identity: NodeIdentity, now: number): DemoSnapshot {
  const observations: Observation[] = raw.flatMap(value => {
    let parsed;
    try { parsed = observationSchema.safeParse(value); } catch { return []; }
    if(!parsed.success)return [];
    const o=Object.fromEntries(Object.entries(parsed.data).filter(([,value])=>value!==undefined)) as unknown as Observation;
    return allowedObservation(o,registry,now,"derive") && o.priceScope !== "ACCOUNT_SPECIFIC" && o.procurement === "ON_DEMAND" && o.priceBasis === "LIST" && o.tenancy === "EXCLUSIVE"
      && now-o.observedAt <= methodology.maxAgeMs && o.observedAt <= now+methodology.futureToleranceMs
      && (o.expiresAt === null || o.expiresAt > now) && (o.priceEffectiveAt === null || o.priceEffectiveAt <= o.observedAt+methodology.futureToleranceMs)
      && (methodology.cohort.regions.includes("*") || methodology.cohort.regions.includes(o.region)) ? [o] : [];
  });
  const feeds: Feed[]=[];
  const empty=(id:string,kind:Feed["kind"],model:Feed["model"],provider:string|null):Feed=>({id,kind,model,provider,status:"UNAVAILABLE",price:null,confidence:null,observedAt:null,calculatedAt:now,reasons:["NO_CURRENT_APPROVED_PRICE"],contributors:[],weights:{}});
  const fill=(feed:Feed,price:bigint,observedAt:number,contributors:string[])=>Object.assign(feed,{status:"READY",price:fromMicros(price),observedAt,reasons:[],contributors});
  for(const provider of registry.providers)for(const model of MODELS){
    const feed=empty(`SBX:${provider.id}:${model}`,"PROVIDER",model,provider.id);
    // Deduplicate exact commercial offers before taking regional medians.
    const unique=new Map<string,Observation>();
    for(const o of observations.filter(o=>o.provider===provider.id&&o.model===model)){
      const key=JSON.stringify([o.source,o.sku,o.region,o.gpuCount,o.topology,o.minimumOrderGpuCount,[...o.includes].sort()]);
      const previous=unique.get(key);if(!previous||o.observedAt>previous.observedAt)unique.set(key,o);
    }
    const matches=[...unique.values()];
    if(matches.length){const regions=[...new Set(matches.map(o=>o.region))];
      const price=median(regions.map(region=>median(matches.filter(o=>o.region===region).map(o=>toMicros(o.price)))));
      fill(feed,price,Math.min(...matches.map(o=>o.observedAt)),[provider.id]);
    }
    feeds.push(feed);
  }
  for(const model of MODELS){
    const feed=empty(`SBX:${model}`,"MODEL",model,null);
    const providers=feeds.filter(f=>f.kind==="PROVIDER"&&f.model===model&&f.status==="READY");
    const groups=[...new Set(providers.map(f=>registry.providers.find(p=>p.id===f.provider)!.economicGroup))];
    if(groups.length){const inputs=groups.map(group=>({price:median(providers.filter(f=>registry.providers.find(p=>p.id===f.provider)!.economicGroup===group).map(f=>toMicros(f.price!))),weight:1}));
      fill(feed,weighted(inputs),Math.min(...providers.map(f=>f.observedAt!)),groups);
      feed.weights=Object.fromEntries(groups.map(group=>[group,1]));
    }
    feeds.push(feed);
  }
  const composite=empty("SBX","COMPOSITE",null,null);composite.weights={B200:1,B300:1,GB200:1,GB300:1};
  const models=feeds.filter(f=>f.kind==="MODEL");
  if(models.every(f=>f.status==="READY"))fill(composite,weighted(models.map(f=>({price:toMicros(f.price!),weight:1}))),Math.min(...models.map(f=>f.observedAt!)),models.map(f=>f.id));
  feeds.push(composite);
  return {schemaVersion:1,network:registry.network,calculatedAt:now,methodologyVersion:`${methodology.version}-centralized-demo`,methodologyHash:hash({basis:methodology,mode:"CENTRALIZED_DEMO",weights:"equal available provider groups; equal four models"}),registryHash:hash(registry),publishable:false,mode:"CENTRALIZED_DEMO",pythPublished:false,feeds,inputBatchHashes:[],rejected:[]};
}
