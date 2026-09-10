# SBX HTTP to Pyth HIP-3: local acceptance

This harness proves a real HTTP transport path from the existing SBX `OracleNode` `/v1/feeds` route into the unmodified official Pyth HIP-3 price resolver. The SBX listener is a **local candidate extension**, not an accepted Pyth managed-service ingress. It is inactive outside this explicit test command. No Pyth publisher or signer, service deployment or market submission is involved.

The previous [resolver acceptance](PYTH_HIP3_RESOLVER_ACCEPTANCE.md) establishes the resolver's price and source-age behavior. This adds actual loopback HTTP, route-level calculation and failure clearing without designing another publication protocol.

## The boundary being tested

```text
Ephemeral signed synthetic operator batches
  -> actual OracleNode signature validation and calculation
  -> GET http://127.0.0.1:<ephemeral-port>/v1/feeds
  -> candidate SbxHttpListener
  -> official PriceSourceState / PriceState resolver
  -> localfixture:B200 decimal string, or no value
```

The fixture uses three synthetic providers, an explicitly synthetic approved B200 scope and exact eight-GPU HGX offer schedule. All inputs and stores are in memory. Its approvals, rights, prices and provider identities provide no live qualification evidence. Failure cases either remove a real synthetic constituent before calculation or deliberately corrupt the resulting HTTP transport envelope.

The listener consumes the existing snapshot schema. It pins network, methodology hash and registry hash, requires exactly the B200 model publication scope, and selects only the model feed `SBX:B200` with a null provider. The methodology hash binds the configured offer schedule and any configured resource requirements. It accepts only an available snapshot and a READY selected feed with consistent calculation time, input-batch references and a canonical, positive, six-decimal price string. It does not create a parallel benchmark, registry or approval system.

`OracleNode` validates the signed operator inputs and enforces SBX's methodology, rights, quorum, source-age and scope gates. The HTTP listener trusts that pinned local process. Snapshot hash fields are identity bindings, **not an independently verified signature on the HTTP response**. This is not suitable as an unauthenticated remote ingestion contract.

The official resolver is pinned to `pyth-network/pyth-crosschain` revision `807ff575a9090cee99b9e1a30dc23edf3522fe1b`. Its existing source-name lookup accepts a separately registered `sbx_local_http` source, with source ID `SBX:B200`. A single-source configuration without exponent conversion preserves the decimal string. `localfixture:B200` is only a test output key. [Official resolver](https://github.com/pyth-network/pyth-crosschain/blob/807ff575a9090cee99b9e1a30dc23edf3522fe1b/apps/hip-3-pusher/src/pusher/price_state.py), [official configuration](https://github.com/pyth-network/pyth-crosschain/blob/807ff575a9090cee99b9e1a30dc23edf3522fe1b/apps/hip-3-pusher/src/pusher/config.py).

## Reproduce locally

Run from the repository root. HTTP preparation copies the already prepared official resolver environment, including its locked dependencies and isolated Python 3.13.15 runtime. It verifies the pinned upstream files, refuses to overwrite its destination, and does not download or install anything. The default prepared source is the original harness's `artifacts/pyth-hip3-resolver`; use `--prepared` to select another existing prepared directory.

On a fresh checkout, prepare that original environment once first. This separate original preparation command downloads the pinned public files, Python runtime and locked dependencies, as documented in the [resolver guide](PYTH_HIP3_RESOLVER_ACCEPTANCE.md):

```sh
python3 scripts/verify-pyth-hip3-resolver.py prepare
```

Then copy it and run the loopback acceptance test:

```sh
python3 scripts/verify-pyth-hip3-http.py prepare
python3 scripts/verify-pyth-hip3-http.py test \
  --bun /absolute/path/to/bun-1.4.2
```

The test requires Bun 1.4.2 and the copied Python 3.13.15 environment. Default private output is `artifacts/pyth-hip3-http/`. No operator configuration, key file or environment credential is read. The explicit `test` command is the only runner; the new fixture is not discovered as a normal Bun test file.

The receipt records every core TypeScript source hash, fixture/listener/harness hashes, upstream source hashes, lock hash, runtime and dependency versions, individual assertions, negative-case and lifecycle outcomes, and actual route request count. It includes explicit false flags for publication, native Pyth feed assignment, managed ingestion acceptance and venue consumption. Failures replace the current receipt with a failed status, while the first failure receipt is retained separately if a failure occurs. Logs and generated runtime files stay in the private artifact directory. Use the same new `--directory` value for preparation and testing when retaining an earlier receipt; `--prepared` can point to any existing verified prepared environment.

## What the test establishes

The September 8 lifecycle checkpoint passed 477 assertions across 104 real route requests, including the existing 40 malformed/unavailable transport scenarios. These include repeated setup/recovery checks; they are not 477 independent integration scenarios. That follow-up uses a separate `artifacts/diagnostic-followup-20260908/hip3-http/` directory and preserves the original 418-assertion receipt. Consult the selected private `acceptance-receipt.json` for the current result and exact source hashes.

- READY -> unavailable -> READY uses actual HTTP and the official resolver. A missing fixed constituent produces no value. Every tested failure immediately removes the source from the resolver state.
- Network, methodology, registry, publication-scope and feed-identity changes are rejected. Duplicate feed IDs, duplicate JSON keys, missing input references, a demo marker and inconsistent calculation timestamps are rejected.
- Numeric prices, noncanonical strings, zero, nonfinite values and oversized prices are rejected. JSON integer size is bounded before parsing; boolean timestamps, nonfinite literals and float overflow cannot become valid source data.
- Malformed bodies, bodies above two million bytes, non-JSON or encoded responses, HTTP failures, redirects and total request timeouts clear the source. Redirects and environment-derived proxies are disabled.
- The accepted `PriceUpdate` retains original `observedAt`, never the HTTP completion time. Repeated retrieval of the same envelope does not renew source age. Both the listener and official resolver reject an observation at the exact configured age limit.
- Accepted source and calculation watermarks survive failures and clearing. Older observations, a different price at the same source timestamp, or older calculation envelopes cannot revive a cleared source within the freshness window. A genuinely later synthetic retrieval can become fresh even when its price is unchanged.
- Closing the listener detaches and invalidates client ownership before awaiting HTTP client shutdown. An already buffered response cannot restore source state or advance watermarks after closing begins. The test holds ordinary HTTP response hooks and client shutdown at deterministic scheduling points while still fetching every body from the actual node route.
- Cancelling a poll clears its source and releases its ownership without advancing accepted watermarks. A concurrent second poll is refused without clearing the first poll's state or ownership. Reopening is refused while a prior poll or close remains in flight; after they settle, reopening retains both accepted watermarks and rejects rollback.
- No fallback, mark-price or external-price source is configured.

The five-second source threshold, two-second snapshot threshold, zero future tolerance and 300 ms request timeout are deliberate test settings, not agreed SBX methodology parameters or a Pyth/venue SLA. Watermarks are in memory only and do not survive process restart. The listener has no daemon, scheduler, restart persistence or production delivery guarantee.

## Execution limits and remaining external decisions

Only an exact `http://127.0.0.1:<port>/v1/feeds` URL is accepted, without credentials, query, fragment or alternate path. The Bun preload blocks ordinary outgoing network and process APIs, with one captured `Bun.serve` exception constrained to a single IPv4 loopback fixture server. Fixture control uses inherited stdin/stdout pipes, not another HTTP endpoint. Startup and control acknowledgements have bounded deadlines; the worker has a separate overall deadline.

The Python worker starts with a minimal environment in isolated mode. Its audit hook is installed before third-party imports and permits connections only to the exact fixture address and port. AF_UNIX socketpairs remain available for asyncio wakeups. Deliberate wrong-port, external-DNS and child-process probes must fail; any unexpected blocked attempt fails the run. These are application-level guards, **not an operating-system sandbox or protection against hostile native code**. An unrelated local process could contact the fixture port; loopback is not authenticated process identity.

Only the official configuration, resolver and metrics definitions are imported. The schema's required unused source blocks contain empty settings; no SEDA, Lazer, Hyperliquid listener, publisher, key manager or main application is imported or constructed. Setting `enable_publish=false` in the full public application would not by itself give this execution boundary. [Official application wiring](https://github.com/pyth-network/pyth-crosschain/blob/807ff575a9090cee99b9e1a30dc23edf3522fe1b/apps/hip-3-pusher/src/pusher/main.py).

Pyth advertises custom REST/WebSocket sources for its managed HIP-3 service, while the pinned public application wires named listeners rather than this SBX candidate. Pyth must still confirm the supported integration route and accept the source: whether it will operate this listener extension or supply its managed ingestion interface, authentication and delivery requirements. This local proof does not establish managed onboarding, native Pyth publication or venue consumption. [Managed HIP-3 service](https://docs.pyth.network/price-feeds/hip-3-service).

Before production, source qualification and rights, real approvals, source-age and outage policy, restart/replay behavior, authenticated service access, publication acknowledgement and venue readback need their own evidence. Their exact contracts should follow the selected Pyth and venue interfaces; this test does not invent them.


## September 9: partial constituent refresh

The listener previously treated an unchanged oldest-source timestamp plus a changed price as a conflict. That is too strict for an aggregate: one constituent can refresh while another remains the oldest input. A signed three-provider HTTP fixture now changes gamma alone, producing the exact updated benchmark with the original oldest-source timestamp. The official resolver accepts it and still expires it at that original deadline. The regression failed on the previous listener.

The correction rejects source-time rollback and conflicting prices at the same calculation time, while allowing a later calculation to change price at an unchanged oldest-source timestamp. This does not authenticate remote responses or persist replay state. Full updated counts and hashes are in the September 9 private acceptance receipt; the September 8 results above remain historical.
