# Streaming recovery implementation plan

Status: hosted release implemented, deployed and verified for the documented three-operator 31-day workload and maximum-candidate runtime fixture. Both live journals passed encrypted inspection and restore. Local re-backup is implemented through `backup-stream`; verify its exact revision before use. The capacity harness now also checks local re-backup and a second restore in separate memory-measured processes. Account-specific capacity, maximum-operator retention and offsite operating requirements remain open. See [operator instructions](STREAMING_RECOVERY.md) and the exact [acceptance record](HOSTED_ACCEPTANCE_2026-09-06.md). This plan does not change publication eligibility or authorize a paid service.

## Decision

Create an immutable, resumable checkpoint inside the existing Durable Object, then export bounded blocks through the private native Fetcher service binding. Encrypt blocks locally as they arrive. Restore into a private, disabled node with a new identity, using a chunk-aware journal and streaming verification.

Do not increase the current 8 MiB export, 64 MiB database, or 128 MiB encrypted JSON limits. Those protect implementations that buffer entire objects. Do not delete observations, evidence, counters or proofs to meet a limit. Do not page live mutable tables and call the result a snapshot.

The first complete implementation must pass a 31-day capacity drill, including encrypted export, independent inspection, restore, historical reproduction and coverage analysis. A successful block download alone is not completion.

## Original V1 constraints

The V1 exporter serializes all rows into one signed object. Its helper buffers that object. Its importer then embeds the complete signed object in the restored database, and `recovery.ts` reads, base64-encodes, encrypts and serializes a complete SQLite copy. These historical design constraints explain the separate V2 implementation; they do not describe the current streaming path.

Current journal mutations are:

| Data | Current behavior | Checkpoint treatment |
| --- | --- | --- |
| `counters` | Incremented in place | Copy values at the checkpoint boundary |
| `candidates` | Replaced by higher sequences; deleted on admission | Copy rows at the same boundary |
| `collector_schedules` | Updated around requests and backoff | Copy rows at the same boundary |
| `equivocations` | First exclusion is inserted and retained, even if full proof storage fails | Include immutable rows at the boundary; preserve proof-unavailable exclusions |
| `equivocation_proofs`, `reports` | Insert-only | Export immutable rows selected by an explicit append-sequence cutoff |
| `evidence`, `evidence_chunks`, `evidence_sizes` | Insert-only; each evidence object is committed atomically | Include the complete object or none of it |
| `captures`, `collection_captures` | Insert-only; batches and their cycle marker commit together | Include the complete cycle or none of it |
| `snapshots`, `configurations` | Insert-only | Export immutable rows at the same cutoff |
| Runtime identity KV, credentials, Pyth state | Not recovery data | Never read or export |

These properties come from `src/journal.ts`, `src/cloudflare/sql.ts`, `src/collection-control.ts` and `src/cloudflare/collect.ts`. They must become tested storage invariants, not assumptions about every future implementation.

Cloudflare explicitly states that SQL cursors held across an `await` have no stable snapshot guarantee. A synchronous transaction may contain SQL operations, but cannot remain open while network transfer proceeds. The implementation must finish each cursor before yielding. [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## Checkpoint schema

Use an explicit schema version and exact table/column allowlists. The names below are a proposed implementation contract, not existing tables.

- `archive_entries`: permanent append membership with `sequence INTEGER PRIMARY KEY AUTOINCREMENT`, a fixed integer table code, and typed record-key columns. Use non-null key fields and a uniqueness constraint covering table code and the full key. This avoids SQLite's multiple-NULL uniqueness behavior. The sequence is an archive position, never a signing counter.
- `archive_checkpoints`: checkpoint ID, source identity, source release, format version, creation/expiry times, immutable cutoff, current configuration hashes, per-table expected counts, state and signed descriptor.
- `archive_frozen_counters`, `archive_frozen_candidates`, `archive_frozen_schedules`: exact copies of those mutable rows, keyed by checkpoint ID plus their original primary key. Do not serialize the candidate set into one SQL row.
- `archive_blocks`: checkpoint ID, block number, start/end record cursors, byte count, previous hash and block hash. Retain deterministic block metadata, not another complete copy of historical payloads.

Do not use timestamps as membership boundaries: peer receipt times, clock changes and duplicate timestamps do not define a consistent database cut. Do not use implicit SQLite `rowid` as a permanent archive identity; use an explicit integer primary key in the membership ledger.

### Bootstrap and mutation rules

1. Add membership for existing immutable records with native SQL `INSERT ... SELECT` in a versioned migration. This copies keys, not raw evidence or entire histories into JavaScript. Check one-to-one membership and exact key joins before enabling the new export format.
2. Register every new immutable row in the same transaction as that row. Evidence parts and capture batches must retain their existing all-or-nothing transaction boundaries. Duplicate insertions must not create a second membership entry.
3. Cover all mutation paths, including configuration insertion during construction and quarantine insertion that intentionally survives proof-capacity failure. A missing ledger entry must stop checkpoint creation; it must not silently omit data.
4. Make immutable-row replacement/deletion an explicit error while this protocol is supported. The implementation may use reviewed application write helpers or database enforcement validated in workerd; do not assume undocumented trigger support. Future compaction needs a separate archival protocol and cannot silently change these rules.
5. Preserve all original record keys, signing counters and snapshot hashes during migration. Archive metadata is private operational state and must not be exposed by existing public APIs.

Bootstrap is an O(record-count) database operation, not O(total-payload) JavaScript work. Measure its CPU time, storage overhead and atomic rollback on a representative 31-day database before production migration. If that operation exceeds the account's limits, implement a versioned bootstrap with transactional dual registration of new writes and an explicit completeness barrier; do not ship a partially populated ledger as complete.

## Protocol

All operations use the existing authenticated private named service binding and native `fetch()`. Public hosts and their `/node/...` prefixes must deny every archive path. Checkpoint IDs identify resources; they are not a substitute for Cloudflare account authority.

### 1. Begin

In one synchronous transaction:

- Require no collection cycle in progress and validate the application schema and archive membership version.
- Read the immutable ledger cutoff and current configuration references.
- Copy all three mutable tables using native SQL. Candidates are currently bounded to 512 identities and 16 MiB total; copy them without building a JavaScript array of all payloads.
- Record expected counts for every logical table and the snapshot-chain head. Validate that the current configurations are present at the captured cutoff.
- Persist a descriptor with a random checkpoint ID, source identity/release, format version, cutoff, counts, creation time and expiry. Sign its bounded digest using an export-specific domain, without calling `nextSequence()`.

Commit all of this or none of it. An archive checkpoint must not pause collection for the duration of a transfer. After the begin transaction, new collections, admissions, counter increments and exclusions may continue normally; they do not change the checkpoint.

Initially allow one active checkpoint per node, with an explicit bounded staging-storage budget and expiry. A second begin fails clearly rather than duplicating an attacker-influenced candidate set. A checkpoint contains copied mutable state, not all historical data.

### 2. Read bounded blocks

Use a fixed table order and explicit keyset cursors. Immutable reads join through `archive_entries` with `sequence <= checkpoint.cutoff`; mutable reads use only the checkpoint's frozen tables. Never use offset pagination against changing tables.

Start with a 256 KiB maximum raw block payload and a separately bounded transport envelope. A single row may span multiple blocks: current capture rows and evidence chunks can exceed 256 KiB, and configuration rows can approach 1 MiB. The record-fragment format must include table code, exact record key, fragment offset and total encoded record length. Limit individual encoded records independently from total archive size.

Each request fully reads and serializes only its bounded working set before returning. Worker memory is O(one bounded record plus one block), not O(history), O(all candidates) or O(all block hashes). Every row is validated against the table's exact types before it is emitted.

Hash each block over a domain-separated encoding of the descriptor hash, checkpoint ID, block number, previous block hash, cursor boundaries and exact payload bytes. Persist the resulting block metadata and next cursor transactionally. Do not trust a client-provided previous hash as authoritative.

A retry for an already produced block must regenerate byte-identical content from its saved boundaries and verify the saved hash. Concurrent requests for the next block must serialize through durable checkpoint state. A failed or interrupted request must either leave no advancement, or leave a committed block that can be retrieved again. Do not depend on an in-memory cursor or hash object surviving an eviction.

### 3. Seal

After every expected row and fragment has been emitted, sign a terminal manifest containing the descriptor hash, final block hash, block count, total bytes and exact per-table record counts. Persist it before returning it. A terminal manifest must not exist for a truncated or incomplete traversal.

The local client verifies the pinned identity and release, descriptor signature, block order/hash chain and terminal signature. A partial stream is never a successful backup, even if every received block passed its own checks. Cross-check the manifest counts and snapshot head during import.

For the initial version, fail clearly if the source identity, deployment release or serialization schema changes during an unfinished checkpoint. Eviction and restart on the same release must work. Cross-release checkpoint continuation requires a separately tested compatibility rule.

### 4. Expiry and cleanup

Expiry or explicit operator completion may remove only the selected checkpoint's staging rows and block metadata. It must never delete original evidence, reports, captures, configurations, proofs, counters or the permanent membership ledger. Keep a compact terminal audit record if required by the chosen retention policy.

An expired checkpoint cannot be resumed or mixed with a replacement. The client starts a new checkpoint and new encrypted output. Checkpoint expiry is not proof that an offsite copy exists.

## Local streaming archive

Introduce a new versioned framed recovery container. Keep the existing V1 reader and its existing size limits for compatibility; do not route the new format back through the old whole-database JSON envelope.

- Generate a fresh random salt for each new archive and derive a per-archive encryption key from the protected recovery key using a reviewed HKDF construction. Use standard AES-256-GCM from the runtime, not a new cipher.
- Encrypt and authenticate bounded frames as they arrive. Bind the container version, header hash, frame type and monotonic frame number through associated data. Define a unique nonce per frame under that archive key and reject overflow or duplicate sequence numbers.
- Authenticate the terminal frame as well as all data frames. The source's signed descriptor and terminal manifest remain inside the encrypted artifact. Missing, reordered, substituted or trailing frames must fail inspection.
- Write only encrypted bytes to the download artifact. Use a new private output file, bounded buffers and backpressure. Mark it complete only after the source seal and local authentication pass and the file is durably flushed. Use an atomic no-overwrite completion operation appropriate to the host.
- In the first version, interrupted local encryption restarts into a new output with a fresh salt. Network retries within the process may reuse the immutable checkpoint. Do not introduce persistent encryption resume until nonce reuse and partial-frame recovery have independent tests and review.
- Do not print raw payloads or persist a plaintext export while downloading. Graceful interruption closes connections and leaves an explicitly incomplete encrypted artifact; documented crash recovery must never mistake it for a complete backup.

The transport and container remain bounded per block while total archive size becomes a disk/capacity policy. Set explicit configurable total-byte and disk-space budgets, but do not tie them to the old 64/128 MiB buffering thresholds. A disk-full failure must preserve the source and fail before declaring success.

## Restore and verification changes

The new archive should preserve the hosted chunked journal representation. Generalize the portable chunk-aware journal implementation for a local SQLite driver instead of concatenating all evidence parts or merging an entire collection cycle into one large row. Record the local journal storage version explicitly and make the CLI select the correct reader.

This is necessary end-to-end work, not an optional optimization:

- Stream authenticated frames into a new private staging database using allowlisted parameterized statements. Never execute SQL received from an archive. Apply aggregate row/byte/disk budgets and per-record limits before allocation.
- Verify evidence hashes incrementally over ordered chunks. Reject orphan parts, gaps, overlaps, wrong lengths and mismatched evidence metadata. Do not require one buffer containing the complete evidence corpus.
- Preserve physical capture batches plus exact collection markers. Check observation schemas, evidence references and complete cycle membership without accumulating all cycles in memory. Treat batches as storage units, not extra collection cycles.
- Run SQLite integrity checks, report signature/routing checks, counter highwater checks, quarantine/proof linkage checks, configuration digest checks and every historical snapshot reproduction. Preserve exclusions whose full proof is unavailable and keep their review requirement.
- Make verification cost depend on bounded records or one bounded snapshot's input set, rather than all history. Add explicit per-snapshot budgets and test the supported operator configuration. Do not skip historical verification because the archive is larger.
- Keep the signed container as the original export evidence. Store its descriptor, terminal manifest and digest/provenance reference in the local journal; do not embed a second copy of the entire archive into SQLite as one evidence record.
- After complete verification, create a new signing identity, disabled collectors/peers/publication settings and the existing review marker. Never import the old signing key or enable an old signer from a historical counter.
- Update `backup-inspect`, restore, reproduction and study code for the chunk-aware representation. The current study has a hard 100,000-observation ceiling; 31 days at the current 64 observations per five-minute cycle already exceeds it. Add a streaming summary/point-output mode, not a larger in-memory points array. A bounded partial study must remain explicitly incomplete.

Keep plaintext staging directories private, support graceful cancellation between bounded operations and document that SIGKILL or host loss may leave protected staging data. Encrypted local storage and explicit operator cleanup remain necessary.

## Capacity and operating limits

The release operator reported a 6,600,693-byte signed export at 89 cycles. That is one sample, not an established daily growth rate. Measure at least two exact checkpoints and separate fixed evidence, changing evidence, capture, report, proof and index overhead. Do not extrapolate a deadline from one average.

At five-minute intervals, a 31-day fixture requires at least 8,929 cycle markers to span 31 complete days, and 571,456 observations at 64 per cycle. This is a synthetic capacity workload only; it must not appear as production market history. Also test frequent changing evidence rather than assuming that content-addressed deduplication makes storage growth negligible.

Cloudflare's documented Worker memory limit is 128 MB per isolate, including concurrent requests; bounded per-request code still needs a concurrency limit. The platform recommends streaming instead of whole-body buffering. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

Durable Object SQL rows are limited to 2 MB and SQL queries to 100 bound parameters. The platform documents CPU and per-object storage ceilings. Its limits page currently lists a general 10 GB object ceiling but separately describes a 1 GB Free-plan full condition; confirm the actual account-specific limit before promising retention. Reserve space for live writes, the membership ledger and one frozen candidate set. Do not infer unlimited retention from successful exports. [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

Neither the current 500,000 trusted-report limit nor the candidate/proof limits should be increased as part of this work. At sufficient admitted-operator counts, trusted reports can reach their existing cap inside the intended retention period. Capacity acceptance must specify operator count and report frequency. A future archive/sharding policy must preserve historical references and replay protection before any source-data removal is considered.

No new R2 account is required for an operator to download an encrypted file through the existing service binding. Durable offsite storage, separate key custody, retention, alerts and recovery objectives still need an owner and, where applicable, an approved account/budget. Streaming export does not satisfy those dependencies by itself.

## Implementation phases and gates

1. **Storage invariants and checkpoint creation.** Add versioned membership bootstrap, transactional registration, mutable-row copies and signed bounded descriptors. Test full rollback and live-write independence in Bun and workerd before migration.
2. **Bounded block protocol.** Implement deterministic fragments, durable cursors, retry-safe blocks, hash chaining and sealing behind the private Fetcher binding. Keep collection running after checkpoint begin. Prove public denial paths remain closed.
3. **Streaming encrypted download.** Add the V2 container writer and independent reader, key/nonce separation, terminal authentication, disk budgets and failure-safe completion. Keep V1 compatible.
4. **Chunk-aware local recovery.** Restore and verify without the old complete-database buffers or duplicate full-export evidence. Preserve new-identity/review controls and all existing cryptographic/history checks.
5. **31-day acceptance and operation.** Run the complete capacity matrix, measure CPU/storage/memory and collection impact, then perform a real private checkpoint/download/restore drill on both deployed nodes. Publish only counts and hashes, not raw supplier data. Record offsite ownership and account requirements separately.

Do not deploy an exporter-only change that merely moves the failure to the local 64 MiB recovery cap. Phases 1–4 form the minimum functional release; phase 5 is its acceptance gate.

## Original implementation decisions

The released code records the membership, framing and storage choices below. Account-specific allowances and offsite ownership remain unresolved operating requirements.

- Confirm the account's storage/CPU limits and the measured 31-day capacity target, including admitted-operator count, changing evidence and reserved live-write headroom.
- Select and test the transactional membership mechanism and legacy bootstrap. Database-trigger support is not assumed; application-level registration must cover every listed write path.
- Finalize the byte-level frame encoding, record-fragment ceiling, checkpoint expiry and serialization compatibility policy. Have the encryption framing and nonce construction reviewed independently before treating V2 artifacts as recoverable.
- Define the local chunk-aware storage-version migration and compatibility behavior. Existing V1 encrypted files remain readable; introducing private archive tables must not silently weaken the old exporter's schema checks or imply that its 8 MiB path now supports the new journal.
- Assign an offsite destination, key custodian, retention/recovery objectives and alert owner. No account creation or paid-plan change is implied by this document.

## Required tests

- Begin a checkpoint, then overwrite a candidate, admit another candidate, increment counters, insert an exclusion/proof and complete a new collection. The old export must equal the pre-mutation logical state; a new checkpoint must include the changes.
- Include all chunks of an evidence object and all batches of a cycle, or none. Test collection-in-progress rejection, partial collection failure and proof-capacity failure retaining an exclusion.
- Exercise duplicate insertion, missing membership, wrong keys, schema additions, old/new configuration changes and attempted immutable-row modification. No silent omission or signing-counter change is allowed.
- Repeat the same block after a lost response; request blocks concurrently; restart the object between blocks; fail after durable advancement but before delivery. Require identical retries and exactly one logical progression.
- Reject mixed checkpoint/source/release blocks, altered payloads, wrong cursor boundaries, gaps, duplicates, reordering, bad terminal counts, missing seal, expired checkpoint and unsigned/trailing data.
- Exercise multi-block rows, exact size boundaries, oversized declared lengths, invalid UTF-8/JSON/base64, candidate capacity, quarantine without proof and the maximum supported report/proof sizes.
- Corrupt every container field class, nonce/tag, block and final frame. Test wrong key, truncated file, partial last write, existing output, symlink inputs, disk-full and graceful interruption. Inspection must never accept an incomplete artifact.
- Prove the V2 path handles databases above 64 MiB and archives above 128 MiB without relaxing V1 limits. Use the full 31-day cycle/observation fixture and a changing-evidence workload. Test configured worst-case admitted-operator volume and growth headroom separately.
- Measure heap/RSS and per-page CPU under concurrent collection and maximum candidate state. Enforce bounded active exports and verify collection latency does not grow with transfer duration.
- Verify all restored history, evidence, counters and quarantine links; independently reproduce every snapshot. A restored node must remain unable to collect, serve or publish until review, with a different signer from the source.
- Run the operating study over the entire restored period without crossing its old observation ceiling or treating storage batches as extra cycles. Report any incomplete scan or gap honestly.
- Deny archive paths on every public domain and `/node/primary`/`/node/secondary` prefix, including method/path/encoding variants. Private binding tests must not create a public administration route.
- Compare source identity, counter highwater and checkpoint history before and after the live drill. Distinguish normal concurrent increments from export-induced mutations. Two hosted nodes still count as one operator group.

## Acceptance boundary

This work is finished only when a complete, authenticated, bounded-memory 31-day export can be independently inspected and restored with all invariants intact. It will not establish supplier publication rights, Pyth acceptance, independent operators, index weights, historical market validity or offsite disaster recovery. Those remain separate launch gates.
