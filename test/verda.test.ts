// Synthetic records are confined to tests; the production adapter contains no price fixtures.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { verda } from "../src/collectors/verda";
import type { CollectorContext, EvidenceRecord, GpuModel } from "../src/types";
import { observationSchema } from "../src/validation";

function row(model:GpuModel="B200",gpus=8) {
  return {id:`test-${model}-${gpus}`,model,instance_type:`${gpus}${model}.${gpus*30}V`,description:"Dedicated Hardware Instance",
    manufacturer:"NVIDIA",cpu:{number_of_cores:gpus*30},memory:{size_in_gigabytes:gpus*170},gpu:{number_of_gpus:gpus,description:`${gpus}x ${model} SXM6`},
    price_per_hour:"32.00",spot_price:"12.00",dynamic_price:"1.00",currency:"usd",storage:{description:"dynamic"},supported_os:[]};
}
function context(data:unknown,status=200) {
  const body=JSON.stringify(data),evidence:EvidenceRecord[]=[],requests:{url:string;authorization:string|null}[]=[];
  const ctx:CollectorContext={now:()=>1788681600000,env:{UNRELATED_API_KEY:"never-send"},
    fetch:async(input,init)=>{requests.push({url:input.toString(),authorization:new Headers(init?.headers).get("authorization")});return new Response(body,{status,headers:{"content-type":"application/json"}});},
    archive:async(record)=>{evidence.push(record);}};
  return {ctx,evidence,requests,body};
}

describe("Verda public catalog",()=>{
  test("normalizes physical GPU counts once and preserves separate procurement terms",async()=>{
    const {ctx,evidence,requests,body}=context([row("B200",8),row("B300",4),row("GB200",4),row("GB300",2)]);
    const result=await verda.collect(ctx);
    expect(result.errors).toEqual([]);
    expect(result.observations.map(o=>[o.model,o.gpuCount,o.procurement,o.price])).toEqual([
      ["B200",8,"ON_DEMAND","4.000000"],["B200",8,"SPOT","1.500000"],
      ["B300",4,"ON_DEMAND","8.000000"],["B300",4,"SPOT","3.000000"],
      ["GB200",4,"ON_DEMAND","8.000000"],["GB200",4,"SPOT","3.000000"],
      ["GB300",2,"ON_DEMAND","16.000000"],["GB300",2,"SPOT","6.000000"],
    ]);
    expect(requests).toEqual([{url:"https://api.verda.com/v1/instance-types?currency=usd",authorization:null}]);
    expect(evidence).toHaveLength(1);
    expect(new TextDecoder().decode(evidence[0]!.body)).toBe(body);
    expect(evidence[0]!.hash).toBe(createHash("sha256").update(body).digest("hex"));
    for(const observation of result.observations){
      observationSchema.parse(observation);
      expect(observation).toMatchObject({priceScope:"PUBLIC",region:"unspecified",availability:"UNKNOWN",availableGpuCount:null,topology:"UNKNOWN",priceEffectiveAt:null,includes:["gpu","cpu","memory"]});
      expect(observation.minimumOrderGpuCount).toBe(observation.gpuCount);
    }
  });
  test("ignores other generations, confidential variants and substring lookalikes",async()=>{
    const rows=[{...row(),model:"H200"},{...row(),model:"B200 CC"},{...row(),model:"GB300-preview"},{...row(),model:"RTX PRO 6000"}];
    const result=await verda.collect(context(rows).ctx);
    expect(result.observations).toEqual([]);expect(result.errors[0]).toContain("NO_DATA");
  });
  test("rejects mismatched hardware, tenancy and currency",async()=>{
    for(const change of [{gpu:{number_of_gpus:4,description:"4x B200 SXM6"}},{gpu:{number_of_gpus:8,description:"8x GB200 SXM6"}},
      {model:"GB200"},{cpu:{number_of_cores:1}},{manufacturer:"Unknown"},{description:"Shared Hardware Instance"},{currency:"eur"}]){
      const result=await verda.collect(context([{...row(),...change}]).ctx);
      expect(result.observations).toEqual([]);expect(result.errors).toHaveLength(1);
    }
  });
  test("duplicate SKU or source IDs invalidate the complete catalog",async()=>{
    for(const second of [{...row(),id:"other",price_per_hour:"99"},{...row("B300"),id:row().id}]){
      const result=await verda.collect(context([row(),second]).ctx);
      expect(result.observations).toEqual([]);expect(result.errors[0]).toContain("DUPLICATE_SOURCE_RECORD");
    }
  });
  test("missing, zero, negative and malformed prices never become observations",async()=>{
    for(const price of [undefined,null,"0","-1","NaN","","0.0000001",23]){
      const result=await verda.collect(context([{...row(),price_per_hour:price,spot_price:null}]).ctx);
      expect(result.observations).toEqual([]);expect(result.errors).toHaveLength(1);
    }
  });
  test("absent spot is not zero and deprecated dynamic prices are not a fallback",async()=>{
    const result=await verda.collect(context([{...row(),spot_price:null,dynamic_price:"0.01"}]).ctx);
    expect(result.errors).toEqual([]);expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.procurement).toBe("ON_DEMAND");expect(result.observations[0]!.price).toBe("4.000000");
  });
  test("an invalid spot quote does not replace the valid on-demand quote",async()=>{
    const result=await verda.collect(context([{...row(),spot_price:"0"}]).ctx);
    expect(result.observations).toHaveLength(1);expect(result.errors[0]).toContain("INVALID_PRICE");
  });
  test("unsupported response shape and missing inventory remain explicit",async()=>{
    const wrong=await verda.collect(context({items:[row()]}).ctx);
    expect(wrong.observations).toEqual([]);expect(wrong.errors[0]).toContain("INVALID_SCHEMA");
    const empty=await verda.collect(context([]).ctx);
    expect(empty.observations).toEqual([]);expect(empty.errors[0]).toContain("NO_DATA");
  });
  test("HTTP failures archive no fabricated evidence or prices",async()=>{
    const {ctx,evidence}=context({error:"rate limit"},429),result=await verda.collect(ctx);
    expect(result.observations).toEqual([]);expect(evidence).toEqual([]);expect(result.errors[0]).toContain("RATE_LIMITED");
  });
  test("failed evidence persistence prevents observation publication",async()=>{
    const {ctx}=context([row()]);ctx.archive=async()=>{throw new Error("storage unavailable");};
    const result=await verda.collect(ctx);
    expect(result.observations).toEqual([]);expect(result.errors[0]).toContain("COLLECTION_FAILED");
  });
});
