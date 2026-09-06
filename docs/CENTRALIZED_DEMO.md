# Centralized demo

The homepage reads `/v1/demo`, a separate view of the latest local collector cycle. The existing `/v1/feeds`, `/v1/ready`, operator registry and Pyth publisher are unchanged.

On 2026-09-06 the project operator confirmed approval from Oracle, Azure and Verda to publish their collected prices for this demo. `demoRegistry` records that authorization separately from oracle-network admission. Other providers remain subject to their configured source rights. Expired permissions and disabled collection remain excluded.

The demo includes only validated, current public USD on-demand exclusive-instance list prices. It excludes account-specific quotes, expired observations and other procurement bases. Exact commercial offers are deduplicated; provider prices are medians across regional medians. Model prices equally weight available independent provider economic groups. The composite equally weights all four models and is unavailable if any is absent. These are physical GPU-hour rental prices, not performance-adjusted equivalents. Changing coverage can change model weights.

`mode: CENTRALIZED_DEMO`, `publishable: false` and `pythPublished: false` are returned on every response. No private capture, raw evidence, identity key or credential is exposed. Historical captures are not used to fill missing current prices. Source freshness uses the existing methodology age limit; the browser also expires stale responses.

The shared reader examines at most 65 capture metadata rows in descending primary-key order and selects the newest contiguous cycle, including its split rows. Capture writes are atomic; an older, noncontiguous cycle that reuses the same timestamp is not merged into the current cycle. This avoids a scan of retained history and requires no storage-schema migration.

A cycle may contain at most 64 rows, 8 MiB of JSON and 10,000 observations. Byte lengths are checked before payloads are loaded. An oversized or corrupt latest cycle returns a sanitized 503 instead of a partial aggregate or historical fallback. Demo availability remains separate from the oracle readiness endpoint.

Both hosted and self-hosted nodes serve `/v1/demo`. Self-hosted nodes use their own configured source permissions; they do not inherit this project's hosted-demo approval. Collection-only local data therefore stays private and returns unavailable prices until the operator has applicable collection, derivation and redistribution rights.

The navigation offers Demo and Real modes, selected by `?mode=demo` or `?mode=real` (Demo is the default). The selection carries across Index, Providers and Methodology and chooses the matching API link. Real reads `/v1/feeds` and requires a publishable, non-demo snapshot; unavailable real feeds never fall back to centralized prices. The real-mode switch does not enable Pyth publishing.
