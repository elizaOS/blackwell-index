# Pyth readback monitor

Protocol review: September 6, 2026. Library: `src/pyth/readback.ts`. Operator command: `src/pyth/readback-cli.ts`.

The module observes authenticated Pyth Pro output and compares it with approved SBX expectations. It does not publish, verify router signatures, establish which publisher contributed, submit transactions, or prove onchain delivery. An API key does not grant publisher admission, feed assignment, source rights, or redistribution rights. See [Pyth publication](PYTH.md) for those prerequisites.

No production feed IDs, token values, approved manifest, live monitoring evidence, or fabricated prices are supplied. Test values are isolated fixtures. The included command implements protected local state and snapshot verification; no supervisor, credentials or paging service is installed automatically.

## Verified API contract

The monitor fetches metadata from `GET https://pyth.dourolabs.app/v1/symbols`, then requests `POST https://pyth-lazer.dourolabs.app/v1/latest_price`. Only the price request receives a server-side `Authorization: Bearer` credential. The consumer credential is distinct from the signing agent's key and publisher ingress credentials. [REST API](https://docs.pyth.network/price-feeds/pro/api/rest).

Requests contain approved numeric `priceFeedIds`, `channel`, `parsed: true`, `formats: []`, and the properties `price`, `confidence`, `exponent`, `publisherCount`, `feedUpdateTimestamp`, and `marketSession`. The live Router OpenAPI version 1.0.0 defines the response as `JsonUpdate`, whose `parsed` member contains `timestampUs` and `priceFeeds`; it is not the WebSocket subscription wrapper. Its `formats` array has no minimum length. Parsed-only output deliberately supplies no signature proof. [Live OpenAPI](https://pyth-lazer-0.dourolabs.app/docs/openapi.json).

The same schema allows `real_time`, `fixed_rate@50ms`, `fixed_rate@200ms`, and `fixed_rate@1000ms`. The prose also mentions a 1 ms channel, which the inspected live schema does not list. The monitor rejects that mismatch pending review. OpenAPI documents excessive feed counts as HTTP 400 but supplies no numeric request maximum. The local batch limit of 100 is therefore a resource bound, not a promised Pyth entitlement; lower `maxFeedsPerRequest` if the approved subscription requires it. There is no automatic endpoint or unauthenticated fallback. [REST API](https://docs.pyth.network/price-feeds/pro/api/rest), [live OpenAPI](https://pyth-lazer-0.dourolabs.app/docs/openapi.json).

Catalog ID, symbol, exponent, publisher minimum, active state, quote currency and channel capability must agree with the approved policy. `pyth_lazer_id` is a numeric Pro identifier; a nullable `hermes_id` is a different Core mapping and cannot be substituted. This monitor requires a fixed approved minimum; feeds with session-dependent requirements need an explicit policy review. [Symbology reference](https://docs.pyth.network/price-feeds/pro/symbology-reference).

## Freshness and completion

Three times have different meanings:

| Time | Check |
| --- | --- |
| Original eligible SBX source time | Supplied by the trusted expected-print reader; never replaced by calculation, queue or monitor time. |
| Pyth `feedUpdateTimestamp` | The aggregate's generation time; must be fresh, not future-dated, and at least as recent as the expected source. |
| Pyth envelope `timestampUs` | Response/update time; must be fresh and no earlier than that feed's generation time. It cannot refresh an old price. |

Pyth carries an earlier aggregate when it cannot produce a new one. The response may therefore arrive now while its price is old. [Payload reference](https://docs.pyth.network/price-feeds/pro/payload-reference).

The documented carry-forward fields include price, confidence, publisher count and generation time. Only `marketSession` may change without a new aggregate. Accordingly, the monitor rejects different normalized price/confidence/count data at the same feed timestamp; session changes alone are not conflicts. It also rejects timestamp rollback. Publisher count on a carried price describes that earlier aggregate, not present publisher liveness. [Price semantics](https://docs.pyth.network/price-feeds/pro/understanding-price-data).

Integer strings remain exact. Safe JSON integers are accepted and normalized; unsafe numbers are rejected instead of rounded. Timestamps use microseconds and BigInt comparisons. Positive prices and nonnegative confidence must fit signed 64-bit bounds. Expected decimal prices convert exactly at the approved exponent, with separate confidence and price-deviation limits.

A valid expectation is required before a high-water mark advances. Its source time must itself be fresh. Missing, stale or inconsistent expectations produce degraded results. A newly calculated snapshot over old observations is not a new expectation. The library cannot establish the authenticity of a caller-supplied expectation: the wrapper owns signature, source eligibility, configuration and snapshot checks.

| Result | Meaning |
| --- | --- |
| `DISABLED` / `NOT_CONFIGURED` | Disabled policy, missing current approval, or missing consumer token; no HTTP requests. |
| `UPSTREAM_OBSERVED` | All requested feeds passed and at least one generation timestamp advanced after durable state persistence. |
| `UNCHANGED` | All feeds still pass, but no generation timestamp advanced. It is not new publication evidence. |
| `DEGRADED` | A feed, catalog, transport or response failed. Inspect sanitized codes; never treat this as complete coverage. |
| `BACKOFF` | The persisted retry deadline has not elapsed; no HTTP requests. |
| `BLOCKED` / `PERSISTENCE_FAILED` | Configuration/state review or durable storage repair is required. The loop stops. |
| `ABORTED` | Cancellation requested; no new success claim. A completed durable write may be returned as state. |

Every report explicitly includes `publisherAttribution: NOT_ESTABLISHED`, `signatureVerification: NOT_PERFORMED`, and `onchainVerification: NOT_PERFORMED`. First observation has `bootstrap: true`; an existing upstream aggregate is not proof of a just-completed SBX submission.

## Operator command

Use an existing private node directory with approved registry, methodology and Pyth manifest. Supply `PYTH_PRO_API_KEY` through the service environment or secret manager; there is no token command-line argument. Copy and review the disabled example configuration before enabling it. Its freshness, confidence and deviation limits are examples, not approved SBX policy. The example allows 15 minutes of source/feed age and 30 seconds of envelope age; a 30-second source limit would not fit the current five-minute capture cadence. The approved manifest can impose a stricter limit, and the two policies must be reconciled before activation.

```sh
bun run pyth:readback --dir /absolute/private/node \
  --node-config config/node.local.json --config config/pyth-readback.json \
  --state data/pyth-readback.sqlite --init-state --once
```

`--init-state` authorizes only the reviewed first bootstrap. Omit it on every restart. A missing state without that flag, an existing state with it, an empty or corrupt database, and unexpected SQLite sidecars require operator review. Do not delete state to bypass a rollback or policy mismatch. Omit `--once` for continuous operation under a single-owner supervisor; SIGINT/SIGTERM stop it cooperatively. Exit 0 means disabled configuration or a successful one-shot observation; exit 1 means configuration, storage or monitoring failure; exit 130 means cancellation. Supervisors must inspect the report status, not only the exit code.

All supplied paths stay inside the node directory. Configuration must be owned by the running user and not group/world writable; the source journal, state file and state directory must be private. Links, hard-linked files, unsafe parents, overlapping state/source paths and source replacement are rejected. The command opens the source journal read-only, validates the retained snapshot and signed inputs, and reproduces the calculation before using its original prices and source times. It never creates a substitute price when that evidence fails.

State is a separate, bounded SQLite database with an exact schema, DELETE journaling, FULL synchronous writes, explicit file/directory synchronization and compare-and-swap checks. The command waits for durable state before reporting a result. A private exclusive `.lock` file prevents overlapping local processes; locks are never stolen automatically. After a crash, stop and verify the former process, reconcile state and sidecars, and review the lock before an authorized removal. A local lock does not fence a second host or protect against an operator restoring an older state file.

The command emits sanitized JSON reports without credentials or private state. It limits output waits and reports terminal monitor failures. Configure external alerts for stale feeds, stopped reports, entitlement denial and storage failures. Restoring this state is a separate operational responsibility from restoring the publishing journal.

## Library integration contract

Exports are `pythReadbackConfigSchema`, `pythReadbackStateSchema`, `readbackTick` and `runReadbackMonitor`, with their TypeScript types. No shared journal tables or filesystem writes are added by this module.

`readbackTick` accepts the configuration, current approved publication manifest, previous state, expected prints, backend environment, optional abort signal, and an awaited `persistState` callback. An expected print contains an assigned `feedId`, exact decimal `price`, and original `sourceTimestampUs` string. Load real values from verified local evidence; do not copy test fixtures into configuration.

`runReadbackMonitor` adds a required abort signal, `getExpectedPrints` and optional `onReport`. It runs one tick at a time and retains no growing report history. The monitor must run independently of successful publication, so a stalled collector or publisher still produces a freshness alert.

Alternative wrappers must satisfy the same contract:

1. Validate protected configuration/state before making requests. Keep policy disabled until external approval and token entitlement are confirmed. Supply the token through the configured environment name, default `PYTH_PRO_API_KEY`; never store its value in configuration, reports, logs or backups.
2. Establish one exclusive writer per state scope, including across restarts and hosts. The library does not provide a lock, distributed lease or automatic failover.
3. Read a bounded regular state file without following links, enforce private owner/permissions, and reject unexpected schema or corruption. A missing state is a deliberate first bootstrap, not an excuse to reset a previously running monitor.
4. Make `persistState` durable before resolving, using a validated transactional database as the supplied command does, or complete protected file writes with fsync, atomic replacement and directory fsync. Reject on any failure; do not report success on an asynchronous write queued for later. Do not mutate the supplied state object.
5. Preserve accepted feed high-water marks and retry deadlines during restart, backup and recovery. State is scoped to the reviewed configuration and manifest bindings/approval hashes. Policy changes or restored-state mismatches require explicit reconciliation, not deletion and bootstrap.
6. Keep callbacks bounded and cooperative with shutdown. HTTP cancellation does not cancel a hung caller-owned persistence, expectation or report callback. A supervisor must detect missing heartbeats without starting an overlapping writer.
7. Alert on stale/missing prices, rollback/conflicts, approval expiry, entitlement errors, persistence failures and stopped monitoring. Save a bounded operational history separately if needed. The state file is a current watermark, not an audit log or proof against rollback of the file itself.

## Resource and failure bounds

Up to 512 approved bindings are checked in sequential batches of at most 100. Every requested feed must be accounted for, including missing feeds. Each batch retains its own envelope; early batches are checked again at final observation time. A later batch transport/schema failure discards all candidate advances from that tick and preserves prior durable watermarks. A completed response set with individual invalid feeds can advance other valid feeds, but the overall result remains `DEGRADED`.

Limits are 8 MB for the catalog, 1 MiB for each price response, 16 MiB total response bytes per tick, a 60-second aggregate network budget, and a configurable request deadline capped at 30 seconds. Streaming byte counts enforce limits even without truthful Content-Length. Only valid UTF-8 JSON is accepted. Redirects are rejected; arbitrary server bodies and exception strings never appear in reports. The polling interval is 1 second to 1 hour; default is 30 seconds. Backoff and Retry-After are persisted and capped at one hour. This is not a rate-limit entitlement: agree appropriate polling and batch limits with the provider.

## Required live acceptance

- Obtain the actual approved manifest and an entitled consumer API token. Confirm the numeric feed bindings, currency, exponent, publisher minimum, data rights and batch/channel limits with Pyth.
- Install and exercise the included command under an owned supervisor, including protected single-owner state and the trusted expected-print reader. Restore its last durable watermarks before restarting.
- Observe repeated real upstream generation changes against genuinely fresh source prints. Exercise source loss, carried prices, missing feeds, wrong units, expiry, denied access, rate limits, restart and storage failure. Isolated tests do not satisfy this evidence.
- Obtain separate publisher-specific relayer/history evidence if claiming our publisher contributed. Aggregate value agreement alone cannot establish attribution.
- Implement the selected [Base Sepolia Pro integration](PYTH_CHAIN_SELECTION.md), then Base mainnet. Confirm network/chain ID, official verifier contract and version, feed-ID mapping, RPC access, transaction signer, gas budget and receipt/readback requirements. No transaction authority or funding is supplied by this module. Pro payload verification and Core stored-feed readback are different integrations. Solana and Robinhood Chain require separate acceptance. [Pro EVM integration](https://docs.pyth.network/price-feeds/pro/integrate-as-consumer/evm), [Core upgrade contracts](https://docs.pyth.network/price-feeds/core/upgrade/contracts).

Focused tests: `bun test test/pyth-readback.test.ts test/pyth-readback-cli.test.ts`. They use isolated fixtures and local HTTP only; no live credentials or production prices are queried. Command tests also exercise real child-process startup, missing-key behavior and signal shutdown.
