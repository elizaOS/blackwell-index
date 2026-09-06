# SBX delivery options

Research decision note, September 6, 2026. No service is selected or approved for production. The benchmark calculation and private research tools should remain independent of the selected delivery provider. Do not implement three production adapters before choosing the market and its accepted integration.

| Route | Documented capability | SBX decision still required |
| --- | --- | --- |
| Pyth managed HIP-3 service | Custom REST/WebSocket sources, managed oracle submissions and operational support | Custom SBX acceptance, source authentication/freshness, scope, fees and actual venue consumption proof |
| Pyth standard Pro/Core publication | Approved publishers, feed bindings and network aggregation; existing SBX agent adapter targets this route | Admission, administered-value versus independent-publisher semantics, feed IDs and consumer verification |
| Switchboard custom feeds | Permissionless feed definitions, HTTP/JSON/math jobs, simulation and configurable feed validation | Exact benchmark-preserving job definition, source-age checks, supported consumer/venue, cost and production delivery ownership |
| Chainlink DataLink / Data Streams | Proprietary dataset publishing, custom report/index delivery and low-latency consumption infrastructure | SBX onboarding, approved schema, terms, venue compatibility and end-to-end integration |

Sources: [Pyth managed service](https://docs.pyth.network/price-feeds/hip-3-service), [Pyth price semantics](https://docs.pyth.network/price-feeds/pro/understanding-price-data), [Switchboard introduction](https://docs.switchboard.xyz/), [Switchboard custom feed builder](https://docs.switchboard.xyz/custom-feeds/build-and-deploy-feed/build-with-ui), [Chainlink DataLink](https://chain.link/datalink), [Chainlink Data Streams](https://chain.link/data-streams).

## Conditional recommendation

For a self-service custom onchain feed, Switchboard merits a direct comparison with Pyth. For a managed HIP-3 launch, Pyth has the clearest explicit service offering in the documentation reviewed. For a venue already using Chainlink, investigate DataLink/Streams rather than assuming another oracle is preferable. These are fit assessments, not measured latency, cost or security rankings; no provider has confirmed SBX acceptance.

Switchboard documents HyperEVM support. That proves an EVM integration path, not managed submission into HyperCore HIP-3 markets. Chainlink's HyperEVM feeds likewise do not establish that exact service. Confirm the actual market consumer and submission path before equating chain availability with venue compatibility. [Switchboard Hyperliquid integration](https://docs.switchboard.xyz/docs-by-chain/evm/hyperliquid), [Chainlink HyperEVM example](https://data.chain.link/feeds/hyperliquid/hyperliquid/hype-usd).

Permissionless feed creation removes a listing dependency; it does not establish benchmark quality, data rights, venue listing or liquidity. Several oracle nodes fetching the same SBX endpoint remain dependent on the same administered benchmark. Conversely, independently aggregating provider quotes using a vendor's default median may change the meaning of our approved fixed-weight index. Both designs need explicit methodology treatment.

## Keep local work narrow

SBX owns source definitions, normalization, commercial comparability, methodology, rights and reproducible benchmark evidence. Reuse supported oracle jobs/services for delivery and, where suitable, verifiable fetching/computation. The chosen venue owns trading and risk mechanics. Review whether SBX's separate collector-quorum layer remains necessary after the trust model is agreed; it is a current project policy, not an established requirement imposed by every oracle provider.

The next external comparison should use one common packet: proposed B200 benchmark, exact source-time semantics, fixed-constituent outage behavior, target venue, required independent receipts, and operating responsibilities. Obtain supported interfaces and terms, then implement one small connector and prove it in the agreed test environment. Keep the existing Pyth adapter available; there is no reason to remove tested code before a selection.
