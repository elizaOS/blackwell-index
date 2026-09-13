import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { publicPrice, limitPriceRequest } from "../src/cloudflare/public-price";
import { centralizedDemo, demoRegistry } from "../src/demo";
import { defaultMethodology, defaultRegistry } from "../src/config";
import { generateIdentity } from "../src/crypto";

test("price projection returns only the composite, including honest unavailability", () => {
  const snapshot = centralizedDemo([], demoRegistry(defaultRegistry("test")), defaultMethodology(), generateIdentity(), Date.now());
  expect(publicPrice(snapshot)).toEqual({ price: null });
  const composite = snapshot.feeds.find(f => f.id === "SBX")!;
  Object.assign(composite, { status: "READY", price: "12.340000" });
  expect(publicPrice(snapshot)).toEqual({ price: "12.340000" });
  composite.status = "UNAVAILABLE";
  expect(publicPrice(snapshot)).toEqual({ price: null });
});

test("edge limiter uses only trusted IP, not aliases, query parameters or spoofed forwarding headers", async () => {
  const keys: string[] = [];
  const limiter = { limit: async ({key}: {key: string}) => { keys.push(key); return { success: keys.length <= 1 }; } };
  const headers = { "CF-Connecting-IP": "192.0.2.1", "X-Forwarded-For": "spoofed", "x-sbx-client-ip": "spoofed" };
  expect(await limitPriceRequest(new Request("https://blackwellindex.com/v1/price", {headers}), limiter)).toBeNull();
  const denied = await limitPriceRequest(new Request("https://secondary.blackwellindex.com/node/primary/v1/price?bypass=1", {headers}), limiter);
  expect(denied!.status).toBe(429);
  expect(denied!.headers.get("retry-after")).toBe("60");
  expect(denied!.headers.get("cache-control")).toBe("no-store");
  expect(await denied!.text()).toBe('{"error":"RATE_LIMITED"}');
  expect(keys).toEqual(["sbx-price:192.0.2.1", "sbx-price:192.0.2.1"]);
});
test("limiter failure is closed and does not leak errors", async () => {
  const response = await limitPriceRequest(new Request("https://example.com/v1/price"), { limit: async () => { throw new Error("private"); } });
  expect(response!.status).toBe(503);
  expect(await response!.text()).toBe('{"error":"TEMPORARILY_UNAVAILABLE"}');
});
test("navigation links the compact API and omits Source code; availability copy is removed", () => {
  for (const page of ["index", "methodology", "providers"]) {
    const html = readFileSync(new URL("../public/" + page + ".html", import.meta.url), "utf8");
    const nav = html.match(/<nav\b[\s\S]*?<\/nav>/)![0];
    expect(nav).toContain('href="/v1/price"');
    expect(nav).not.toContain("Source code");
    expect(html).not.toContain("<h2>Availability</h2>");
    expect(html).not.toContain("A dash means no current qualifying price");
  }
});
