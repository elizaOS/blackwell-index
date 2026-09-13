# Public index price API

GET /v1/price returns only {"price":"12.340000"} in USD per GPU-hour. The number shown here is a format example, not a live quote. Values use decimal strings.

This is the same centralized demo composite shown on the website, not a published oracle or Pyth feed. Missing or stale composite data returns HTTP 503 with {"price":null}; no historical fallback is substituted.

The compact API and the website display feed (/v1/demo) share an edge limit of 60 requests per minute per IP per Cloudflare location. Aliases, node paths and query parameters share the same key. Cloudflare's counters are eventually consistent, not a strict global quota. Shared networks also share their IP allowance.

Excess requests receive HTTP 429, {"error":"RATE_LIMITED"}, Retry-After: 60 and Cache-Control: no-store. A limiter failure returns HTTP 503 without price data. GET is the only supported compact API method.

The separate website display feed and existing diagnostic/node protocol endpoints remain available; this change simplifies the linked public API, not access control for diagnostics.
