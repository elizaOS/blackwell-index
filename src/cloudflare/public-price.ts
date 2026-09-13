import type { DemoSnapshot } from "../demo";

/** Only the current centralized demo composite; never an oracle publication claim. */
export function publicPrice(snapshot: DemoSnapshot): { price: string | null } {
  const composite = snapshot.feeds.find(feed => feed.id === "SBX");
  return { price: composite?.status === "READY" ? composite.price : null };
}

/** Edge counters are shared by aliases, query strings and node paths. */
export async function limitPriceRequest(request: Request, limiter: RateLimit): Promise<Response | null> {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "retry-after": "60" };
  try {
    const { success } = await limiter.limit({ key: "sbx-price:" + (request.headers.get("CF-Connecting-IP") ?? "unknown") });
    return success ? null : new Response(JSON.stringify({ error: "RATE_LIMITED" }), { status: 429, headers });
  } catch {
    return new Response(JSON.stringify({ error: "TEMPORARILY_UNAVAILABLE" }), { status: 503, headers });
  }
}
