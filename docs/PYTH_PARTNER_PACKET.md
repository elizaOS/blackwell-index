# SBX / Pyth / market-operator discussion draft

Unsent technical packet, September 6, 2026. This document requests no listing, account opening, funding or deployment by itself. Private agreements, identities, keys and raw provider data must be exchanged through the agreed protected channel.

## Proposed scope

We are evaluating a cash-settled B200 rental-price market using an SBX-administered benchmark, an existing market operator and Pyth's managed delivery. SBX currently has real public tariff collectors, exact aggregation, signed-report and registry checks, retained-data research and a tested official-agent adapter. A local protocol acknowledgement proves neither Pyth admission nor upstream publication. The production methodology, additional independent provider coverage, financial-reference permissions and market contract remain unapproved.

The [contract proposal](B200_CONTRACT_PROPOSAL.md) defines the underlying and unresolved decisions. The [shadow report](B200_SHADOW_STUDY.md) provides reproducible local failure experiments; it is not a venue emulator or an assertion of price quality.

## Questions for Pyth

1. Does managed HIP-3 custom-source ingestion accept an administered GPU rental benchmark? Is a standard Pro/Core listing unnecessary for that route, or is publisher/feed admission separately required?
2. Which supported ingestion specification/SDK should SBX implement? Agree payload identity, unit, exact decimal/exponent, benchmark version, approved constituent hashes, original source retrieval time, calculation time and unavailable state. Do not allocate invented feed IDs.
3. How are the source authenticated and replay protected? Who signs what, which keys/rotations are required, and what independent receipts prove both delivery and actual market consumption?
4. Can the service enforce source-age/dispersion/availability independently of heartbeat timing? How are stale unchanged prices, missing source groups, ambiguous submissions and recovery handled?
5. Can redundant endpoints deliver the same approved benchmark without substituting a different constituent mix? Which responsibilities and alerts remain with SBX versus Pyth and the market operator?
6. What test environment, access, supported verification libraries, credentials, SLAs, fees and onboarding evidence are required? What does the advertised capital/liquidity support cover contractually?
7. If standard Pro publication is preferred, are publishers independent price estimators or replicas of an administered value? How does the aggregation preserve the approved SBX meaning, source freshness and administrator attribution?

Pyth describes custom-source ingestion and managed submission in its [HIP-3 service documentation](https://docs.pyth.network/price-feeds/hip-3-service). Confirm acceptance and terms; the documentation is not an agreement.

## Questions for the market operator

Agree perpetual versus dated contract, multiplier, geography and commercial bundle scope, mark/index treatment, funding or settlement-window calculation, margin/OI limits, fees, liquidity and liquidation/backstop behavior. Decide which source outages block new exposure and which require settlement; identify the exact authorized actions and incident owner. Do not assume a venue's halt action is a reversible pause.

Agree independently observed end-to-end test cases: approved input → accepted delivery → verified upstream identity/value/source age → actual venue oracle/mark state; unchanged successful tariff retrieval; source failure without artificial freshness; delayed/duplicate/reordered transport; divergent backup; quorum/dispersion failure; signing-key rotation; recovery without replaying an old print. Retain exact revisions and receipts. Local fixtures establish only local behavior.

## Decision record to obtain

| Decision | Current state |
| --- | --- |
| Legal benchmark operator and covered rights | Pending |
| Fixed B200 panel, comparable offers and weight rationale | Pending |
| Pyth route, acceptance and service responsibilities | Pending |
| Venue, contract and risk/liquidity approval | Pending |
| Supported authentication/readback/consumption proof | Pending |
| Test environment and access | Pending |
| Sustained operation and independent release reviews | Not established |

Implement the selected supported connector after these interface decisions. Reuse Pyth's delivery infrastructure and the venue's trading engine; do not build substitute signing, aggregation or exchange machinery simply to fill an unapproved integration gap.
