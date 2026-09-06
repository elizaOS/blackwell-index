# Cloudflare deployment

This Worker serves the public sites and two persistent oracle nodes. Both hosted nodes belong to **one operator group**, `elizaos-cloudflare`. Separate keys and databases do not establish independent control.

The configuration collects real public Oracle, Azure and Verda catalogs into private storage. It does not approve redistribution, derived publication, an operator quorum, methodology or Pyth publication. An unavailable feed and HTTP 503 from `/v1/ready` are the correct initial result.

## Requirements

- A Cloudflare account with Workers and SQLite Durable Objects enabled, and authority over the six configured hostnames.
- Wrangler authentication with Worker deployment and route/domain permissions. Use `bunx wrangler@4.129.0 whoami`; do not put account tokens in source files.
- The committed, tested source and its lockfile. No local node identity or SQLite database is uploaded.
- A responsible operator for storage, collection failures, source permission expiry, key custody and deployment review. Confirm current usage allowances and billing before production operation.

The four registered domains and their receipts are recorded in [Domain status](DOMAIN_STATUS.md). Cloudflare creates the Worker Custom Domain DNS records and certificates when the deployment succeeds; registration alone does not establish DNS or working TLS. Do not replace unrelated DNS records. [Custom Domains documentation](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

## Routes

| Host | Result |
| --- | --- |
| `blackwellindex.com` | Index site and primary node API |
| `primary.blackwellindex.com` | Primary node API and index site |
| `secondary.blackwellindex.com` | Secondary node API and index site |
| `blackwell.fyi` | HTTP 308 to the same path on `blackwellindex.com` |
| `blackwell.today` | HTTP 308 to the same path on `blackwellindex.com` |
| `altx.exchange` | ALTX landing page at `/` |

The Worker also exposes `/node/primary/v1/status` and `/node/secondary/v1/status`, and the same prefixes for the other node API routes. Use **host-root URLs**, not these prefixes, for peer configuration. The current peer protocol resolves `/v1/...` from the host root. Object names are restricted to `primary` and `secondary`; requests cannot allocate arbitrary nodes.

## Build and deploy

Run from this repository's root:

```sh
bun install --frozen-lockfile
bun run verify
bunx wrangler@4.129.0 deploy --dry-run
bunx wrangler@4.129.0 deploy --var SBX_RELEASE:$(git rev-parse HEAD)
```

The deployment command changes the configured Worker, six Custom Domains and scheduled trigger. The command records the committed revision in `hosting.release` on the node status endpoint; verify it matches the deployed source. Record the deployed Worker version alongside that commit. Do not deploy an unreviewed working tree. Rebuild after any code or configuration change.

After changing bindings or compatibility settings, regenerate the checked-in runtime declarations:

```sh
bunx wrangler@4.129.0 types --include-env false src/cloudflare/worker-configuration.d.ts
```

### First deployment checks

```sh
curl -fsS https://primary.blackwellindex.com/v1/status
curl -fsS https://secondary.blackwellindex.com/v1/status
curl -fsS https://blackwellindex.com/v1/feeds
curl -i https://blackwellindex.com/v1/ready
curl -I https://blackwell.fyi/
curl -I https://blackwell.today/
curl -I https://altx.exchange/
```

The first status request initializes that node and schedules collection. Wait for each node's `collection.status` to finish, then inspect the real observation count, per-source status, errors and next collection time. Verify the public keys differ, the operator group is the same, private observation counts are not public prices, public reports contain no unapproved observations, and no price appears while readiness is false. Recheck both nodes after one collection interval and after an ordinary redeployment: identities and counters must persist.

The 15-minute scheduled trigger initializes both fixed nodes and rearms missing alarms. Each alarm schedules the next collection five minutes after completion. Collection is sequential by source. Exceptions leave a failed status and schedule a retry; source errors retain only codes/counts in public diagnostics, never response snippets or credentials. Cloudflare alarms are at-least-once, not exactly-once. An immediate retry after a completed cycle is skipped; an interrupted cycle may be retried with a later signed sequence. [Alarms documentation](https://developers.cloudflare.com/durable-objects/api/alarms/)

## Configuration and provider credentials

The following non-secret values are configured in `wrangler.jsonc`:

- `SBX_NETWORK`: registry network, initially `sbx-mainnet`.
- `SBX_OPERATOR_GROUP`: controlling operator group for both nodes. An admission claiming a different group for a hosted identity is rejected.
- `SBX_COLLECTORS`: comma-separated adapter identifiers, initially `oracle-public,azure-retail,verda-public`.
- `SBX_COLLECTION_INTERVAL_MS`: 30 seconds through 24 hours; initial value is five minutes.

Optional `SBX_REGISTRY_JSON`, `SBX_METHODOLOGY_JSON` and `SBX_PEERS_JSON` are validated JSON strings. Absent values use the shared draft configuration and an empty peer list. Invalid configuration fails closed. Archive and review configuration changes before deployment. Do not count the two managed nodes as two independent operators when writing an approved registry.

Set a provider key with Wrangler's interactive secret prompt, for example:

```sh
bunx wrangler@4.129.0 secret put LAMBDA_API_KEY
```

Supported credential names are `LAMBDA_API_KEY`, `RUNPOD_API_KEY`, `VAST_API_KEY`, `GOOGLE_CLOUD_BILLING_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`, `HYPERSTACK_API_KEY`, `SHADEFORM_API_KEY` and `PRIME_INTELLECT_API_KEY`. Google also requires an explicitly researched `GOOGLE_BILLING_SKU_MAP_JSON` configuration. Shadeform requires `SHADEFORM_BILLING_CURRENCY=USD` and a `SHADEFORM_BILLING_EVIDENCE` reference to actual written confirmation. Prime Intellect requires only Availability → Read, remains disabled by default and has no approved source rights; see its [account and scope requirements](PRIME_INTELLECT.md). The configured source must also be enabled in `SBX_COLLECTORS` and permitted to collect by the registry. An API key does not establish publication rights. The public-source deployment requires no provider secrets. Use `.dev.vars` or a private local secret store for local development; never commit keys or paste them into shell arguments.

The private `collector_schedules` SQL table persists 429/503 backoff deadlines across deployments. A throttled source is skipped until eligible while other sources can proceed. Public diagnostics expose only status, failure count and next attempt time. The schedule never stores credential headers, URLs or response bodies.

Pyth publisher keys are not used by this Worker. Its Pyth status remains `NOT_PUBLISHED`; see the separate publisher integration and admission requirements before enabling publication.

## Storage and recovery

Each SQLite Durable Object owns a randomly generated Ed25519 identity, sequence counter, reports, private captures, raw evidence and hash-chained snapshots. Identity is stored in private Durable Object storage, not source code or environment variables. The Worker has no public route to retrieve a private key, raw capture or evidence body.

The SQL adapter uses synchronous cursors and `transactionSync` for atomic operations. Cloudflare limits an individual row or BLOB to 2 MB. Private evidence is therefore stored in 512 KiB `evidence_chunks` rows with metadata in `evidence` and `evidence_sizes`; `evidence.body` is intentionally empty. `CloudflareJournal.evidenceBody()` reconstructs the exact original bytes and verifies SHA-256. Backup tooling must preserve all three tables, not export `evidence.body` alone. [SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [storage limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

Large private captures are split into bounded `captures` rows without discarding observations. `collection_captures` records completed capture cycles, so `counts.captures` and `captureCounts()` count cycles while `counts.captureBatches` counts storage rows. Reports and proofs retain the shared journal's bounds. Storage is not automatically deleted or compacted: monitor `hosting.storageBytes`, schedule private checkpoints and arrange larger-journal archival and retention before reaching either the export or account/object limit.

An ordinary code deployment retains these objects. Deleting a namespace, changing the Worker/binding identity or restoring storage can affect node continuity. Point-in-time recovery is not a safe automatic signer rollback: restoring an old nonce can produce conflicting signed batches. Before recovery, stop signing, reconcile the highest published sequence and either safely advance it or rotate/admit a new identity. Do not treat a database restore alone as an oracle recovery procedure.

The [hosted recovery tool](HOSTED_RECOVERY.md) uses an authenticated private service binding, not a public HTTP export route. It obtains a signed checkpoint of allowlisted journal tables, verifies exact evidence chunks and capture-cycle reconstruction locally, and creates an encrypted backup through the [recovery commands](RECOVERY.md). The source's private signer and provider credentials are excluded. Restoration creates a new, disabled self-hosted identity; it does not replace the running Durable Object.

The signed logical export is capped at 8 MiB. Tool implementation is not evidence of a completed live recovery drill. Verify the deployed revision, then assign offsite storage, separate key custody, retention, alerts and host-loss recovery ownership. Larger journals require a separately reviewed streaming archive; do not delete retained evidence to fit the cap.

After verified import or restore, the [operating study](OPERATING_STUDY.md) can analyze the local private journal without requesting prices or publishing results. Its 30-day qualification remains `NOT_ESTABLISHED`; source coverage and actual elapsed operation need independent review.

## Local verification

```sh
bun test src/cloudflare/sql.test.ts
bunx wrangler@4.129.0 dev --local --port 8788 --persist-to /private/path/sbx-local
```

Use a newly created private directory for local state. Local collection makes real requests to enabled providers and stores their actual responses. Test fixtures in the SQL unit tests are separate from the Worker bundle. Stop the local development server after testing; its development inspection routes must not be publicly exposed.

Before production publication, complete the source-rights, independent-operator, methodology, security, retention and Pyth onboarding requirements in the repository's launch documentation. This deployment provides collection infrastructure, not proof that those requirements are satisfied.

### Initial local acceptance record — 6 September 2026

Wrangler 4.129.0's local workerd runtime passed the following checks before deployment:

- Both nodes collected 42 real observations: four from Oracle and 38 from Azure, covering B200, B300, GB200 and GB300. Each stored five source responses, with zero source errors and no provider credentials.
- Each node shared zero observations. All 33 configured feeds had null prices, `/v1/ready` returned 503 and `/v1/reports` returned an empty report list.
- A full local server shutdown/restart preserved each distinct public identity, capture count, evidence count, snapshot count and scheduled alarm. Both nodes retained the same operator group.
- The local scheduled-event hook completed successfully. Index, ALTX and methodology paths returned 200 with security headers; internal and unknown-node paths returned 404.
- Three SQL adapter tests passed, with 16 assertions covering atomic rollback, a 3 MiB evidence round trip and complete capture splitting with cycle counts preserved. Type checking and the deployment dry run passed.

These are local-runtime checks, not production acceptance. Verify all six actual hostnames, TLS, live source access, recurring collection and deployed revision after publishing. Catalog counts are observations from this test date, not fixed expected market coverage.

### Provider expansion local acceptance — 6 September 2026

After adding Verda and durable collection scheduling, fresh local workerd nodes each collected 64 real observations: Oracle 4, Azure 38 and Verda 22, with six source responses and no errors. A full shutdown/restart with the same private persistence directory preserved both distinct identities, the private capture and evidence counts, and scheduled alarms. Both nodes still represented one controlling operator group.

The expanded ten-provider registry exposed 45 unavailable feed slots, all with null prices. Shared observations remained zero, reports were empty, readiness returned 503 and internal wake routes were denied. No authenticated provider keys were used. These local expansion checks are separate from the initial 42-observation record and must be followed by exact-revision hosted acceptance.
