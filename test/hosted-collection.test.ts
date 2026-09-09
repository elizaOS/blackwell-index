import { expect, spyOn, test } from "bun:test";
import { collectCycle } from "../src/cloudflare/collect";
import { defaultMethodology, defaultRegistry } from "../src/config";
import { generateIdentity } from "../src/crypto";
import { OracleNode } from "../src/network";
import { Store } from "../src/store";
import { verda } from "../src/collectors/verda";
import { observationSchema } from "../src/validation";
import { environment, NOW } from "./helpers";

// Isolated synthetic responses verify the hosted orchestration; no provider calls.
function interceptFetch(handler: () => Promise<Response>) {
  return spyOn(globalThis,"fetch").mockImplementation(Object.assign(handler,{preconnect:globalThis.fetch.preconnect}));
}
function setup() {
  const store = new Store(":memory:"), registry = defaultRegistry("sbx-test"), methodology = defaultMethodology();
  const config = {network:"sbx-test",operatorGroup:"test-operator",intervalMs:300000,collectors:["verda-public"],registry,methodology,peers:[],credentials:{}};
  store.saveConfiguration(registry); store.saveConfiguration(methodology);
  const node = new OracleNode({identity:generateIdentity(),registry,methodology,store});
  return {store,node,config};
}

test("hosted cycle checks collection rights before fetching", async () => {
  const {store,node,config} = setup();
  config.registry.providers.find(provider => provider.id === "verda")!.rights.collect = false;
  const fetchMock = interceptFetch(async () => {throw new Error("Unapproved network request");});
  try {
    const cycle = await collectCycle(config,node,store);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cycle.sources).toEqual([{collector:"verda-public",status:"COLLECTION_NOT_APPROVED",observations:0,errors:0}]);
    expect(cycle.realObservationCount).toBe(0);
    expect(cycle.publishable).toBe(false);
    expect(store.counts().evidence).toBe(0);
  } finally {fetchMock.mockRestore();store.close();}
});

test("hosted cycle honors persisted 429 and 503 backoff between captures", async () => {
  for (const status of [429,503]) {
    const {store,node,config} = setup();
    const fetchMock = interceptFetch(async () => new Response("private-test-body",{status,headers:{"retry-after":"600"}}));
    try {
      const first = await collectCycle(config,node,store), second = await collectCycle(config,node,store);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(first.sources[0]).toMatchObject({collector:"verda-public",status:"DEGRADED",observations:0,errors:1});
      expect(first.sources[0]!.schedule).toMatchObject({eligible:false,code:`HTTP_${status}_BACKOFF`,failures:1});
      expect(second.sources[0]).toMatchObject({collector:"verda-public",status:"BACKOFF",observations:0,errors:0});
      expect(second.sources[0]!.schedule!.nextAttemptAt).toBe(first.sources[0]!.schedule!.nextAttemptAt);
      expect(JSON.stringify([first,second])).not.toContain("private-test-body");
      expect(store.counts()).toMatchObject({captures:2,snapshots:2,evidence:0,reports:0});
      expect((await node.handle(new Request("https://node.example/v1/ready"))).status).toBe(503);
    } finally {fetchMock.mockRestore();store.close();}
  }
});

test("hosted catalog capture remains private without benchmark and redistribution rights", async () => {
  const {store,node,config} = setup();
  const fixture = [{id:"synthetic-b200",model:"B200",instance_type:"1B200.30V",description:"Dedicated Hardware Instance",manufacturer:"NVIDIA",
    cpu:{number_of_cores:30},memory:{size_in_gigabytes:170},gpu:{number_of_gpus:1,description:"1x B200 SXM6"},currency:"usd",price_per_hour:"4.00",spot_price:"2.00"}];
  const fetchMock = interceptFetch(async () => Response.json(fixture));
  try {
    const cycle = await collectCycle(config,node,store);
    expect(cycle.realObservationCount).toBe(2);
    expect(cycle.sharedObservationCount).toBe(0);
    expect(cycle.publishable).toBe(false);
    expect(cycle.sources[0]).toMatchObject({status:"COLLECTED",observations:2,errors:0});
    expect(store.counts()).toMatchObject({captures:1,evidence:1,reports:0,snapshots:1});
    const reports = await (await node.handle(new Request("https://node.example/v1/reports"))).json() as {reports:unknown[]};
    expect(reports.reports).toEqual([]);
    const snapshot = node.snapshot();
    expect(snapshot.feeds.every(feed => feed.price === null)).toBe(true);
    expect((await node.handle(new Request("https://node.example/v1/ready"))).status).toBe(503);
  } finally {fetchMock.mockRestore();store.close();}
});


test("hosted collection stops at the exact rights expiry boundary", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(NOW);
  const fetchMock = interceptFetch(async () => { throw new Error("Expired source requested"); });
  const {store, node, config} = setup();
  config.registry.providers.find(p => p.id === "verda")!.rights.expiresAt = NOW;
  try {
    expect((await collectCycle(config, node, store)).sources[0]!.status).toBe("COLLECTION_NOT_APPROVED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.counts().evidence).toBe(0);
  } finally { fetchMock.mockRestore(); clock.mockRestore(); store.close(); }
});

test("malformed decimal does not abort valid neighbors or leak hosted diagnostics", async () => {
  const valid = {...environment().observations[0]!, provider:"verda", source:verda.id, sourceUrl:"https://api.verda.com/v1/instance-types"};
  const malformed = {...valid, price:"PRIVATE_INVALID_DECIMAL"};
  expect(() => observationSchema.safeParse(malformed)).not.toThrow();
  expect(observationSchema.safeParse(malformed).success).toBe(false);
  const collector = spyOn(verda, "collect").mockResolvedValue({observations:[malformed, valid], errors:["PROVIDER_ERROR: PRIVATE_PROVIDER_DETAIL"]});
  const {store, node, config} = setup();
  try {
    const cycle = await collectCycle(config, node, store);
    expect(cycle.sources[0]).toMatchObject({status:"DEGRADED", observations:1, errors:2, errorCodes:["PROVIDER_ERROR"]});
    expect(JSON.stringify(cycle)).not.toContain("PRIVATE_");
    const capture = store.db.query("SELECT observations, errors FROM captures").get() as {observations:string;errors:string};
    expect(JSON.parse(capture.observations)).toEqual([valid]);
    expect(capture.errors).not.toContain("PRIVATE_");
  } finally { collector.mockRestore(); store.close(); }
});
