# B200 methodology decisions for owner and partner review

Prepared September 8, 2026. This is a proposed decision record, not an approved methodology. It changes no registry, rights flag, weight, collector, feed binding or publication gate. The benchmark owner, source-rights reviewer and chosen market operator are not yet named here.

## Recommended first scope

Propose a **B200 eight-GPU HGX public on-demand instance-tariff benchmark**, quoted in USD per physical GPU-hour. Start with a clearly described rental-tariff exposure; do not describe it as an executable GPU spot price, a futures curve or the cost of every compute workload.

The eight-GPU slice reduces the current one/two/four/eight-GPU instance mixture and is a plausible scope to discuss with training-compute customers. This is a product hypothesis for review, not evidence that customers prefer it or that three qualified suppliers can provide it. HGX topology, bundle and geography must be evidenced for each constituent. If the qualified panel cannot support this scope, revise the proposal explicitly; do not broaden eligibility silently to obtain a number.

| Field | Candidate decision | Evidence or approval required |
| --- | --- | --- |
| Product | Full, exclusive eight-physical-GPU NVIDIA B200 HGX instance | Exact GPU model/count/topology and commercial SKU; no GB200, B300, fractional or shared substitution |
| Procurement | Generally applicable public on-demand list tariff with no term commitment | Account-independent applicability and billing minimum; authenticated access alone does not establish a public tariff |
| Unit | Full included instance tariff divided by eight, in USD/GPU-hour | Traceable original price, currency, billing period and count; no inferred FX or GPU-only component |
| Bundle | Provider's explicitly enumerated base instance bundle, including mandatory instance charges | Record GPU, CPU, RAM, local storage and separately billed required components; choose acceptable differences before admission |
| Exclusions | Spot, reservations, capacity blocks, negotiated/account-specific discounts, optional add-ons and taxes | Provider confirmation that excluded items are actually optional or outside the quoted tariff; no estimated subtraction from an included bundle |
| Geography | A fixed, named set of provider/region/SKU records in the approval schedule | Actual regional applicability; `global` or `unspecified` parser labels alone do not establish coverage |
| Availability meaning | A tariff reference; no promise of immediate deployable capacity | Retain capacity as known/unknown/unavailable separately; obtain and approve a policy for discontinued or persistently unavailable offers |
| Constituents | Fixed admitted economic-provider groups and eligible records | Ownership/price-setting evidence, comparable commercial scope and permission covering the benchmark operator |
| Calculation | Reuse the existing exact regional/provider aggregation and approved fixed group weights | Freeze the schedule, region policy, rounding, weights, version and effective time; no weighting by SKU or collector count |
| Failure | Unavailable when a required group fails the approved validation/freshness policy | No missing-group weight redistribution; agree the consumer/venue response separately |

This candidate is a **basket of specified instance tariffs**. It does not make different CPU, memory or storage entitlements economically identical. A commercial reviewer must decide whether those differences are acceptable for the intended exposure. If customers instead want a standardized workload bill, define a required resource configuration and obtain its actual full price from each provider; that would be a separate specification and mapping change.

## What current evidence can support

The [September 8 integration checkpoint](LOCAL_INTEGRATION_2026-09-08.md) records 723 passing local tests and 342 replayed B200 observations across 38 September 6 captures. Those observations come from two retained response bodies. They are neither 342 independent trades nor sustained current coverage. The inspected journal then had a trailing collection gap and no Runpod evidence. New collection must have its own dated receipt; it cannot fill that historical gap.

| Source | Candidate fit from retained/local evidence | Decision still open |
| --- | --- | --- |
| Oracle | An eight-GPU B200 instance, recorded HGX topology, GPU/CPU/RAM/local-storage bundle | Regional applicability, mandatory charges, tariff/capacity interpretation, ownership and intended-use rights |
| Verda | An eight-GPU B200 SKU exists alongside smaller sizes; GPU/CPU/RAM tariff, storage excluded | Verify HGX topology and region; determine required storage charges and whether its bundle is acceptable alongside Oracle |
| Lambda | Official documentation identifies an eight-GPU HGX B200 on-demand instance; collector and offline replay are implemented | Genuine exact SKU/region response, verified topology and quantitative bundle mapping, public-rate applicability, rights and ownership; prioritize qualification for this proposed scope. [Official launch](https://lambda.ai/blog/nvidia-b200-lambda-on-demand-cloud), [instance specifications](https://docs.lambda.ai/public-cloud/on-demand/) |
| Runpod | Integrated collector and offline replay tests; existing query represents a one-GPU Secure Cloud quote | Obtain genuine retained evidence and an actual eight-GPU offering if pursuing this scope; never multiply the one-GPU quote into an invented eight-GPU tariff |

None is newly admitted by this document. The current minimum of three economic provider groups and the existing operator quorum are SBX software policies. A third source label or another node querying the same provider does not establish independence. Pyth must say what its chosen service requires; changing an SBX policy remains a separate reviewed decision.

## Choices to make now

| Decision | Proposed next step | Accountable role | Completion evidence |
| --- | --- | --- | --- |
| Target customer and exposure | Test the eight-GPU rental-tariff scope with compute buyers and the prospective operator | Product/benchmark owner | Written scope decision, including accepted hedge mismatch and excluded products |
| Bundle and regional schedule | Obtain provider confirmations and compare actual full tariffs within the chosen scope | Benchmark administrator and source reviewer | Versioned SKU/region/bundle schedule with protected evidence references |
| Fixed weights | Evaluate equal economic-group weighting as a transparent candidate while collecting evidence; keep production weights unset | Methodology approver | Approved numerical weight vector and rationale, with sensitivity results and effective date |
| Rights and independence | Confirm legal price-setting entities and rights for each intended use and beneficiary | Rights reviewer and provider contact | Protected permissions and ownership evidence; explicit approval record rather than a link to a public price page |
| Source age and dispersion | Review genuine scheduled retrievals, changes, outages and cross-provider differences | Methodology approver and risk reviewer | Measured evidence and signed thresholds; current defaults and illustrative stress parameters are not launch calibration |
| Corrections and constituent changes | Define announcement, versioning, effective-time, suspension and discontinuation rules | Benchmark administrator and operator | Written operating policy; past observations and old benchmark versions remain reproducible |
| B200-only publication | Review the implemented inactive publication policy and agree service route | Engineering and methodology approver | Approved scope/hashes/bindings and tests; defaults retain the all-four-model composite gate |
| Contract and market risk | Request perpetual-versus-dated assessment, funding/settlement rules and risk limits | Chosen venue/operator and market makers | Approved contract, liquidity commitments and tested outage/recovery behavior |

Equal group weighting is a candidate family, not an approved weight assignment or a claim of market share. The local research value cannot become a production weight choice by copying its output. No leverage, collateral, maintenance, open-interest, funding or settlement parameter is selected here.

## Pyth decision and engineering boundary

Pyth is selected. For the proposed perps pilot, request **managed HIP-3 custom-source ingestion through an existing operator**. Pyth's documentation currently describes custom REST/WebSocket sourcing and managed submissions. This supports asking about an administered SBX endpoint; it does not establish SBX acceptance or an agreed payload. [Pyth HIP-3 service](https://docs.pyth.network/price-feeds/hip-3-service) (checked September 8, 2026).

Ask whether that service requires native publisher admission or catalog identifiers, and obtain its authentication, source-time, unavailable-state and receipt contract. Avoid implementing a guessed managed-service connector while those answers are pending. Standard Pro aggregation takes the median of publisher prices; reproducing a fixed administered basket through that route needs an explicit agreement about publisher roles and preservation of benchmark meaning. [Pyth price semantics](https://docs.pyth.network/price-feeds/pro/understanding-price-data) (checked September 8, 2026).

The integrated Base signed-update consumer is useful for an EVM consumer. Its local checks and earlier upstream BTC trial do not prove an SBX feed exists or that a Hyperliquid market consumed it. Retain that work; choose whether it is on the pilot's critical path only after the operator and Pyth interface are agreed.

The [B200 publication policy](MODEL_PUBLICATION_SCOPE.md) is implemented as an inactive option and the [official HIP-3 resolver](PYTH_HIP3_RESOLVER_ACCEPTANCE.md) has a local compatibility harness. A separate [inactive exact-offer schedule](B200_OFFER_SCHEDULE.md) now enforces fixed eight-GPU HGX membership. Each selected offer, provider and economic group must remain qualified. Quantitative entitlements and commercial semantics still require genuine provider evidence and mapping checks; no real schedule is approved.

Next engineering after the decisions: populate the approved schedule, verify provider mappings and implement the supported service interface; prove approved input → authenticated delivery → independently checked identity/value/source age → actual venue oracle/mark → approved failure and recovery behavior. Continue private collection and analysis in parallel. See the [contract proposal](B200_CONTRACT_PROPOSAL.md), [delivery decision](ORACLE_DELIVERY_OPTIONS.md) and [unsent outreach drafts](OUTREACH_DRAFTS.md).
