import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { defaultRegistry } from "../src/config";
import { demoRegistry } from "../src/demo";
import { runtimeConfig, type WorkerEnvironment } from "../src/cloudflare/config";

const env = { SBX_NETWORK: "test", SBX_OPERATOR_GROUP: "test", SBX_COLLECTORS: "runpod-secure,hyperstack-pricebook,aws-pricing", SBX_COLLECTION_INTERVAL_MS: "300000" } as WorkerEnvironment;
test("hosted collection permission does not open governed publication", () => {
  const registry = runtimeConfig(env).registry;
  const demo = demoRegistry(registry);
  for (const id of ["runpod", "hyperstack", "aws"]) {
    const rights = registry.providers.find(p => p.id === id)!.rights;
    expect(rights.collect).toBe(true);
    expect(rights.derive).toBe(false);
    expect(rights.redistribute).toBe(false);
    expect(demo.providers.find(p => p.id === id)!.rights.derive).toBe(true);
  }
});
test("explicit registry collection denials remain authoritative", () => {
  const registry = defaultRegistry("test");
  for (const p of registry.providers) p.rights.collect = false;
  const config = runtimeConfig({ ...env, SBX_REGISTRY_JSON: JSON.stringify(registry) });
  expect(demoRegistry(config.registry).providers.every(p => !p.rights.collect)).toBe(true);
});
test("Providers remains a page but is absent from all main navigation", () => {
  for (const page of ["index", "providers", "methodology"]) {
    const html = readFileSync(new URL("../public/" + page + ".html", import.meta.url), "utf8");
    expect(html.match(/<nav\b[\s\S]*?<\/nav>/g)?.join("")).not.toContain("/providers.html");
    if (page === "providers") expect(html).toContain("Providers");
  }
});
