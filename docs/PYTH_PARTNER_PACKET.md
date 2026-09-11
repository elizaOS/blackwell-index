# SBX / Pyth / market-operator discussion draft

Unsent technical packet, updated September 9, 2026. This document requests no listing, account opening, funding or deployment by itself. Private agreements, identities, keys and raw provider data must be exchanged through the agreed protected channel.

## Proposed scope

The owner reports active discussions with Pyth and an exclusive Pyth direction. The owner clarified on September 9 that the exact service route and technical contract remain unspecified. The questions below concern that contract, not a choice of another oracle vendor.

Eliza Research is developing an oracle for NVIDIA Blackwell GPU compute rental prices, with open collection, independently reproducible aggregation and decentralized governance as the goal. The prototype supports B200, B300, GB200 and GB300 model feeds and a composite. The V1 benchmark scope remains to be agreed; a fixed B200 basket is one proposal. Managed HIP-3 delivery is proposed for the first Hyperliquid market, subject to Pyth and venue acceptance.

SBX currently has real public tariff collectors, exact aggregation, signed-report and registry checks, retained-data research and a tested official-agent adapter. Advertised offers and tariffs are not executed rental transactions. Candidate admission and configurable registries do not establish independent operators or decentralized governance. Pyth should confirm how SBX's open collector network maps to its accepted publisher and aggregation model.

A local protocol acknowledgement proves neither Pyth admission nor upstream publication. The production methodology, additional independent provider coverage, financial-reference permissions and market contract remain unapproved. Upstream September 6 records report a Pro consumer trial and genuine signed BTC verification through a read-only Base call. These are consumer connectivity evidence, not SBX feed admission; trial validity and continuing terms need confirmation. The Base consumer implementation is retained separately from the proposed HIP-3 service route.

The [B200 contract proposal](B200_CONTRACT_PROPOSAL.md) defines one candidate underlying and its unresolved decisions. The [shadow report](B200_SHADOW_STUDY.md) provides reproducible local failure experiments; it is not a venue emulator or an assertion of price quality.

The [offline source audit](B200_SOURCE_AUDIT.md) verifies retained B200 response bytes and reproduces observations through the current collectors. Its private offer inventory identifies bundle, instance-size and geographic decisions. The [local acceptance checklist](PYTH_LOCAL_ACCEPTANCE.md) separates parser/protocol evidence from provider, Pyth and venue acceptance.

## Questions for Pyth

1. Does managed HIP-3 custom-source ingestion accept an administered GPU rental benchmark? Is a standard Pro/Core listing unnecessary for that route, or is publisher/feed admission separately required?
2. Will the managed service ingest the existing SBX endpoint through a supported custom listener, or should SBX supply an extension against the public HIP-3 pusher? Its configuration and resolver are public; a generic custom REST listener is not in the reviewed application. Agree payload identity, unit, exact decimal/exponent, benchmark version, approved constituent hashes, original source retrieval time, calculation time and unavailable state. Do not allocate invented feed IDs.
3. How are the source authenticated and replay protected? Who signs what, which keys/rotations are required, and what independent receipts prove both delivery and actual market consumption?
4. How should a changed benchmark with an unchanged oldest-input timestamp be represented? Our native adapter currently suppresses repeated source timestamps; agree benchmark revision time separately from underlying freshness. Can the service enforce source-age/dispersion/availability independently of heartbeat timing? How are stale unchanged prices, missing source groups, ambiguous submissions and recovery handled?
5. Can redundant endpoints deliver the same approved benchmark without substituting a different constituent mix? Which responsibilities and alerts remain with SBX versus Pyth and the market operator?
6. What test environment, access, supported verification libraries, credentials, SLAs, fees and onboarding evidence are required? What does the advertised capital/liquidity support cover contractually?
7. How should independent SBX operators participate: reproduce one approved benchmark for managed ingestion, or apply as independent native publishers? If Pro publication is preferred, how does its aggregation preserve the approved benchmark meaning, source freshness and attribution? Which admission and methodology decisions remain with SBX governance?

Pyth describes custom-source ingestion and managed submission in its [HIP-3 service documentation](https://docs.pyth.network/price-feeds/hip-3-service). Confirm acceptance and terms; the documentation is not an agreement.

The [local resolver acceptance](PYTH_HIP3_RESOLVER_ACCEPTANCE.md) runs the actual public Pyth resolver at pinned revision `807ff575a9090cee99b9e1a30dc23edf3522fe1b`, with signed synthetic SBX inputs and an explicitly local source-state extension. This proves exact decimal and source-age behavior at that boundary. It does not establish managed ingestion, authentication, delivery or venue consumption. The [B200 publication policy](MODEL_PUBLICATION_SCOPE.md) is implemented as an inactive opt-in; no real scope approval or eligible-offer schedule is supplied.

## Questions for the market operator

Agree perpetual versus dated contract, multiplier, geography and commercial bundle scope, mark/index treatment, funding or settlement-window calculation, margin/OI limits, fees, liquidity and liquidation/backstop behavior. Decide which source outages block new exposure and which require settlement; identify the exact authorized actions and incident owner. Do not assume a venue's halt action is a reversible pause.

Agree independently observed end-to-end test cases: approved input → accepted delivery → verified upstream identity/value/source age → actual venue oracle/mark state; unchanged successful tariff retrieval; source failure without artificial freshness; delayed/duplicate/reordered transport; divergent backup; quorum/dispersion failure; signing-key rotation; recovery without replaying an old print. Retain exact revisions and receipts. Local fixtures establish only local behavior.

## Decision record to obtain

| Decision | Current state |
| --- | --- |
| Legal benchmark operator and covered rights | Pending |
| V1 model scope, comparable offers and weight rationale | Pending; four-model index exists, B200-only basket is optional |
| Independent operators and registry/methodology change authority | Not established by candidate keys or registry labels |
| Delivery provider | Pyth selected by project owner |
| Pyth service route, acceptance and responsibilities | Managed HIP-3 proposed; acceptance and interface agreement pending |
| Venue, contract and risk/liquidity approval | Pending |
| Supported authentication/readback/consumption proof | Pending |
| Test environment and access | SBX/HIP-3 access pending; upstream records report separate BTC Pro trial access |
| Sustained operation and independent release reviews | Not established |

Implement the selected supported connector after these interface decisions. Reuse Pyth's delivery infrastructure and the venue's trading engine; do not build substitute signing, aggregation or exchange machinery simply to fill an unapproved integration gap.

## Concrete service reply requested

Please identify the supported route for a Blackwell rental-price benchmark produced by an open collector network: managed custom REST/WebSocket ingestion or native Pro/Core publication. Our V1 scope is under review; the fixed B200 basket is an optional pilot. We have locally tested the public HIP-3 resolver using an SBX source-state extension. Will your managed service ingest our endpoint through its custom listener, or should we provide an extension against the public pusher? State whether native publisher admission or catalog feed IDs are needed; supply the supported schema, authentication, unavailable-state representation, source-time handling and test endpoint. Confirm how the approved benchmark scope is bound and how independent SBX operators can participate without changing its meaning.

Please distinguish the service heartbeat from successful provider retrieval. Specify the evidence that independently proves the exact approved value and source age reached the venue, including replay, stale-source, constituent-loss and divergent-backup tests. Assign source/transport/venue incident owners and state the contractually supported outage and recovery actions. Provide onboarding, continuing access and fee terms through the protected channel.

This packet is prepared for later authorized outreach and remains unsent.
