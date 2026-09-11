# Phase 0: a governed oracle usable by markets

Phase 0 covers the compute-rental benchmark, agreed Pyth distribution and actual market-consumption proof. Asset-backed lending, physical GPU trading, property valuation and tokenized investment vehicles are separate future products. A rental tariff is not an executed trade, a promise of deployable capacity or a physical-asset valuation.

The immediate scope is one approved benchmark, one complete first-market proof and reusable evidence for further consumers. Pyth remains selected. The proposed first market is an existing HIP-3 deployer using managed custom ingestion; service and venue acceptance remain pending. Other venue conversations can proceed in parallel without inventing their interfaces or listing authority.

## Reuse and responsibilities

Reuse the current source adapters, exact calculation, signed-report admission, source replay, research collection/health and Pyth protocol work. SBX owns source definitions, comparability, methodology, rights, correction and historical evidence. Pyth supplies the agreed distribution/verification service. The selected venue owns market listing, mark/funding/margin policy and the accepted outage response. A fresh delivery timestamp is not proof of a fresh underlying source.

See [delivery options](ORACLE_DELIVERY_OPTIONS.md) for managed HIP-3, native Pro/Core and the open-network trust model. The same benchmark/version must survive each agreed route; redundant endpoints must not silently use different constituent baskets. Open collection and reproducible aggregation remain product requirements when delivery is managed by Pyth. Independent operators and the process for approving source, registry and methodology changes still need to be established.

## Work packages

| Package | Required work | Completion evidence |
| --- | --- | --- |
| Local release | Review public diff, portable operations docs, code tests, build, runtime and capacity checks | Exact-revision receipt; explicit unrun/environmental gates; private data and strategy excluded |
| Source qualification | Reproduce genuine data; compare full bundles, region, hardware, billing and ownership; confirm intended-use rights | Approved fixed source schedule with evidence, including required independent economic groups |
| Product and scope | Select V1's Blackwell model scope; evaluate the inactive B200 policies only if that exposure is selected; approve source mappings, weights, time/dispersion and corrections | Reviewed versioned methodology and admission tests for the selected scope |
| Network governance | Establish independent operators, source admission and authority to propose, review and activate registry/methodology revisions | Verifiable operator independence and a published change process; extra keys do not create voting power |
| Pyth integration | Implement the supported authenticated interface and assigned bindings | Genuine upstream readback of exact identity, value, scale and times; accepted treatment of unavailable data |
| Venue acceptance | Map benchmark to actual oracle/mark and exercise failures | Independent venue receipt plus duplicate, delayed, reordered, stale, outage and recovery results |
| Sustained operation | Own supervision, paging, backups, correction, key rotation and incident actions | Genuine required history and recovery evidence, distinct from synthetic capacity |
| Additional consumers | Reuse qualified benchmark and delivery, add accepted consumer-specific mapping | Separate acceptance record for each venue/product |

The default production policy requires a publishable four-model composite. The [optional B200 policy](MODEL_PUBLICATION_SCOPE.md) binds scope across calculation, API, Pyth manifests, readback and recovery; it is inactive. The separate [inactive offer schedule](B200_OFFER_SCHEDULE.md) enforces exact eight-GPU HGX membership through offer, provider and weighted economic-group completeness. Optional [resource quantities](INSTANCE_RESOURCES.md) enforce exact reported vCPU/RAM/storage metadata, with an inactive Lambda mapping. Genuine provider evidence and contract validation remain required. Obtaining one feed identifier does not approve either product scope or activation. The current three-economic-group rule and operator quorum are SBX policies, not assumed requirements of every Pyth custom service. Keep them enabled until a replacement is reviewed and approved.

The [official HIP-3 resolver acceptance](PYTH_HIP3_RESOLVER_ACCEPTANCE.md) tests internal price/time compatibility. A separate [local HTTP acceptance](PYTH_HIP3_HTTP_ACCEPTANCE.md) exercises signed synthetic inputs through the actual SBX node route, a candidate loopback listener and the unmodified official resolver. The listener checks configuration pins and source age and clears invalid state. It is an unaccepted local extension, with no production authentication, signing operation or venue receipt.

## Interface contract before implementation

Agree benchmark identity, unit/exponent, valid price bounds, methodology/registry binding, effective version, duplicate/order semantics, source observation time, calculation time, delivery generation time, confidence/dispersion and unavailable status. Existing SBX fields are an input inventory, not an asserted Pyth wire format. If the selected payload cannot carry required metadata, agree a bound metadata/evidence channel and its verification.

Distinguish fresh unchanged tariffs, failed retrievals, expired constituents, unavailable benchmarks, transport outages and invalid signatures. Do not fabricate executable bid/ask prices for catalog tariffs or refresh source age with a transport heartbeat. Agree how a correction or methodology change affects both current publication and historical resolution.

## Market-specific acceptance

A continuous perp oracle and a prediction-market fixing are different products. For a perp, verify how the venue transforms its external oracle into mark and funding values and what happens when source data expires. Stopping updates must not be equated with stopping risk: HIP-3 documents local-mark fallback, and `haltTrading` settles positions at the mark. [HIP-3 actions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/hip-3-deployer-actions), [HIP-3 specification](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-3-builder-deployed-perpetuals).

For a prediction, agree a UTC window, version, coverage, aggregation, threshold/equality rule, publication deadline, correction cutoff, missing-data and discontinuation policy. The venue's accepted resolution rules determine the outcome; a Pyth transport alone does not replace them. For example, Polymarket documents proposal/dispute resolution, while Kalshi describes named source agencies and markets-team review. [Polymarket resolution](https://docs.polymarket.com/concepts/resolution), [Kalshi market rules and suggestions](https://help.kalshi.com/en/articles/13823821-market-faqs).

An existing Pyth integration on a venue does not establish SBX listing permission. Obtain a named listing/data/risk owner and partner test interface. Record each consumer's result separately; Base verification, HIP-3 consumption and a prediction resolution cannot substitute for one another.

## Release boundary

The [local acceptance checklist](PYTH_LOCAL_ACCEPTANCE.md), [source decisions](B200_METHODOLOGY_DECISIONS.md) and [launch requirements](LAUNCH_TODO.md) remain operative. Local release checks establish software behavior for their stated scope. Genuine provider rights, independent control, Pyth admission, live feed assignments, venue acceptance and sustained market operations require their own evidence. This plan changes no runtime permissions, feeds, weights or publication settings.
