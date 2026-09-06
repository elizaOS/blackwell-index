# Pyth publishing-state recovery

Pyth publishing state is separate from collector signing identity. A new collector identity does not make it safe to reuse an old Pyth publisher key. Every restore remains disabled and requires operator review.

## Preserved state

- Every publisher/network hash and feed's last attempted and last locally queued source timestamp, including unconfirmed attempts.
- Retained local queue receipts, with their original request IDs, timestamp units and serialized feed lists. The runtime retains at most 1,000 receipts; pruning a receipt does not remove its high-water mark.
- Source process locks as audit information in V2 archives. Restored runtime locks are empty in both V1 and V2.

These are operational records, not proof of upstream publication, publisher attribution or an onchain transaction. Legacy receipt hashes describe the original Pyth request's snapshot serialization; they must not be equated with the journal's canonical history hashes.

## Backup formats

Ordinary self-hosted journals retain the bounded V1 backup path. Its authenticated SQLite image is inspected for exact reviewed Pyth table definitions and valid state. Restore clears process locks only on the private staged copy, preserving submission state and receipt values.

Recovered chunked journals use `backup-stream`. On a read-only, committed-WAL-consistent private copy, the exporter encodes each validated runtime row as a hash-addressed configuration record. The signed descriptor's optional `pythStateHash` binds a versioned ordered inventory of those records. Runtime tables are removed only from this private export copy, never from the source journal. The importer verifies the inventory and recreates tables using application-owned SQL, not archive-supplied SQL.

V2 validates every linked recovery generation at its own signed time and compares each inventory with its signed parent. Previously retained publisher/feed namespaces and attempted/queued high-water marks cannot disappear or move backward, including through an intermediate generation. Receipts may be pruned and process leases may be cleared. This check does not prove that no newer source attempts happened after the backup.

Upgrade exporters and readers together before backing up an enabled publisher. Older strict V2 readers reject descriptors containing `pythStateHash`; do not remove that field to make an archive appear compatible. Existing archives without Pyth state remain readable.

## Validation and limits

Both paths reject partial or unreviewed schemas, triggers, extra constraints, invalid types, oversized rows, unsafe integers, invalid feed IDs, inconsistent retained acknowledgements, queued timestamps exceeding attempted timestamps, and implausible clock values. Source timestamps are microseconds; receipt and process times are milliseconds.

The runtime and recovery implementation support up to 512 feeds per publication, 8,192 retained publisher/feed high-water rows, 1,000 receipts and 512 process locks. Individual state rows are bounded at 64 KiB; the V2 root inventory at 800 KiB. Exceeding a limit requires an explicit archival/migration review, not deletion of replay-protection state.

## Activation requirements

1. Keep the previous publisher stopped or revoke it through the approved Pyth process.
2. Reconcile attempts made after the backup and obtain authoritative current high-water information before considering reuse of that publisher key. An old backup is not a current-state attestation.
3. Reapprove the separate collector identity, source rights, registry, methodology and Pyth publisher/feed bindings.
4. Test another backup and restore, establish separate offsite custody, and retain the original archive.
5. Remove the recovery marker only after documented review. No signer key, provider credential or publishing manifest is restored automatically.

The isolated tests use computed four-model fixtures and injected catalog/agent responses. They do not establish real Pyth admission or live publication. See [launch requirements](LAUNCH_TODO.md) and [streaming recovery](STREAMING_RECOVERY.md) for the remaining operational acceptance gates.
