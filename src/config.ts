import { z } from "zod";
import { collectorCatalog } from "./collectors";
import type { Methodology, Registry } from "./types";
import { peerUrl } from "./network";

export const nodeConfigSchema=z.strictObject({
  schemaVersion:z.literal(1),network:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  identityPath:z.string().min(1),databasePath:z.string().min(1),registryPath:z.string().min(1),methodologyPath:z.string().min(1),
  host:z.string().min(1),port:z.number().int().min(0).max(65535),
  intervalMs:z.number().int().min(30000).max(86400000),collectors:z.array(z.string()).max(100),peers:z.array(z.string()).max(32),allowLoopbackPeers:z.boolean(),
  pythManifestPath:z.string().min(1).optional(),
});
export type NodeConfig=z.infer<typeof nodeConfigSchema>;
export function parseConfig(raw:unknown):NodeConfig {
  const value=nodeConfigSchema.parse(raw);
  for(const id of value.collectors)if(!collectorCatalog.some(c=>c.id===id))throw new Error(`Unknown collector ${id}`);
  for(const peer of value.peers)peerUrl(peer,value.allowLoopbackPeers);
  return value;
}
export function defaultRegistry(network:string):Registry {
  const definitions=[
    {id:"oracle",economicGroup:"oracle",allowedHosts:["apexapps.oracle.com"],sources:["oracle-public"]},
    {id:"azure",economicGroup:"microsoft",allowedHosts:["prices.azure.com"],sources:["azure-retail"]},
    {id:"lambda",economicGroup:"lambda",allowedHosts:["cloud.lambda.ai"],sources:["lambda-cloud"]},
    {id:"runpod",economicGroup:"runpod",allowedHosts:["api.runpod.io"],sources:["runpod-secure"]},
    {id:"vast",economicGroup:"vast",allowedHosts:["console.vast.ai"],sources:["vast-offers"]},
    {id:"aws",economicGroup:"amazon",allowedHosts:["api.pricing.us-east-1.amazonaws.com"],sources:["aws-pricing"]},
    {id:"google",economicGroup:"google",allowedHosts:["cloudbilling.googleapis.com"],sources:["google-billing"]},
    {id:"verda",economicGroup:"verda",allowedHosts:["api.verda.com"],sources:["verda-public"]},
    {id:"hyperstack",economicGroup:"nexgencloud",allowedHosts:["infrahub-api.nexgencloud.com"],sources:["hyperstack-pricebook"]},
    {id:"shadeform",economicGroup:"shadeform",allowedHosts:["api.shadeform.ai"],sources:["shadeform-instances"]},
  ];
  return {schemaVersion:1,network,version:"0.2.0-draft",operators:[],providers:definitions.map(p=>({...p,rights:{collect:["oracle","azure","verda"].includes(p.id),redistribute:false,derive:false,evidence:"",expiresAt:null}}))};
}
export function defaultMethodology():Methodology {
  return {schemaVersion:1,version:"0.1.0-draft",status:"DRAFT",effectiveAt:1788652800000,
    cohort:{procurement:"ON_DEMAND",priceBasis:"LIST",tenancy:"EXCLUSIVE",regions:["*"]},
    maxAgeMs:900000,futureToleranceMs:10000,minOperatorGroups:3,minProviderGroups:3,maxCollectorDeviationBps:100,maxProviderDispersionBps:15000,
    providerWeights:{B200:{},B300:{},GB200:{},GB300:{}},modelWeights:{B200:1,B300:1,GB200:1,GB300:1},
    weightEvidence:"Research choice: equal weight across four product-family rental rates. Provider weights require verified independent sources. No measured fleet or transaction volume is claimed."};
}
