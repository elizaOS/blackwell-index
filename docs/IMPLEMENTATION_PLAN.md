# Blackwell Index implementation plan

Status: active development. Date: 2026-09-06.

## Requested outcome

An MIT-licensed public elizaOS repository lets independent operators configure provider credentials, collect real B200, B300, GB200 and GB300 quotes, join an open reporting network, reproduce per-provider and model feeds and the weighted SBX composite, and supply accepted feeds to current Pyth infrastructure. ALTX has a minimal public landing page for its first product, Blackwell Index. Requested domains: blackwellindex.com, blackwell.fyi, blackwell.today and altx.exchange.

The previous compute-strategy repository at revision ba8055be4534d0c512be06789aaa8940e7427564 implements one B200 US on-demand median, raw response retention, freshness and rights checks. It has no Pyth integration or public collector network. Its private business research and unrelated work are not part of this public repository.

## Architecture decisions

1. Collect all supported commercial terms without silently mixing them. Preserve exact hardware family, physical GPU count, region, commercial term, price basis, bundle contents, quote time and observed availability. The primary draft benchmark measures global public on-demand exclusive-instance list tariffs divided by physical GPU count. This measures bundled rental cost per GPU-hour, not isolated silicon cost or performance-equivalent compute. Spot, scheduled, reserved and transaction observations remain separate data.
2. Any operator can generate a random signing identity, run the same software and submit signed batches to a configured peer. Keys and API credentials stay local. Reports from unrecognized identities are candidates. Benchmark influence requires configured operator independence and approved source provenance; a signature proves origin, not truth. Running extra nodes must not increase one operator's or provider's weight.
3. Each node verifies signed reports and calculates deterministically from its local report set. This is an open collector and verifier network, not an invented BFT blockchain. Nodes can disagree during delayed delivery; snapshots expose exact input hashes. Pyth's accepted publisher/router infrastructure is a separate consensus boundary.
4. Within a provider/model, use matched-SKU cross-operator agreement followed by deterministic regional/SKU medians. Across independent provider groups, use explicit disclosed arithmetic weights. Across four GPU model feeds, use a fixed-weight arithmetic basket. Equal weights are an initial research choice, not measured market shares or a claim of IOSCO certification. No feed is priced when required quorum, comparability or components are missing. Never drop a missing model and silently redistribute its weight.
5. Pyth onboarding, asset/feed admission, current publisher ingress and assigned feed IDs require Pyth confirmation. Current docs report an August 26, 2026 migration from Pythnet to Pyth Pro routers; do not deploy obsolete validators based only on the legacy publish-data page. A local adapter, signed SBX message or Hermes consumer call is not proof of Pyth publication.

## Work packages and acceptance

| Package | Deliverables | Evidence required |
| --- | --- | --- |
| Research | Current source matrix, Pyth migration/onboarding, methodology and threat model | Primary links, live endpoint probes, unresolved assumptions |
| Collection | Exact model/SKU normalization; public and key-authenticated adapters; setup; archive | Recorded real retrievals, parsing tests, rate-limit behavior, no fixture fallback |
| Open nodes | Random signing keys, bounded join/submission APIs, durable replay protection, peer forwarding, registry | Multi-process loopback test, restart/replay/tamper/Sybil tests |
| Feeds | Per-provider, four model feeds and weighted composite | Independent arithmetic, deduplication, missing-input and stale-input tests |
| Validation | Replay and historical coverage analysis, failure experiments | No invented historical prices; report observation range and gaps |
| Pyth | Current publisher bridge/configuration, onboarding checklist, external readback | Accepted publisher identity, feed IDs, fresh authenticated Pyth response and target-chain proof |
| Public product | Minimal ALTX page, SBX feed page and API, source/config/status visibility | Browser checks, HTTP checks, no synthetic values |
| Operations | Container, persistent volumes, CI, health/readiness, monitoring and restore runbook | Public repository commit and CI; deployed independent nodes and restore test |
| Domains | Four requested registrations and DNS/TLS | Registrar receipt, ownership, authoritative DNS and HTTPS |

## Experiments

- Collect live source observations and retain evidence before declaring coverage. Compare instance prices and GPU counts against provider docs; allocation/invoice checks require provider accounts and actual purchase authority.
- Compare exact same source/SKU/time across independently run collectors. Measure disagreement, timing differences and schema drift.
- Test weighting sensitivity, provider leave-one-out, malicious report floods, colluding operators, duplicate upstream providers, stale sources, clock skew, equivocation, restart replay and peer outages.
- Backtest only dated real observations with the registry and methodology effective at that time. Label retrospective page captures as observations made now. Report gaps, survivor bias and missing weights.
- Keep price-history qualification and a real sustained operating period open until actual time has elapsed; unit tests cannot satisfy them.

## External completion dependencies

Pyth accepted publisher/asset admission and ingress details; provider-specific API accounts and appropriate automated retrieval/retention/redistribution rights; independent operators and governance owners; verified deployed-revision recovery, offsite backup destination, separate key custody and production operating review. Domains and same-operator hosting are deployed, but renewal ownership and ongoing operations remain open. Each dependency is recorded in the [launch checklist](LAUNCH_TODO.md). Do not call the oracle published or decentralized in production before those conditions are verified.

## Current implementation scope

Eleven collectors are implemented; Oracle, Azure and Verda have real public retrieval evidence. The authenticated collectors remain unverified against live accounts. AWS GB300 is discovery-only until its physical GPU denominator is confirmed. Prime Intellect is registered but disabled with all source rights unapproved: complete supported B200/B300 bundles are account-specific, while GB200/GB300 remain discovery-only. This is a coverage expansion, not a claim to cover every provider or approve any source for publication.

Default registry `0.3.0-draft` defines 11 providers and 49 feed slots, not 49 qualified prices. Existing local registries retain their pinned configuration until explicitly reviewed and updated. Historical release evidence keeps the provider and feed counts observed at that revision.

Durable 429/503 scheduling is shared by CLI and hosted collection. [Hosted recovery tooling](HOSTED_RECOVERY.md) now uses a private service binding for a signed, bounded journal export, verifies it locally and creates an encrypted backup. Both hosted exports and self-hosted backups restore only into a new, disabled self-hosted identity. The logical export has an 8 MiB cap; larger-journal streaming archives, offsite custody, deployed-revision recovery verification and a host-loss exercise remain acceptance work.

The [retained-data operating study](OPERATING_STUDY.md) analyzes private captures without network collection or synthetic gap filling. Thirty-day qualification remains `NOT_ESTABLISHED`. Sustained independent operation, source rights and Pyth readback remain separate gates.
