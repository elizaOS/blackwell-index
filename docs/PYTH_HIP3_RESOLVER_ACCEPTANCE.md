# Pyth HIP-3 resolver: local acceptance

The local harness runs the unmodified official Pyth HIP-3 resolver against signed, synthetic SBX inputs. It establishes decimal and source-age compatibility at that resolver boundary. It does not establish a managed-service ingestion contract, feed admission, delivery or venue consumption.

## Public implementation used

The source is pinned to `pyth-network/pyth-crosschain` revision `807ff575a9090cee99b9e1a30dc23edf3522fe1b`. The harness fetches only `config.py`, `price_state.py`, `metrics.py`, the upstream project/lock files, README and license. It verifies an embedded SHA-256 for each file before installation and each test. Dependencies come from the unmodified upstream `uv.lock`, using `uv sync --frozen --no-dev --no-install-project` and an isolated Python 3.13.15 environment. [Official application](https://github.com/pyth-network/pyth-crosschain/tree/807ff575a9090cee99b9e1a30dc23edf3522fe1b/apps/hip-3-pusher).

Pyth's public configuration supports a single source identified by `source_name` and `source_id`, with an optional exponent. The harness adds an explicitly local `sbx_local_fixture` state to the resolver's source registry. `localfixture:B200` is only an output key in this test; it is not a deployed market or assigned Pyth feed. A single source without exponent conversion preserves an exact decimal string. Exponent and pair paths use floating point, so this proof deliberately does not select them. [Official configuration](https://github.com/pyth-network/pyth-crosschain/blob/807ff575a9090cee99b9e1a30dc23edf3522fe1b/apps/hip-3-pusher/src/pusher/config.py), [official resolver](https://github.com/pyth-network/pyth-crosschain/blob/807ff575a9090cee99b9e1a30dc23edf3522fe1b/apps/hip-3-pusher/src/pusher/price_state.py).

The reviewed public app has Lazer, Hyperliquid and SEDA listeners. It does not have a generic REST listener matching the broader custom-source capability advertised for Pyth's managed service. The SEDA listener expects that provider's execution request/response structure; it is not repurposed here. Pyth still needs to identify its supported SBX ingestion/authentication interface. [Managed service](https://docs.pyth.network/price-feeds/hip-3-service), [official listener wiring](https://github.com/pyth-network/pyth-crosschain/blob/807ff575a9090cee99b9e1a30dc23edf3522fe1b/apps/hip-3-pusher/src/pusher/main.py).

## Reproduce

Run from the repository root. Preparation explicitly uses the network to download the pinned public source, isolated Python runtime and locked dependencies. It does not contact a price API or start an oracle service.

```sh
python3 scripts/verify-pyth-hip3-resolver.py prepare
```

The separate acceptance command uses the prepared files and installed dependencies. Supply `--bun /absolute/path/to/bun` when the intended Bun runtime is not on `PATH`.

```sh
python3 scripts/verify-pyth-hip3-resolver.py test
bun --no-env-file test test/pyth-hip3-source-fixture.test.ts
```

Default private output: `artifacts/pyth-hip3-resolver/`. It contains source/download provenance, installation and test logs, the synthetic SBX fixture, and `acceptance-receipt.json`. The receipt records source/harness hashes, the installed dependency versions, both runtime versions, passed checks and explicit false values for publication, native feed assignment, managed-ingestion acceptance and venue consumption. Failed runs replace the prior receipt with a failure status.

## What passes locally

The SBX fixture uses `calculate()` on three signed synthetic operator reports, with a B200-only methodology whose approval and provider permissions are expressly test-only. Only values permitted by the shared `isFeedPublishable()` check enter the resolver. The proof checks:

- Exact calculated B200 price `3.123457` and unchanged original `observedAt`.
- SBX refusal of missing fixed constituents, draft methodology, stale input, invalid signatures and feeds outside the approved test scope.
- Missing source produces no oracle value; no substitute source is configured.
- A decimal string passes unchanged without float conversion, including a separate resolver-only value beyond binary floating-point integer precision. That large value is not a valid SBX observation or a live product price.
- Data is accepted just before the resolver's five-second test threshold and rejected at equality.
- Delivering the same source value repeatedly does not renew its original source timestamp; it expires on schedule.
- An unchanged tariff with a genuinely later successful retrieval can be fresh. That last check is a resolver simulation, not evidence of an actual provider request.

The first successful run passed 26 checks using Bun 1.4.2 and Python 3.13.15. Consult the private receipt for the current result and exact source hashes; do not apply a past receipt to edited code. The five-second threshold is an acceptance fixture setting, not an agreed SBX service SLA.

For a separate proof crossing actual local HTTP, see [SBX HTTP listener acceptance](PYTH_HIP3_HTTP_ACCEPTANCE.md). That candidate extension adds transport validation without claiming managed-service acceptance or starting the publisher.

## Execution boundary

The Bun child starts with an empty inherited credential/provider environment, dotenv disabled, and the existing capacity network guard loaded before fixture imports. It generates ephemeral synthetic signing identities in memory; it never reads operator keys. The Python child uses isolated interpreter mode and a similarly minimal environment. A CPython audit hook blocks socket creation, DNS and child-process operations before any upstream imports. Three deliberate guard probes must be rejected; any later such attempt fails acceptance. These are application-level guards, not an operating-system sandbox.

The Python fixture imports only the official configuration, resolver and metrics definitions. It never constructs a publisher, listener, key manager or metrics server. Setting `enable_publish=false` in the full application would not provide this isolation: its startup still constructs a key-bearing publisher and network listeners. [Official publisher initialization](https://github.com/pyth-network/pyth-crosschain/blob/807ff575a9090cee99b9e1a30dc23edf3522fe1b/apps/hip-3-pusher/src/pusher/publisher.py).

SBX's methodology, source rights, fixed constituents, signature checks and publication scope remain SBX responsibilities. The resolver's price/timestamp/session data structure does not preserve or independently verify those SBX facts. The supported managed interface must retain original source age and provide independent delivery/venue evidence before this local extension can become a production integration. No generic partner REST format, authentication scheme, fallback methodology, mark-price policy or actual market identifier is invented here.
