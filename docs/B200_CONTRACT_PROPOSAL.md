# B200 contract proposal — draft for partner review

This is a proposed benchmark definition and a local research specification, not an approved market or a launch authorization. Pyth is the selected delivery provider. The proposed route uses an existing market operator and Pyth's managed HIP-3 service, subject to service acceptance and interface agreement; see the [Pyth delivery decision](ORACLE_DELIVERY_OPTIONS.md). Build the benchmark here; use Pyth's supported delivery and the venue's trading infrastructure.

## Division of responsibility

| Responsibility | Proposed owner |
| --- | --- |
| Source permissions, hardware/billing mappings, economic ownership, fixed weights and corrections | SBX benchmark administrator |
| Independent collection and reproducible benchmark calculation | SBX operators under the agreed methodology |
| Approved ingestion, transport, signing, submission, heartbeat and delivery monitoring | Pyth service, subject to agreed scope |
| Contract listing, market mark, funding, margin, liquidations, settlement and liquidity | Chosen venue/operator and market makers |
| Source outage response, recovery and incident authority | Written joint operating agreement |

Pyth documents custom REST/WebSocket ingestion and managed HIP-3 submission. Using that service does not automatically admit SBX as a standard aggregated Pyth price feed. Its standard Pro aggregation takes publisher medians; it does not implement our provider weights. Confirm whether the service consumes an administered SBX value or whether a different publication model is required. [HIP-3 service](https://docs.pyth.network/price-feeds/hip-3-service), [Pro price semantics](https://docs.pyth.network/price-feeds/pro/understanding-price-data).

## Proposed underlying

- Identifier: `SBX:B200`, proposed underlying for a cash-settled derivative.
- Quote: USD per physical B200 GPU-hour, derived from the full exclusive instance tariff divided by physical GPU count. The tariff includes the instance's recorded bundle; it is not the price of bare hardware.
- Initial cohort: public on-demand list tariffs. Exclude spot, reserved, capacity-block, account-specific and fractional offers. Listed rates do not prove executable capacity or completed transactions.
- Calculation: retain commercial SKU/region/bundle distinctions; regional and provider medians, then a fixed approved economic-provider panel and weights. Record constituent source times and dispersion.
- Geography/topology/minimum order: current configuration is an input to research. Partners must approve the actual contractual scope, comparability, constituent eligibility and weighting evidence before launch.
- Exposure: cash changes in the defined rental benchmark. No GPU-hour delivery, capacity reservation, NVIDIA equity exposure or guaranteed hedge against a customer's actual invoice.

## Perpetual versus dated future

A perpetual requires venue-approved funding and mark rules appropriate for slowly changing rental tariffs. A dated contract could instead settle against a defined window average. This repository does not choose production funding, expiry or averaging rules without venue/customer input, and does not infer a futures curve from current list prices.

For the local stress calculation only, quantity is an integer number of GPU-hours of price exposure. Linear cash PnL is `signed quantity × (mark − entry)`. The example uses 100 GPU-hours, collateral equal to half entry notional, 10% maintenance, mark premiums of −20%/0%/+20%, and a constant 10 bp/day funding charge for one day. These deliberately illustrative values are **not calibrated launch parameters or a reproduction of venue mechanics**. Fees, slippage, liquidation execution, insurance and counterparty default are absent.

## Qualification and single-model launch

`qualifyModel` calls the existing signed-report engine. It reports model calculation readiness, eligibility under the configured publication policy and separate external launch gates. It grants none of those external approvals.

Current software requires at least three economic provider groups per approved model and an independently admitted collector quorum; those are SBX policy choices, not established custom-feed requirements from Pyth. Several collectors copying one provider do not create independent economic sources. The default methodology approval schema covers all four models, and default publication still requires the composite.

The [optional B200 publication policy](MODEL_PUBLICATION_SCOPE.md) now binds model scope to exact methodology/registry hashes, effective time, approval evidence and delivery bindings, using the same source validation and quorum rules. It permits only `SBX:B200`; legacy manifests keep their existing behavior. No bundled configuration activates it. The separate [fixed offer schedule](B200_OFFER_SCHEDULE.md) now supports exact eight-GPU HGX membership and rejects missing selected offers or providers. It is inactive and no real panel is approved. Optional [resource metadata](INSTANCE_RESOURCES.md) now binds exact reported vCPU/RAM/storage quantities. Neither component labels nor reported quantities prove contractual entitlements or commercial comparability. Confirm the intended scope and whether an administered benchmark route permits a simpler operator model before activation.

## Freshness and failure contract

Keep source retrieval time, benchmark calculation time, Pyth feed generation time, transport receipt and venue consumption time distinct. A successfully retrieved unchanged tariff can be fresh; a repeatedly delivered failed retrieval cannot become fresh. Pro may carry forward old aggregate properties when it lacks publisher quorum. Readback must check original feed-generation time as well as source age, identity, exponent, price, confidence and publisher count. [Pyth semantics](https://docs.pyth.network/price-feeds/pro/understanding-price-data).

Missing required constituents make SBX unavailable; do not redistribute their weights. A backup endpoint must serve the same approved benchmark, not silently substitute a different provider mix. The operator must specify what the venue does when source-age or dispersion limits fail. Do not assume ceasing submission safely suspends a market: Hyperliquid documents fallback behavior, and `haltTrading` settles positions at the current mark. Confirm the current behavior with the partner before integration. [Deployer actions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/hip-3-deployer-actions), [HIP-3 specification](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-3-builder-deployed-perpetuals).

Before activation, agree correction/versioning rules, incident authority, discontinuation and settlement prices/windows, leverage and open-interest caps, liquidity/backstop commitments, and applicable data/financial-reference rights. Preserve the genuine sustained-operation and independent-review gates in [LAUNCH_TODO.md](LAUNCH_TODO.md).
