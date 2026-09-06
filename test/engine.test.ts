import { describe, test, expect } from "bun:test";
import { calculate } from "../src/engine";
import { signBatch, generateIdentity, hash, verifyBatch } from "../src/crypto";
import { fromMicros, toMicros, normalizeInstance } from "../src/decimal";
import { observationSchema, parseRegistry, parseMethodology } from "../src/validation";
import { environment, NOW } from "./helpers";

describe("fixed-weight Blackwell benchmark",()=>{
  test("independent arithmetic covers every provider, model and composite",()=>{
    const e=environment(),s=calculate(e.batches,e.registry,e.methodology,NOW);
    expect(s.publishable).toBe(true);
    expect(s.feeds.filter(f=>f.kind==="PROVIDER"&&f.status==="READY")).toHaveLength(12);
    // Independent calculation: (2 + 3 + 2*4)/4 = 3.25, then + model index.
    for(let i=0;i<4;i++)expect(s.feeds.filter(f=>f.kind==="MODEL")[i]!.price).toBe((3.25+i).toFixed(6));
    expect(s.feeds.find(f=>f.id==="SBX")!.price).toBe("4.750000");
    expect(s.feeds.find(f=>f.id==="SBX")!.observedAt).toBe(NOW-1000);
    expect(hash(calculate([...e.batches].reverse(),e.registry,e.methodology,NOW))).toBe(hash(s));
  });
  test("a missing provider does not change weights",()=>{
    const e=environment();
    const batches=e.batches.map((b,i)=>signBatch({...b.payload,observations:b.payload.observations.filter(o=>o.provider!=="gamma")},e.identities[i]!));
    const s=calculate(batches,e.registry,e.methodology,NOW);
    expect(s.publishable).toBe(false);expect(s.feeds.find(f=>f.id==="SBX:B200")!.price).toBeNull();
    expect(s.feeds.find(f=>f.id==="SBX:B200")!.reasons).toContain("MISSING_FIXED_WEIGHT_CONSTITUENT");
    expect(s.feeds.find(f=>f.id==="SBX:alpha:B200")!.price).toBe("2.000000");
  });
  test("missing one model cannot be substituted with another",()=>{
    const e=environment();
    const batches=e.batches.map((b,i)=>signBatch({...b.payload,observations:b.payload.observations.filter(o=>o.model!=="GB300")},e.identities[i]!));
    const s=calculate(batches,e.registry,e.methodology,NOW);
    expect(s.feeds.find(f=>f.id==="SBX:B200")!.status).toBe("READY");
    expect(s.feeds.find(f=>f.id==="SBX")!.price).toBeNull();
  });
  test("extra keys in one operator group do not create quorum",()=>{
    const e=environment(),extra=generateIdentity();
    e.registry.operators.push({nodeId:extra.nodeId,publicKey:extra.publicKey,operatorGroup:"operator-0",enabled:true});
    const b=signBatch({...e.batches[0]!.payload,nodeId:extra.nodeId,publicKey:extra.publicKey},extra);
    expect(calculate([e.batches[0]!,e.batches[1]!,b],e.registry,e.methodology,NOW).publishable).toBe(false);
  });
  test("self-generated identities cannot influence the network",()=>{
    const e=environment(),extra=generateIdentity();
    const b=signBatch({...e.batches[0]!.payload,nodeId:extra.nodeId,publicKey:extra.publicKey},extra);
    const s=calculate([e.batches[0]!,e.batches[1]!,b],e.registry,e.methodology,NOW);
    expect(s.publishable).toBe(false);expect(s.rejected[0]!.reason).toBe("UNTRUSTED_OPERATOR_OR_NETWORK");
  });
  test("old catalog effective date remains valid after fresh retrieval",()=>{
    const e=environment();expect(calculate(e.batches,e.registry,e.methodology,NOW).publishable).toBe(true);
    expect(calculate(e.batches,e.registry,e.methodology,NOW+e.methodology.maxAgeMs+1001).publishable).toBe(false);
  });
  test.each(["SPOT","RESERVED","CAPACITY_BLOCK","SCHEDULED"] as const)("%s quotes never enter on-demand basket",term=>{
    const e=environment();const bs=e.batches.map((b,i)=>signBatch({...b.payload,observations:b.payload.observations.map(o=>({...o,procurement:term}))},e.identities[i]!));
    expect(calculate(bs,e.registry,e.methodology,NOW).publishable).toBe(false);
  });
  test("account-specific rates cannot become public list index",()=>{
    const e=environment();const bs=e.batches.map((b,i)=>signBatch({...b.payload,observations:b.payload.observations.map(o=>({...o,priceScope:"ACCOUNT_SPECIFIC" as const}))},e.identities[i]!));
    expect(calculate(bs,e.registry,e.methodology,NOW).publishable).toBe(false);
  });
  test("rights expiration prevents use of otherwise valid quotes",()=>{
    const e=environment();e.registry.providers[0]!.rights.expiresAt=NOW;
    expect(calculate(e.batches,e.registry,e.methodology,NOW).publishable).toBe(false);
  });
  test("deviation and future timestamps fail closed",()=>{
    const e=environment();const bs=e.batches.map((b,i)=>signBatch({...b.payload,observations:b.payload.observations.map(o=>i===0?{...o,price:"500",instancePrice:"4000"}:o)},e.identities[i]!));
    expect(calculate(bs,e.registry,e.methodology,NOW).publishable).toBe(false);
    const future=e.batches.map((b,i)=>signBatch({...b.payload,createdAt:NOW+60000},e.identities[i]!));
    expect(calculate(future,e.registry,e.methodology,NOW).rejected).toHaveLength(3);
  });
  test("draft methodology may calculate research values but cannot publish",()=>{
    const e=environment();e.methodology.status="DRAFT";
    expect(calculate(e.batches,e.registry,e.methodology,NOW).publishable).toBe(false);
  });
  test("effective date must have arrived",()=>{
    const e=environment();e.methodology.effectiveAt=NOW+10000;
    const s=calculate(e.batches,e.registry,e.methodology,NOW);expect(s.feeds.every(f=>f.price===null)).toBe(true);
  });
});
describe("validation and exact money",()=>{
  test("normalizes an eight-GPU instance exactly",()=>{expect(normalizeInstance("108.16",4)).toBe("27.040000");expect(normalizeInstance("1",3)).toBe("0.333333");expect(fromMicros(toMicros("1.23"))).toBe("1.230000");});
  test.each(["NaN","Infinity","-1","0","1e3","0.0000001","01"])("rejects invalid price %s",price=>{expect(()=>toMicros(price)).toThrow();});
  test("rejects wrong normalization and credentials in provenance URL",()=>{
    const e=environment();expect(observationSchema.safeParse({...e.observations[0],price:"9"}).success).toBe(false);
    expect(observationSchema.safeParse({...e.observations[0],sourceUrl:"https://alpha.example/prices?api_key=secret"}).success).toBe(false);
  });
  test("tampering fails cryptographic verification",()=>{
    const e=environment(),b=structuredClone(e.batches[0]!);expect(verifyBatch(b)).toBe(true);b.payload.sequence++;expect(verifyBatch(b)).toBe(false);
  });
  test("rejects duplicate provider identities and unconfigured approved weights",()=>{
    const e=environment();e.registry.providers.push(e.registry.providers[0]!);expect(()=>parseRegistry(e.registry)).toThrow();
    e.methodology.providerWeights.B200={};expect(()=>parseMethodology(e.methodology)).toThrow();
  });
});
