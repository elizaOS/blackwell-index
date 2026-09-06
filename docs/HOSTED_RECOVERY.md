# Hosted node recovery

The operator can export a hosted journal through a private Cloudflare service binding, verify its signed contents locally, and create an encrypted recovery bundle. Restoring that bundle creates a new, disabled self-hosted node. This is an operator tool, not a public API, a restore into a running Durable Object, or an offsite backup service.

This page documents the original V1 format and its fixed limits. The [V2 streaming path](STREAMING_RECOVERY.md) supports bounded export, inspection and chunk-aware restore for larger journals. Check the acceptance record before assuming a given deployed revision includes it. V1 files remain readable; its limits have not been increased.

## Access and procedure

Requirements: Node.js, Bun, frozen development dependencies, authorized Wrangler access to the Worker account, and a protected recovery key. The deployed Worker must include the `RecoveryService` entrypoint. No additional public password, provider credential, R2 account or GPU purchase is required.

Run from this repository. Read the expected full commit and node ID from the release record and independently verify them against the deployed node's `/v1/status`. Do not accept an identity supplied only by an untrusted export. Use new key and output filenames.

```sh
bun install --frozen-lockfile
bun src/cli.ts backup-keygen --output data/hosted-recovery.key
node scripts/export-hosted.mjs --node primary \
  --expected-node-id EXPECTED_64_CHARACTER_NODE_ID \
  --expected-release EXPECTED_40_CHARACTER_COMMIT \
  --key-file data/hosted-recovery.key --output data/primary.sbx-backup
bun src/cli.ts backup-inspect --key-file data/hosted-recovery.key \
  --input data/primary.sbx-backup
bun src/cli.ts restore --key-file data/hosted-recovery.key \
  --input data/primary.sbx-backup --target data/primary-restored
```

Repeat with `secondary` and its distinct expected identity. These two nodes still represent one operator. Save the summaries and independently retained checkpoint hashes. Keep the decryption key separately from any offsite bundle; the local example is not separate custody. Never commit either file.

The helper uses the existing Wrangler login to create an authenticated remote service-binding session. Native Fetcher calls reach only the private named entrypoint and its internal Durable Object binding. They avoid Wrangler's arbitrary-RPC response-stub bridge. The helper receives one bounded Response body, checks the source signature and pinned identity/revision, and passes bytes to a local Bun importer without printing the source response. A failed import prints a fixed error code. There is no public HTTP export route. Anyone authorized to create service bindings to this Worker must be treated as a privileged data custodian.

## What the backup preserves

The Durable Object reads the exact allowlisted journal tables synchronously in one transaction. It refuses collection-in-progress exports, unknown application tables, changed columns, oversized snapshots and malformed values. Private identity KV, provider credentials and Pyth publication configuration are not exported. The existing node signs the export using a separate signature domain without advancing or rewinding its report counter.

The importer verifies signature, source/release, table schema, cell types, evidence chunks, digests and local observation evidence references. It converts physical chunk storage into normal evidence bodies and merges physical capture batches into their original collection cycles. The exact signed logical export is retained as an additional private evidence record. Consequently, the local database bytes and evidence count differ from the hosted physical database; the signed source record remains available for audit.

The existing [recovery verifier](RECOVERY.md) then checks report signatures and routing, counters, configuration hashes, snapshot chains and historical calculation reproduction before AES-256-GCM encryption. Historical raw observations and errors remain private. A source signature proves who exported those bytes, not that supplier prices are true or legally publishable.

Temporary materialization uses a private directory. Normal completion, validation failure and graceful SIGINT/SIGTERM clean it up. SIGKILL, a host crash or power loss can leave protected temporary files: use encrypted local storage and review owned `sbx-hosted-recovery-*` and `sbx-recovery-*` directories after an interrupted operation. Do not run broad wildcard deletion commands. The helper allows a bounded cleanup grace period after its 120-second deadline; it is not guaranteed to exit at exactly 120 seconds.

## Limits and remaining work

- The signed logical export is limited to 8 MiB and 100,000 rows. This deliberately limits peak Worker memory; it is smaller than possible journal growth. Large journals need a separately reviewed streaming archive, including bounded handling of untrusted candidates. Failure at the cap is explicit; do not remove evidence or counters to make an export fit.
- An export is a checkpoint of one object, not an atomic checkpoint across both nodes. It does not prove that every external peer or Pyth consumer has the same latest state.
- Collection-in-progress exports fail and should be retried after collection completes. A persistent failure requires an operator, not publication of an incomplete archive.
- Restoring never imports an old signing key, updates the live hosted object, changes admission or enables publishing. Keep the review marker until all [restore checks](RECOVERY.md#restore-into-a-new-directory) are approved.
- Offsite destination, separate key custody, frequency, retention, recovery objectives, alerts and a host-loss exercise still need an operational owner. A successful local drill does not complete that program.

Cloudflare's built-in point-in-time recovery must not be used to resume a rolled-back signer with its old counter. Coordinate revocation and key rotation first. Its [SQLite storage documentation](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) describes PITR separately from application-level export. The helper follows Cloudflare's [Wrangler Node.js API](https://developers.cloudflare.com/workers/wrangler/api/), [HTTP service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/) and [named entrypoint model](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/#named-entrypoints).
