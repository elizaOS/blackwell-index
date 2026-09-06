# Self-hosted node recovery

This procedure creates an encrypted, transaction-consistent copy of a Bun SQLite node journal. It preserves retained observations, source responses, configurations, snapshots, signing counters and collection backoff state. It excludes the original private signing key, provider credential files and Pyth publication manifest. A restored node gets a new identity and remains disabled pending operator review.

For Cloudflare Durable Objects, first use the separate [private hosted export procedure](HOSTED_RECOVERY.md); it produces this same encrypted format. Neither procedure is an offsite backup service, key escrow service or completed production disaster-recovery program. It does not turn retained unapproved data into publishable data.

## Create and inspect a backup

Run these examples from the code checkout containing `src/cli.ts`. If the node data lives elsewhere, add `--dir /absolute/node/path`; relative key/bundle paths resolve inside that node directory. Setup alone does not create a journal: first initialize it with `status`, or use a node that has already collected. Use new filenames: existing keys and bundles are never overwritten.

```sh
bun src/cli.ts backup-keygen --output data/recovery.key
bun src/cli.ts backup --key-file data/recovery.key --output data/node.sbx-backup
bun src/cli.ts backup-inspect --key-file data/recovery.key --input data/node.sbx-backup
```

Store a separately protected copy of the recovery key outside the node host and backup destination. Losing that key makes the bundle unusable. Do not print it, put it in command arguments, commit it or place it next to an offsite bundle. The commands create private files and reject a recovery key readable by other users. Generated files under `data/`, `backups/` and `*.sbx-backup` are excluded from Git; access control is still required.

The bundle uses AES-256-GCM authenticated encryption with a fresh nonce. SQLite `VACUUM INTO` creates a consistent standalone copy including committed WAL contents. Collection can continue while the snapshot is made, subject to SQLite locking; an unsuccessful backup is not a valid checkpoint. A bundle has a 64 MiB database limit and a 128 MiB encoded archive limit. Larger journals need a separately reviewed streaming backup implementation; do not prune evidence or signing counters to bypass the limit.

Inspection verifies SQLite integrity, retained evidence/configuration hashes, signed report identity and sequence routing, snapshot-chain integrity, referenced inputs and exact historical calculation reproduction. It checks durable counters against retained signed records and authenticates retained equivocation proofs. A quarantine retained without its full proof remains excluded and explicitly requires review; inspection must not describe such a record as cryptographically verified.

These checks detect internal corruption and inconsistent records. They cannot prove that an upstream supplier returned a reported price, that an attacker did not replace an entire history before backup, or that this copy contains the latest sequence ever sent to peers. Keep independently recorded checkpoint hashes and reconcile external state.

## Restore into a new directory

```sh
bun src/cli.ts restore --key-file data/recovery.key \
  --input data/node.sbx-backup --target ./restored-node
bun src/cli.ts status --dir ./restored-node
bun src/cli.ts reproduce --dir ./restored-node --sequence 1
```

The target must not exist. Restore authenticates and verifies the bundle before creating it, generates a new collector identity, removes the old local identity from the current admission registry, and disables collectors, peers and Pyth publication. Historical registry records remain unchanged for reproducibility. The new server configuration binds to loopback.

The `reproduce` example requires a bundle containing snapshot 1 from a prior collection. An initialized but uncollected journal can be backed up, but it has no historical snapshot to reproduce.

`data/RECOVERY_REVIEW_REQUIRED.json` prevents both `run` and `collect`. Keep that marker until the responsible operator has:

1. Stopped or revoked the old signer and reconciled the last externally observed sequence. Never restore an old key and rewind its counter.
2. Reviewed snapshot reproduction, quarantine status, current source rights, retained private data and backup age against independent evidence.
3. Supplied current provider credentials and explicitly configured sources and peers.
4. Obtained any required admission for the new identity. A new key does not create a new independent operator.
5. Reviewed Pyth configuration separately; none is restored or enabled automatically.
6. Recorded approval, then removed the marker through a controlled local operation.

Deleting the marker alone is not approval. No CLI command bypasses this review. Keep the original database and backup until the recovered node is independently validated; the restore command never deletes them.

## Production work still required

- Assign backup frequency, retention, recovery-time and recovery-point objectives.
- Configure encrypted offsite storage, separate key custody and access/restore alerts.
- Record and verify independent checkpoint hashes and externally published high-water marks.
- Rehearse host loss, key loss, corrupted archives, provider credential replacement and operator revocation.
- Operate and periodically rehearse the [authenticated hosted export](HOSTED_RECOVERY.md), including its size limits. The local backup command alone does not access hosted objects.
