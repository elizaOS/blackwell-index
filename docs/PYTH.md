# Pyth publication

Research and protocol verification: September 6, 2026.

## Current architecture

Pyth Core migrated on August 26, 2026. The upgraded Core interface is served by Pyth Pro infrastructure: five routers independently compute aggregates, and onchain verification requires three router signatures. Pythnet and the former Wormhole price-signing path are legacy architecture. The official migration documents take precedence over older publisher pages that still describe buying validators and publishing to Pythnet. [Upgrade architecture](https://docs.pyth.network/price-feeds/core/upgrade/how-it-works), [migration governance](https://forum.pyth.network/t/passed-op-pip-100-pyth-core-to-pyth-pro-migration/2420), [Pythnet sunset](https://forum.pyth.network/t/passed-op-pip-128-pyth-core-sunset-fee-zeroing-balance-repatriation/2662).

Pyth Pro is permissioned. Publishers connect to authenticated relayers and receive permission for specific feed IDs. Douro Labs operates ingress; a distributed queue feeds the independently operated routers. Open source SBX collectors can join the observation network, but this does not grant Pyth publisher permissions or make the Pyth transport permissionless. [Pyth Pro architecture](https://docs.pyth.network/price-feeds/pro/how-lazer-works).

Pyth's published onboarding policy prioritizes first-party data. Acceptance of ALTX as a benchmark administrator, aggregation of third-party tariffs, and provider-specific benchmark listings need explicit confirmation. A provider running its own approved publisher is the strongest first-party route. [Publisher onboarding](https://docs.pyth.network/price-feeds/core/publish-data), [publisher application](https://www.pyth.network/publishers).

The public symbol catalog at `https://pyth.dourolabs.app/v1/symbols` returned 3,662 entries in a 4,746,234-byte response on September 6, 2026; none matched B200, B300, GB200, GB300, Blackwell or SBX in symbol/description. This proves no matching entry in that response, not a promise that private or future feeds do not exist. SBX feed IDs must be assigned and verified; none are invented in production configuration. The runtime's catalog limit is 8 MB.

## Two aggregation layers

The SBX methodology determines provider and model weights. Independent SBX nodes compute the same benchmark from the same eligible signed observation set. Pyth then aggregates its accepted publishers' submitted values. Its current Pro price is the median after a feed-specific publisher minimum; its confidence represents publisher quote dispersion. It does not automatically produce our desired weighted average. [Pyth price semantics](https://docs.pyth.network/price-feeds/pro/understanding-price-data).

Agree with Pyth whether each SBX model/composite feed accepts independently computed copies of the administered benchmark or uses a designated administrator. Provider feeds also need a definition: a provider's exact advertised tariff, a within-provider aggregate, and a cross-provider market estimate are distinct products. A single-provider feed cannot honestly claim independent economic price discovery merely because many nodes retrieve its page.

SBX's absolute input deviation bound is not an executable bid/ask and is not copied into those Pyth fields. A low Pyth confidence on identical benchmark copies can coexist with substantial uncertainty about the underlying compute market. Publish SBX coverage, source age, weight and dispersion metadata alongside the Pyth value.

## Implemented interface

The implementation targets official `pyth-lazer-agent` **0.16.0** and `pyth-lazer-protocol`/`pyth-lazer-publisher-sdk` **0.46.0**, inspected from the crates.io release artifacts and current [Pyth Pro tools repository](https://github.com/pyth-network/pyth-lazer-public). The agent's [README](https://github.com/pyth-network/pyth-lazer-public/blob/main/agent/README.md) explains publisher key onboarding and team-supplied ingress URLs. Old `pyth-agent` 3.x is unsuitable as the default new deployment because it retains Pythnet state and a different compatibility interface.

`src/pyth/index.ts` prepares the current JSON-RPC request for `ws://127.0.0.1:8910/v1/jrpc`:

```json
{
  "jsonrpc": "2.0",
  "id": "sbx-<snapshot hash>",
  "method": "push_updates",
  "params": [
    {
      "feed_id": "<Pyth-assigned numeric ID, not a string>",
      "source_timestamp": "<Unix microseconds as an integer, not a string>",
      "update": { "type": "price", "price": "<integer mantissa, not a string>" }
    }
  ]
}
```

The placeholders above explain types; they are not runnable configuration. The official agent batches updates, encodes a protobuf `LazerTransaction`, signs it with Ed25519, wraps it in `SignedLazerTransaction`, and sends it to approved `/v1/transaction` relayers. The SBX client does not handle that private key. Source time is preserved from the eligible SBX observation, not reset to the publication wall clock. Decimal conversion is exact and rejects unsupported precision and unsafe JSON integers.

The protected manifest binds the network, methodology hash, provider/operator registry hash, approved publisher identity, approval evidence/expiry, confirmed ingress and feed ID/symbol/exponent/minimum-publisher mappings. Fresh official metadata must match before submission. Unavailable feeds are skipped and stale prints rejected. The manifest is an operator assertion backed by an external approval record; its presence is not cryptographic proof of Pyth approval.

`prepare` only constructs a request. `publish` sends it to the local signing agent:

```sh
bun src/pyth/cli.ts prepare /run/secrets/pyth-manifest.json /var/lib/sbx/snapshot.json
bun src/pyth/cli.ts publish /run/secrets/pyth-manifest.json /var/lib/sbx/snapshot.json
```

Run these only with an approved, trusted snapshot and a current protected manifest. `QUEUED_LOCAL` means only that the local agent accepted the request into its queue. Relayer rejection, delayed forwarding, insufficient publishers and stale aggregation can still prevent any public update.

### Automated operation

`src/pyth/runtime.ts` exports `publishSnapshot(snapshot, manifest, journal)` for the collection cycle. It checks the same approval and snapshot gates, retrieves the current official symbol catalog with a timeout and byte limit, and sends only feeds whose original source timestamp advances. A short durable lease prevents overlapping publisher ticks. The intended deployment is one active publishing process per approved key; the lease is not a distributed signing or failover protocol.

Per-feed attempted and locally queued source timestamps survive restart. The runtime reserves a timestamp before contacting the agent: a crash, lost acknowledgement or timeout is `DELIVERY_UNCONFIRMED`, never successful publication. It does not automatically resend that ambiguous timestamp. A genuinely newer source observation is required; operators must reconcile ambiguous attempts using agent and upstream evidence. Successful local receipts are retained in a bounded operational log, separately from the permanent per-feed high-water marks. A new calculation time or changed price alone cannot refresh an old source timestamp.

Without an approved protected manifest, the automated hook must remain unconfigured. No API key, assigned feed ID, publisher approval or relayer endpoint is supplied by this code. Upstream monitoring remains a separate acceptance requirement below.

## Readback and completion evidence

Pyth may carry the previous value forward when publisher quorum is absent. Consumers must examine `feedUpdateTimestamp`, not only the envelope's `timestampUs`, and check publisher count and confidence. The adapter rejects missing, stale, future or non-advancing feed time and unexpected feed identity, units or price. [Payload fields](https://docs.pyth.network/price-feeds/pro/payload-reference).

`UPSTREAM_OBSERVED` verifies independently fetched output against its expected metadata and value. It does not prove which publisher contributed or verify router signatures by itself. Completion requires all of:

1. Pyth publisher identity acceptance and per-feed permissions in the target environment.
2. Assigned provider feeds, four model feeds and the composite, with approved methodology semantics and source rights.
3. Actual relayer acceptance for our key/feed mapping, with a publisher audit/history record.
4. Repeated fresh Pro/Hermes output advancing through the operational test period, reconciled against our benchmark evidence.
5. Onchain verification using the official supported chain contract, a transaction receipt and readback of feed ID, exponent, price, confidence and original generation time.
6. Source-loss, publisher-loss, key rotation, failover, incorrect exponent and carried-price drills.

No configured adapter, local acknowledgement, mocked integration test, SDK installation or contract deployment alone satisfies these requirements.

## Accounts and costs

- Pyth publisher onboarding: accepted organization, permitted public key, assigned feeds, source rights and test/production ingress. The public docs provide no guaranteed listing time, SBX fee, minimum publisher count or universal capital requirement. Obtain those terms directly.
- Publisher signing: separate test/production Ed25519 keys held by the official agent, protected file access or an approved signing arrangement, rotation and revocation contacts. Do not reuse collector identity keys.
- Consumer account: Hermes now requires an API key. The recommended upgraded endpoint is `https://pyth.dourolabs.app/hermes`. Put credentials on the backend. [Upgrade procedure](https://docs.pyth.network/price-feeds/core/upgrade/preparing).
- Data subscription: the current public pricing page lists free Terminal view access without API rights, $500/month crypto-only Starter and Pro beginning at $2,500/month with limited redistribution. Those are consumer plans, not an SBX publisher quote. Public redistribution/oracle rights and any publisher-specific access must be confirmed contractually. [Pricing](https://www.pyth.network/price-feeds).
- Onchain updater: RPC account, gas wallet, chain-specific official contract and operating budget. A price pusher relays already signed Pyth updates; it cannot create or list SBX. The current official Price Pusher requires v10.5.0 or later for Hermes authentication. [Price Pusher](https://docs.pyth.network/price-feeds/core/schedule-price-updates/using-price-pusher).
- OIS: rewards are currently paused, while existing stake remains slashable. Do not fund an operating model with assumed staking yield or confuse former Pythnet validator stake with the current Pro publisher requirement. [OIS status](https://docs.pyth.network/oracle-integrity-staking).

## Verification

`bun test test/pyth.test.ts` checks approval/metadata gates, exact prices and time units, unavailable/stale feeds, local acknowledgement semantics and independent output validation. Synthetic test values remain isolated from production data.

For the additional conformance test, install the actual pinned official agent and run:

```sh
cargo install pyth-lazer-agent --version 0.16.0 --locked
PYTH_AGENT_BIN=/absolute/path/to/pyth-lazer-agent bun test test/pyth.test.ts
```

This test creates an ephemeral Ed25519 test identity, starts the official Rust agent and a local test relayer, submits the real current JSON-RPC schema, receives the agent's protobuf transaction, verifies its signature independently and checks feed ID, integer price and original source time. It never connects to Pyth production. The test is explicitly skipped when the official binary is absent.

Registry artifact SHA-256 values verified September 6, 2026:

| Package | Version | SHA-256 |
| --- | --- | --- |
| pyth-lazer-agent | 0.16.0 | `03bb6bbc6343c395183760a45f06c91db2bf864239d7f69bc1a88249c2bf981c` |
| pyth-lazer-protocol | 0.46.0 | `9566ac9c0822830c40896e5b7dda7f2ebbbbb5c9c1c614219c5759da1a50aa8f` |
| pyth-lazer-publisher-sdk | 0.46.0 | `327419fe830a825d05cf99caea88423f354b076d56d2570530f5fe934359609b` |
