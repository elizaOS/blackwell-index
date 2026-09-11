# SBX delivery: use Pyth

Updated September 9, 2026. The owner is in talks with Pyth and has selected Pyth exclusively. The owner clarified that the service route and technical contract are not yet specified. Treat that as an active partner discussion, not an assigned feed, accepted endpoint or production deployment.

## Recommended architecture

```text
Eligible compute-source observations from independent collectors
  -> SBX admission, normalization, reproducible calculation and evidence
  -> Pyth's agreed ingestion and delivery service
  -> the market operator's accepted oracle/consumer interface
```

For the first Hyperliquid market, request **managed HIP-3 custom-source ingestion**. Pyth documents REST/WebSocket sourcing, redundant infrastructure and signed venue submissions. Our recommendation is to supply the approved compute benchmark and use that service, rather than operate another publisher, key manager or relayer. Native Pro/Core distribution can accompany it if Pyth and other consumers require it. [Pyth HIP-3 service](https://docs.pyth.network/price-feeds/hip-3-service).

This service choice does not select the economic benchmark. The existing four-model index and proposed fixed B200 basket are different products. Decide the intended exposure and qualified sources with the owner and venue. An eight-GPU HGX basket remains a proposal, not a requirement imposed by Pyth.

The product goal is an open Blackwell collector network with independently reproducible aggregation and decentralized governance. Preserve that goal when choosing delivery: Pyth may receive a benchmark reproduced by admitted SBX operators, or approve independent native publishers under an agreed methodology. Neither route makes arbitrary collector identities Pyth publishers. The current registry records admission and source policy; it does not establish independent control or a decentralized process for approving changes. Define who proposes, reviews and activates registry and methodology revisions before claiming operational decentralization.

## Keep, delegate and defer

| Component | Decision |
| --- | --- |
| Compute collectors, unit normalization, source evidence and benchmark calculation | Keep: these define the data we supply to Pyth. Reuse existing implementations. |
| Source rights and commercial eligibility | Keep with the benchmark operator; Pyth delivery does not establish them. |
| Pyth managed submission, keys, redundancy and heartbeat | Delegate to the agreed Pyth service; do not duplicate it. |
| Existing official Pyth-agent adapter and native readback | Retain for a native feed if required; not an additional prerequisite for managed HIP-3. |
| Candidate loopback HTTP listener | Keep as a tested integration fixture. Ship it only if Pyth requests this extension; otherwise use their supplied connector. |
| Fixed B200 schedule and single-model publication scope | Inactive product options pending approval; not part of the small correctness PR. |
| SBX collector admission, quorum and reproducible aggregation | Preserve the open-network integrity policy. These serve the benchmark's trust model even when Pyth operates delivery; changes require benchmark governance review. |
| Base/Solana/other consumers | Separate venue-specific delivery work only when required. Base verification does not prove Hyperliquid consumption. |
| Alternative oracle vendors, custom exchange logic and SPVs | Outside Phase 0. No Chainlink/Switchboard adapter or direct Hyperliquid submission exists in the inspected SBX runtime. |

The local harness's empty SEDA configuration satisfies the official resolver schema. No SEDA listener is imported or used; removing required upstream schema fields would break the official fixture, not simplify production.

## Three semantics to agree with Pyth

**Benchmark calculation is not native publisher aggregation.** Pro computes a median of publisher prices after its publisher threshold is met. A fixed-weight SBX basket is a different calculation. Agree whether publishers reproduce one administered value or estimate independently; do not silently turn a specified benchmark into a median of unrelated provider quotes. [Pro price semantics](https://docs.pyth.network/price-feeds/pro/understanding-price-data).

**Source freshness is not delivery freshness.** SBX's model `observedAt` is its oldest contributing observation. Another constituent can update the benchmark while that timestamp stays fixed. The listener must accept that legitimate update without renewing the oldest-source expiry deadline. Pyth Pro also distinguishes payload time from `feedUpdateTimestamp` when carrying forward an aggregate; those timestamps do not automatically establish the age of our underlying tariff observations. [Pro price semantics](https://docs.pyth.network/price-feeds/pro/understanding-price-data).

The existing native adapter maps oldest-source time into `source_timestamp` and suppresses another attempt at the same timestamp, even if a later calculation changes price. Its tests explicitly preserve that behavior. This is a known native-route limitation for asynchronous constituent updates, not proof of complete native delivery. Ask Pyth how benchmark revision time and oldest-input freshness should be represented before changing this durable replay contract; do not fabricate a newer source observation to bypass it.

**A source price is not a complete venue update.** HIP-3 defines oracle, mark and external-perp prices and expects `setOracle` updates every three seconds, subject to the documented minimum interval. Its stale-mark fallback changes market behavior. Pyth and the market operator must agree those fields, availability handling and failure actions; our oracle-only resolver experiment deliberately does not invent mark or external prices. [HIP-3 deployer API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/hip-3-deployer-actions.md).

## What is tested and what the partner must supply

The public Pyth repository's current main was checked on September 9 at `807ff575a9090cee99b9e1a30dc23edf3522fe1b`, matching our pinned resolver. Its application wires named listeners; the managed service's custom-source promise is not a public generic SBX REST specification. We use its unmodified resolver and configuration. [Pinned application](https://github.com/pyth-network/pyth-crosschain/blob/807ff575a9090cee99b9e1a30dc23edf3522fe1b/apps/hip-3-pusher/src/pusher/main.py), [pinned resolver](https://github.com/pyth-network/pyth-crosschain/blob/807ff575a9090cee99b9e1a30dc23edf3522fe1b/apps/hip-3-pusher/src/pusher/price_state.py).

Local tests establish exact decimal handling, genuine HTTP calculation, stale-input refusal, partial constituent refresh, conflict detection and listener lifecycle clearing. The HTTP candidate trusts a loopback process, does not authenticate remote JSON independently, and has in-memory watermarks. Do not expose it as a production remote connector or claim persistent replay protection.

Ask Pyth for the accepted service, input schema and identifiers, source authentication, timestamp mapping, restart/replay contract, test endpoint, availability/fallback behavior and responsibility for actual venue updates. Pro publishers use authenticated and feed-permissioned connections; open SBX node participation does not grant Pyth publisher access. [Pro architecture](https://docs.pyth.network/price-feeds/pro/how-lazer-works).

Then prove approved input -> accepted Pyth delivery -> independently observed venue oracle state, including outages and restart. A successfully delivered reference still needs the venue's product and risk review. [HIP-3 market responsibilities](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-3-builder-deployed-perpetuals).

Use the existing [partner packet](PYTH_PARTNER_PACKET.md) for the precise questions and the [HTTP acceptance guide](PYTH_HIP3_HTTP_ACCEPTANCE.md) to reproduce the experiment. No new production protocol, invented feed ID or guessed authentication layer is required before Pyth supplies the contract.
