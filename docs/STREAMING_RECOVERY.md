# Streaming recovery

V2 exports a consistent hosted journal or a recovered local journal in bounded blocks, encrypts it locally and restores a new, disabled node. It does not publish prices, copy signing keys, prune source records or provide offsite custody. See the [acceptance record](HOSTED_ACCEPTANCE_2026-09-06.md) for the exact revisions and workloads actually tested. The [design plan](STREAMING_RECOVERY_PLAN.md) records the release gates; implementation alone is not evidence that they passed.

## Operator procedure

Requirements are unchanged: Node.js, Bun, frozen dependencies, authorized Wrangler access and a separately protected recovery key. Independently verify the node ID and full deployed commit against the release record. Use new output filenames outside any public directory.

```sh
bun install --frozen-lockfile
bun src/cli.ts backup-keygen --output data/stream-recovery.key
node scripts/export-hosted-stream.mjs --node primary \
  --expected-node-id EXPECTED_NODE_ID --expected-release EXPECTED_COMMIT \
  --key-file data/stream-recovery.key --output data/primary-v2.sbx-backup
bun src/cli.ts restore-stream \
  --expected-node-id EXPECTED_NODE_ID --expected-release EXPECTED_COMMIT \
  --key-file data/stream-recovery.key --input data/primary-v2.sbx-backup \
  --target data/primary-v2-restored
bun src/cli.ts study --stream --dir data/primary-v2-restored \
  --output data/operating-study.json
```

Repeat for the secondary identity. They remain one independent operator group. Never commit the archive, key or private study. Existing encrypted V1 backups retain their original inspection and restore commands and limits.

The export helper verifies source framing while encrypting, independently inspects the completed archive and only then releases sealed checkpoint staging. `sourceVerified: true` from the writer means descriptor/block/seal verification, not a complete content inspection. Its separate inspection step verifies the database and every historical calculation. A standalone inspection is available with `backup-stream-inspect`, using the same source pins, key and input arguments.

The source permits one active checkpoint. It expires after one hour by default; this is a transfer deadline, not an archive expiration. Block retries use durable boundaries and regenerate identical bytes. Collection continues after checkpoint creation. A changed deployed release cannot resume an unfinished checkpoint. Interrupted encryption leaves encrypted `.partial` ciphertext, not a backup; this helper does not resume partial files. An interruption after encryption completes can leave a final-named archive whose database inspection is unfinished. Run `backup-stream-inspect` successfully before treating that file as verified. Use a new output name for a new download and wait for staging expiry if necessary. Never delete source history to make an export fit.

## What is authenticated

An explicit, versioned membership ledger records immutable table keys in the same transactions as their journal writes. Bootstrap copies keys using SQL, without loading all historical payloads into JavaScript. Checkpoint creation verifies complete membership and freezes mutable counters, candidates and collector schedules in one transaction. Configuration hashes, table counts, source identity, release and snapshot head are signed in a separate Ed25519 domain.

Blocks carry ordered, typed record fragments and a hash chain. A signed terminal seal commits to the exact record counts, byte total and final block hash. Retries reconstruct blocks from immutable rows and frozen state. The application rejects mutation of checkpointed source tables; this is an application invariant, not protection against a privileged database administrator. Unknown tables or changed columns require schema review.

Local encryption uses Node's HKDF-SHA256 and AES-256-GCM with a fresh per-archive salt, distinct frame nonces and authenticated headers, frame indexes, lengths and terminal counts. Inspection requires strict EOF: an authenticated prefix, a missing source seal, a truncated terminal or trailing bytes cannot pass. Successful output is fsynced and promoted without overwriting an existing file.

Restore imports only allowlisted typed rows, never supplied SQL. It retains physical evidence chunks and capture batches, verifies evidence hashes and receipt times, report signatures, counters, quarantine/proof linkage, configuration hashes and the snapshot chain, and reproduces every snapshot with its archived inputs and configuration. Batches are checked against unique collection markers, not treated as extra cycles. Original descriptor, seal and encrypted-archive digest remain as provenance; the entire archive is not duplicated inside the database.

The source signing key is not recovered; its public identity remains in provenance. Restore creates a fresh signer, disables collectors, peers and Pyth, binds to loopback and writes the review marker that blocks `run` and `collect`. Local V1 backup is not supported for chunked restored journals; use `backup-stream` below. Before operating a restored node, test its subsequent backup path and arrange offsite custody; retaining the original archive does not protect new observations. Restoration is not authorization to remove the review marker.

## Back up a recovered local node

Run this from the verified code checkout, not from the recovery directory (Bun can automatically load a working-directory `.env`). Use the recovered node's **current** ID, not its predecessor's ID. Independently verify the full SHA of the local build and supply an operator-group label; neither value grants admission to the oracle network.

```sh
bun src/cli.ts backup-stream --dir /absolute/path/to/recovered-node \
  --operator-group YOUR_OPERATOR_GROUP \
  --expected-node-id CURRENT_LOCAL_NODE_ID --expected-release VERIFIED_LOCAL_BUILD_SHA \
  --key-file /absolute/private/path/recovery.key \
  --output /absolute/private/path/local-v2.sbx-backup
bun src/cli.ts backup-stream-inspect \
  --expected-node-id CURRENT_LOCAL_NODE_ID --expected-release VERIFIED_LOCAL_BUILD_SHA \
  --key-file /absolute/private/path/recovery.key \
  --input /absolute/private/path/local-v2.sbx-backup
```

This path currently accepts the chunked representation produced by `restore-stream`. Ordinary unconverted self-hosted journals retain their V1 commands and limits; `backup-stream` rejects them rather than silently converting storage. Upgrade the reader before using local V2 archives: older V2 readers accept hosted descriptors only. Existing hosted archives and V1 archives remain readable with the new tools.

The local source opens read-only. SQLite `VACUUM INTO` creates a consistent private copy including committed WAL pages; normal collection may continue. Checkpoint setup, configuration additions and metadata conversion occur only on that copy. No signing counter is allocated. Keep identity and configuration files unchanged during the operation: before/after comparisons detect changes to parsed settings, but this is not an atomic snapshot across database and filesystem or proof of the running process's in-memory configuration. The local build SHA is a signed **operator assertion**, not independently verified build or deployment attestation.

The exporter checks the private copy before encryption, then independently imports and verifies the actual encrypted output. Only a successful return with `contentInspection: VERIFIED` is acceptance. It does not remove the recovery review marker, configure collectors or enable publication.

Prior descriptor, seal, ciphertext digest and byte count become a hash-addressed configuration record linked by the new signed descriptor. All older records remain in the archive; references do not nest whole archives. Inspection verifies receipt signatures, hashes and ancestry (maximum 1,024 records, 256 generations, 48 KiB per receipt). `ciphertextVerification: NOT_PERFORMED` means prior ciphertext was not supplied or recomputed; retain those original archives and keys separately for independent custody verification. Receipts alone do not prove row-by-row equivalence with earlier archives. The current archive is fully authenticated and its retained journal is inspected.

## Resource limits and failure behavior

| Boundary | Limit |
| --- | ---: |
| Decoded fragment bytes per block | 256 KiB |
| Serialized transport frame | 512 KiB |
| One canonical record | 2 MiB |
| Frozen mutable SQL cells | 18 MiB |
| Checkpoint block metadata | 65,536 blocks; 32 MiB accounting budget |
| Default local encrypted-file budget | 20 GiB |
| Default local database budget | 20 GiB |
| Local free-space reserve | 64 MiB |
| Default inspection record budget | 5,000,000 |
| Snapshot reproduction working set | 1,000 inputs; 32 MiB input bytes; 50,000 observations |

Local tools accept `--max-archive-bytes` to impose a smaller file budget. Library callers can configure documented inspection/work budgets. These are explicit failure limits, not promises that the account can retain that much data. Cloudflare's account-specific storage, request CPU and isolate-memory limits also apply. Existing trusted-report, candidate and proof limits are unchanged. A 31-day, three-operator fixture does not establish capacity at the maximum admitted-operator count.

The 500,000-row trusted-report cap is a separate retention constraint. At one accepted report per operator per five-minute cycle, 8,929 cycles require 26,787 rows for three operators, 35,716 for four and 446,450 for fifty. Fifty-six operators require 500,024 rows and exceed the cap before that fixture ends. These are arithmetic workload bounds, not throughput measurements; existing history consumes part of the same allowance. Do not admit a larger operating set without a reviewed retention/sharding plan that preserves snapshot references and replay protection.

Local exporter/inspection RSS and Cloudflare isolate memory are different measurements. The local tool has an explicit capacity-test budget; its peak must not be presented as compliance with the Worker isolate ceiling. Check the actual-runtime bounded-request test separately. The repository does not establish this account's paid/free storage allowance or reserve it from other applications.

Bounded RAM does not mean small disk requirements. The initial three-operator 31-day fixture produced an approximately 817 MB database and 1.2 GB encrypted archive. Inspection materializes another private database; restore temporarily needs both that database and the destination copy. Allow several gigabytes of local free space. The 64 MiB reserve is a per-write failure threshold, not an upfront estimate of the entire operation.

Normal completion, verification failure and graceful cancellation clean owned private materialization directories. The initial local SQLite copy is synchronous: a JavaScript abort or signal is processed after that copy returns. Disk capacity is checked before and after the copy, not continuously during SQLite's operation; reserve room for the source copy, checkpoint staging, encrypted archive and inspection database. A host crash or forced process termination can leave protected scratch files; use encrypted disks and inspect only exact owned paths. A failed restore may leave its new, disabled destination and review marker for operator review. Neither existing destinations nor completed archives are overwritten.

Offsite storage, separate key custody, retention, paging, account limits, a host-loss exercise and the restored node's ongoing backup program remain operational requirements. This release does not satisfy source rights, independent-operator quorum, approved weights, Pyth admission or genuine thirty-day market validation.
