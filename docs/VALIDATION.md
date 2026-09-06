# Validation and experiments

## Current test scope

The automated suite uses clearly isolated synthetic test cases to verify calculations and failure handling. Live collectors use only real provider responses and preserve raw evidence. No test fixture, simulated provider or fallback price is imported into production.

Tests include exact instance normalization, all model families, wrong model/term/unit rejection, schema changes, missing keys, paginated APIs, redirects, malformed responses, throttling, outliers, stale/future timestamps, duplicate identities, replay after restart, conflicting reports, source-rights expiry, HTTP peer convergence, snapshot chain corruption, UI data clearing and Pyth protocol conformance.

Recovery tests additionally exercise committed WAL capture, wrong encryption keys, corrupted authentication tags, missing historical inputs/configurations, rehashed incorrect calculations, report routing, conflict-proof linkage and signing-counter rollback. CLI and container lifecycle checks verify that restored identities differ and cannot collect or serve before review. Rate-control tests cover persisted 429/503 deadlines, clock rollback, concurrent requests and late responses; hosted orchestration tests verify that a throttled source is not requested again during its wait.

The Pyth conformance test runs official `pyth-lazer-agent` 0.16.0 against a local test receiver and independently verifies the signed protobuf transaction. It proves compatibility with that version's local publisher protocol. It does not prove feed admission or production forwarding.

## Real-data experiments

| Experiment | Measurement | Failure that changes the decision |
| --- | --- | --- |
| Source census | Model/region/term coverage, source age and successful requests | Fewer than three independent compatible sources per model |
| Price reconciliation | Catalog price versus actual allocation and invoice | Material unexplained tax, host, reservation or discount mismatch |
| Cross-operator retrieval | Same SKU comparisons, timing skew and independent archives | Persistent unexplained differences or shared hidden upstream dependencies |
| Holdout provider | Difference with each provider excluded; group concentration | A single provider determines movement or dispersion |
| Weight sensitivity | Equal versus available validated economic weights | Conclusions depend primarily on unsupported weights |
| Source-loss test | Time until missing state, price clearing and recovery | Stale data gets a refreshed timestamp or basket silently changes |
| Hardware generation change | B/GB SKU mapping, GPU count, minimum order | A GB platform is double counted in B or rack/node counts are confused |
| Multi-node failure | Peer partition, wrong registry, restart, region loss | Unexplained output divergence or loss of durable replay protection |
| Pyth live trial | Accepted publisher history, fresh feed time, signed onchain value | Only a local acknowledgement or carried-forward Pyth output exists |

Source invoice canaries spend money and may create compute commitments; run them only under an approved provider account and a specifically sized allocation. API catalog queries alone do not prove rentable capacity.

## Historical data

Archive raw response bytes, collection timestamps, signatures, registry and methodology versions and published snapshots. Historical replay must use only observations known at the replay time and the weights and members effective then. A page retrieved today cannot prove its price yesterday. Missing historical prices remain missing.

Report the first and last real observation, intervals covered, gaps, inclusion decisions and changes in provider availability. Compare archived snapshots with an independent calculator. Do not label a sensitivity model or synthetic fault test a price-history backtest.

At least 30 consecutive days is the proposed initial operating study, not a completed achievement or a universal industry requirement. Expand it if source coverage, corrections, new hardware or provider changes make the result unrepresentative. Publish coverage and limitation findings even if the launch decision is negative.

## Completion evidence

Maintain one release record linking the repository commit, hosted checks, deployment version, domain checks, node identities/operator groups, source rights, real archives, approved configuration hashes, Pyth publisher/feed permissions and live onchain readback. An unauthenticated process health endpoint only proves the process runs.
