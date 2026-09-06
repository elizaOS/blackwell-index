# Centralized demo

The homepage reads `/v1/demo`, a separate view of the latest local collector cycle. The existing `/v1/feeds`, `/v1/ready`, operator registry and Pyth publisher are unchanged.

On 2026-09-06 the project operator confirmed approval from Oracle, Azure and Verda to publish their collected prices for this demo. `demoRegistry` records that authorization separately from oracle-network admission. Other providers remain subject to their configured source rights. Expired permissions and disabled collection remain excluded.

The demo includes only validated, current public USD on-demand exclusive-instance list prices. It excludes account-specific quotes, expired observations and other procurement bases. Exact commercial offers are deduplicated; provider prices are medians across regional medians. Model prices equally weight available independent provider economic groups. The composite equally weights all four models and is unavailable if any is absent. These are physical GPU-hour rental prices, not performance-adjusted equivalents. Changing coverage can change model weights.

`mode: CENTRALIZED_DEMO`, `publishable: false` and `pythPublished: false` are returned on every response. No private capture, raw evidence, identity key or credential is exposed. Historical captures are not used to fill missing current prices. Source freshness uses the existing methodology age limit; the browser also expires stale responses.

The query reads only the latest capture timestamp, including its split rows, with a 64-row bound. Oversized cycles fail with 503 instead of showing a partial aggregate. Demo availability is separate from the oracle readiness endpoint.

The site mode is controlled by `DEMO_MODE` in `public/assets/config.js`. The resolver defaults to real when the flag is absent or false. This deployment explicitly sets `DEMO_MODE: true`. URL query parameters cannot change the mode, and there is no visitor-facing switch. The API link follows the configured mode. Real reads `/v1/feeds` and requires a publishable, non-demo snapshot; unavailable real feeds never fall back to centralized prices. This flag does not enable Pyth publishing.
